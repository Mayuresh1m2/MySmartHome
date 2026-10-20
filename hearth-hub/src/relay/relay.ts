import { readFileSync } from 'node:fs';
import mqtt, { type MqttClient } from 'mqtt';
import type { Logger } from '../obs/log.js';
import type { HubMetrics } from '../obs/metrics.js';
import { CommandGuard } from './guard.js';
import { parseCommand, type CommandV1, type ReplyV1 } from './schema.js';

export interface RelayOptions {
  host: string;
  port: number;
  protocolVersion: 4 | 5;
  clientId: string;
  commandsTopic: string;
  repliesTopic: string;
  keyPath: string;
  certPath: string;
  caPath: string;
  /** Backoff bounds for reconnects. */
  minBackoffMs?: number;
  maxBackoffMs?: number;
  keepaliveSec?: number;
}

export type DropReason = 'not_json' | 'wrong_version' | 'invalid' | 'stale' | 'future' | 'duplicate';

export interface RelayHandlers {
  /** Runs the pipeline for an accepted command; returns the reply to publish. */
  onCommand(cmd: CommandV1, receivedAt: number): Promise<ReplyV1>;
  /** Called for every command that is dropped before the pipeline. */
  onDropped?(info: { reason: DropReason; requestId?: string; detail?: string; receivedAt: number }): void;
}

export type RelayState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'stopped';

/** The hub's single outbound MQTT connection to IoT Core (or the local emulator). */
export class Relay {
  private client?: MqttClient;
  private attempt = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private _state: RelayState = 'idle';
  private _lastConnectedAt?: number;
  private _lastError?: string;
  readonly guard: CommandGuard;

  constructor(
    private readonly opts: RelayOptions,
    private readonly handlers: RelayHandlers,
    private readonly log: Logger,
    private readonly metrics: HubMetrics,
    guard?: CommandGuard,
  ) {
    this.guard = guard ?? new CommandGuard();
  }

  get status() {
    return {
      state: this._state,
      lastConnectedAt: this._lastConnectedAt ?? null,
      lastError: this._lastError ?? null,
      reconnectAttempt: this.attempt,
    };
  }

  start(): void {
    this.setState('connecting');
    const o = this.opts;
    this.client = mqtt.connect({
      protocol: 'mqtts',
      host: o.host,
      port: o.port,
      protocolVersion: o.protocolVersion,
      clientId: o.clientId,
      clean: true,
      keepalive: o.keepaliveSec ?? 30,
      connectTimeout: 10_000,
      // Reconnects are driven by scheduleReconnect() so they can back off.
      reconnectPeriod: 0,
      // TLS material is read from its paths straight into the TLS options and goes nowhere else.
      key: readFileSync(o.keyPath),
      cert: readFileSync(o.certPath),
      ca: readFileSync(o.caPath),
      servername: o.host,
      rejectUnauthorized: true,
    });

    this.client.on('connect', () => void this.onConnect());
    this.client.on('message', (topic, payload) => void this.onMessage(topic, payload));
    this.client.on('error', (err) => {
      this._lastError = err.message;
      this.log.warn({ stage: 'relay', err: err.message }, 'mqtt error');
    });
    this.client.on('close', () => {
      this.metrics.mqttConnected.set(0);
      if (this._state === 'stopped') return;
      this.log.warn({ stage: 'relay' }, 'mqtt connection closed');
      this.scheduleReconnect();
    });
  }

  async stop(): Promise<void> {
    this.setState('stopped');
    clearTimeout(this.reconnectTimer);
    await this.client?.endAsync(false);
  }

  private setState(s: RelayState): void {
    if (this._state === 'stopped' && s !== 'stopped') return;
    this._state = s;
  }

  private async onConnect(): Promise<void> {
    this.attempt = 0;
    this._lastConnectedAt = Date.now();
    this._lastError = undefined;
    try {
      // Clean session: subscriptions do not survive a reconnect, so subscribe on every connect.
      await this.client!.subscribeAsync(this.opts.commandsTopic, { qos: 1 });
      this.setState('connected');
      this.metrics.mqttConnected.set(1);
      this.log.info({ stage: 'relay', topic: this.opts.commandsTopic }, 'connected and subscribed');
    } catch (err) {
      // A refused subscription means the cloud policy and our config disagree. Retrying with backoff keeps
      // it visible in health/metrics without hammering the broker.
      this._lastError = `subscribe failed: ${(err as Error).message}`;
      this.log.error({ stage: 'relay', err: this._lastError }, 'subscribe refused; check hubId and IoT policy');
      this.client!.end(true);
    }
  }

  private scheduleReconnect(): void {
    clearTimeout(this.reconnectTimer);
    this.setState('reconnecting');
    const min = this.opts.minBackoffMs ?? 1000;
    const max = this.opts.maxBackoffMs ?? 60_000;
    const base = Math.min(max, min * 2 ** this.attempt);
    const delay = Math.round(base / 2 + Math.random() * (base / 2)); // "equal jitter"
    this.attempt += 1;
    this.metrics.reconnects.inc();
    this.log.info({ stage: 'relay', attempt: this.attempt, delayMs: delay }, 'reconnect scheduled');
    this.reconnectTimer = setTimeout(() => {
      if (this._state === 'stopped') return;
      this.setState('connecting');
      this.client?.reconnect();
    }, delay);
  }

  private async onMessage(topic: string, payload: Buffer): Promise<void> {
    if (topic !== this.opts.commandsTopic) return;
    const receivedAt = Date.now();
    const parsed = parseCommand(payload);
    if (!parsed.ok) {
      this.drop({ reason: parsed.reason, requestId: parsed.requestId, detail: parsed.detail, receivedAt });
      return;
    }
    const cmd = parsed.command;
    const verdict = this.guard.check(cmd);
    if (!verdict.accept) {
      this.drop({ reason: verdict.reason, requestId: cmd.requestId, detail: `age=${receivedAt - cmd.sentAt}ms`, receivedAt });
      return;
    }
    this.metrics.lastCommandAt.set(receivedAt);
    const reply = await this.handlers.onCommand(cmd, receivedAt);
    const t0 = Date.now();
    try {
      await this.client!.publishAsync(this.opts.repliesTopic, JSON.stringify(reply), { qos: 1 });
      this.metrics.stageMs.observe(Date.now() - t0, { stage: 'publish' });
    } catch (err) {
      this.log.error({ requestId: cmd.requestId, stage: 'publish', err: (err as Error).message }, 'reply publish failed');
    }
  }

  private drop(info: { reason: DropReason; requestId?: string; detail?: string; receivedAt: number }): void {
    this.metrics.commands.inc({ outcome: info.reason });
    this.log.warn({ stage: 'relay', requestId: info.requestId, reason: info.reason, detail: info.detail }, 'command dropped');
    this.handlers.onDropped?.(info);
  }
}
