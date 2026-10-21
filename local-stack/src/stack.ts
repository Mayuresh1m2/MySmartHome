import { CreateTableCommand, DynamoDBClient, PutItemCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { DynamoReplyStore } from '@hearth/skill/ports';
import { createSkill } from '@hearth/skill/core';
import dynalite from 'dynalite';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { LOCAL_SKILL_ID, commandEnvelope, speechOf } from './alexa.js';
import { startBroker } from './broker.js';
import { connectCloud, type CloudTransport } from './cloudClient.js';

export interface LocalStackOptions {
  hubId: string;
  stateDir: string;
  brokerPort?: number;
  ddbPort?: number;
  controlPort?: number;
  replyTimeoutMs?: number;
  /** Paths to the broker's TLS material; default: <stateDir>/ca. */
  caFile?: string;
  certFile?: string;
  keyFile?: string;
  log?: (event: Record<string, unknown>) => void;
  /** Use an external MQTT 5 broker (the Mosquitto IoT emulator) instead of the in-process aedes broker. */
  externalIot?: { port: number; caFile: string; certFile: string; keyFile: string };
}

export interface LocalStack {
  broker: CloudTransport;
  ports: { broker: number; ddb: number; control: number };
  /** What "Alexa, ask home hearth to <text>" would return. */
  say(text: string): Promise<{ speech: string; outcome: string; requestId: string | null; latencyMs: number }>;
  close(): Promise<void>;
}

export const TABLE = 'hearth-replies-local';

/**
 * The cloud half, emulated: IoT Core broker (mTLS + policy), the replies rule, DynamoDB (dynalite, in memory)
 * and the real skill handler from hearth-aws wired to them. A control endpoint on 127.0.0.1 plays the Echo.
 */
export async function startLocalStack(o: LocalStackOptions): Promise<LocalStack> {
  const userLog = o.log ?? (() => {});
  // The skill logs one "command relayed" line per request; keep it by Alexa request id so `say` can report it.
  const relays = new Map<string, { requestId: string; outcome: string; latencyMs: number }>();
  const log = (e: Record<string, unknown>) => {
    if (e.svc === 'local-skill' && e.msg === 'command relayed' && typeof e.alexaRequestId === 'string') {
      relays.set(e.alexaRequestId, { requestId: String(e.requestId), outcome: String(e.outcome), latencyMs: Number(e.latencyMs) });
    }
    userLog(e);
  };
  const ca = join(o.stateDir, 'ca');

  // DynamoDB
  const ddbServer: Server = dynalite({ createTableMs: 0 });
  await new Promise<void>((r) => ddbServer.listen(o.ddbPort ?? 0, '127.0.0.1', () => r()));
  const ddbPort = (ddbServer.address() as { port: number }).port;
  const ddb = new DynamoDBClient({ endpoint: `http://127.0.0.1:${ddbPort}`, region: 'ap-southeast-2', credentials: { accessKeyId: 'local', secretAccessKey: 'local' } });
  await ddb.send(
    new CreateTableCommand({
      TableName: TABLE,
      KeySchema: [{ AttributeName: 'requestId', KeyType: 'HASH' }],
      AttributeDefinitions: [{ AttributeName: 'requestId', AttributeType: 'S' }],
      BillingMode: 'PAY_PER_REQUEST',
    }),
  );

  // IoT Core: in-process aedes (MQTT 3.1.1), or the Mosquitto emulator (MQTT 5) reached as the "hearth-cloud" client.
  const broker: CloudTransport = o.externalIot
    ? await connectCloud({ ...o.externalIot, log: (e) => log({ svc: 'local-iot', ...e }) })
    : await startBroker({
        hubId: o.hubId,
        port: o.brokerPort ?? 0,
        caFile: o.caFile ?? join(ca, 'ca.crt'),
        certFile: o.certFile ?? join(ca, 'server.crt'),
        keyFile: o.keyFile ?? join(ca, 'server.key'),
        log: (e) => log({ svc: 'local-iot', ...e }),
      });

  // IoT rule: SELECT *, floor(timestamp() / 1000) + 300 AS expiresAt FROM 'hearth/<hubId>/replies' → DynamoDBv2 PutItem
  broker.onMessage(`hearth/${o.hubId}/replies`, (payload) => {
    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(payload.toString()) as Record<string, unknown>;
      if (typeof doc !== 'object' || doc === null || typeof doc.requestId !== 'string') throw new Error('no requestId');
    } catch (err) {
      log({ svc: 'local-rule', evt: 'rule_error', error: (err as Error).message, bytes: payload.length });
      return;
    }
    const item: Record<string, AttributeValue> = { expiresAt: { N: String(Math.floor(Date.now() / 1000) + 300) } };
    for (const [k, v] of Object.entries(doc)) item[k] = marshal(v);
    ddb
      .send(new PutItemCommand({ TableName: TABLE, Item: item }))
      .then(() => log({ svc: 'local-rule', evt: 'reply_stored', requestId: doc.requestId }))
      .catch((err: Error) => log({ svc: 'local-rule', evt: 'rule_error', requestId: doc.requestId, error: err.message }));
  });

  // Skill: the real hearth-aws handler; only the transports differ.
  const skill = createSkill({
    hubId: o.hubId,
    replyTimeoutMs: o.replyTimeoutMs ?? 3000,
    skillId: LOCAL_SKILL_ID,
    publisher: { publish: (topic, cmd) => broker.publish(topic, JSON.stringify(cmd)) },
    replies: new DynamoReplyStore(ddb, TABLE),
    log: {
      info: (f, msg) => log({ svc: 'local-skill', level: 'info', msg, ...f }),
      warn: (f, msg) => log({ svc: 'local-skill', level: 'warn', msg, ...f }),
      error: (f, msg) => log({ svc: 'local-skill', level: 'error', msg, ...f }),
    },
    emit: (line) => log({ svc: 'local-skill', evt: 'emf', ...JSON.parse(line) }),
  });

  const say = async (text: string) => {
    const t0 = Date.now();
    const envelope = commandEnvelope(text);
    const res = await skill.invoke(envelope);
    const relay = relays.get(envelope.request.requestId);
    relays.delete(envelope.request.requestId);
    // No relay line means the skill answered without contacting the hub (e.g. empty command).
    return { speech: speechOf(res), requestId: relay?.requestId ?? null, outcome: relay?.outcome ?? 'not_relayed', latencyMs: relay?.latencyMs ?? Date.now() - t0 };
  };

  // Control endpoint (127.0.0.1 only): POST /say {"text": "..."}; GET /status
  const control = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/status') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ hubId: o.hubId, iot: o.externalIot ? 'mosquitto-mqtt5' : 'aedes-mqtt311' }));
      return;
    }
    if (req.method === 'POST' && req.url === '/say') {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        const text = (() => {
          try {
            return String((JSON.parse(body) as { text?: unknown }).text ?? '');
          } catch {
            return '';
          }
        })();
        say(text).then(
          (r) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(r)),
          (err: Error) => res.writeHead(500).end(JSON.stringify({ error: err.message })),
        );
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => control.listen(o.controlPort ?? 0, '127.0.0.1', () => r()));
  const controlPort = (control.address() as { port: number }).port;
  log({ svc: 'local-stack', evt: 'ready', hubId: o.hubId, ports: { broker: broker.port, ddb: ddbPort, control: controlPort } });

  return {
    broker,
    ports: { broker: broker.port, ddb: ddbPort, control: controlPort },
    say,
    close: async () => {
      await new Promise((r) => control.close(r));
      await broker.close();
      await new Promise((r) => ddbServer.close(r));
      ddb.destroy();
    },
  };
}

function marshal(v: unknown): AttributeValue {
  if (typeof v === 'string') return { S: v };
  if (typeof v === 'number') return { N: String(v) };
  if (typeof v === 'boolean') return { BOOL: v };
  if (v === null) return { NULL: true };
  return { S: JSON.stringify(v) };
}
