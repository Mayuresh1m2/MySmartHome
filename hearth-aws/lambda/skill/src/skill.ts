import { SkillBuilders, getIntentName, getRequestType, getSlotValue, type ErrorHandler, type RequestHandler } from 'ask-sdk-core';
import type { RequestEnvelope, ResponseEnvelope } from 'ask-sdk-model';
import { consoleLogger, emitMetrics, type Logger, type Outcome } from './obs.js';
import type { CommandPublisher, ReplyStore } from './ports.js';
import { relayCommand } from './relay.js';

export interface SkillDeps {
  hubId: string;
  replyTimeoutMs: number;
  /** When set, requests from any other skill are rejected (withSkillId). */
  skillId?: string;
  publisher: CommandPublisher;
  replies: ReplyStore;
  /** Log utterance text only when true (DEBUG_UTTERANCES). */
  debugUtterances?: boolean;
  log?: Logger;
  emit?: (line: string) => void;
  pollIntervalMs?: number;
}

export const SPEECH = {
  launch: 'Hearth is ready. What should I ask your home hub?',
  reprompt: 'Tell me what to ask your home hub, for example, how much space is left.',
  help: 'I pass what you say to your home hub and read back its answer. Try: ask ramesh dude how much space is left.',
  goodbye: 'Goodbye.',
  noCommand: "I didn't catch that. What should I ask your home hub?",
  timeout: "Your home hub didn't answer in time. It might be offline.",
  publishFailed: "I couldn't reach your home hub right now.",
  badReply: 'Your home hub sent a reply I could not read.',
  error: 'Sorry, something went wrong.',
} as const;

/** Hub speech is plain text; ask-sdk wraps it in SSML, so markup characters must be escaped (quotes are fine in text nodes). */
export function escapeSsml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
}

export function createSkill(deps: SkillDeps) {
  const log = deps.log ?? consoleLogger;

  const Launch: RequestHandler = {
    canHandle: (h) => getRequestType(h.requestEnvelope) === 'LaunchRequest',
    handle: (h) => h.responseBuilder.speak(SPEECH.launch).reprompt(SPEECH.reprompt).getResponse(),
  };

  const Command: RequestHandler = {
    canHandle: (h) => getRequestType(h.requestEnvelope) === 'IntentRequest' && getIntentName(h.requestEnvelope) === 'CommandIntent',
    async handle(h) {
      const text = (getSlotValue(h.requestEnvelope, 'command') ?? '').trim();
      const alexaRequestId = h.requestEnvelope.request.requestId;
      if (!text) return h.responseBuilder.speak(SPEECH.noCommand).reprompt(SPEECH.reprompt).getResponse();

      const r = await relayCommand(text, { hubId: deps.hubId, replyTimeoutMs: deps.replyTimeoutMs, pollIntervalMs: deps.pollIntervalMs }, deps.publisher, deps.replies);
      const speech = r.reply ? r.reply.speech : fallbackSpeech(r.outcome);
      log.info(
        {
          requestId: r.requestId,
          alexaRequestId,
          hubId: deps.hubId,
          outcome: r.outcome,
          latencyMs: r.latencyMs,
          ...(deps.debugUtterances ? { text } : { textLength: text.length }),
        },
        'command relayed',
      );
      emitMetrics(deps.hubId, r.outcome, r.latencyMs, deps.emit);
      return h.responseBuilder.speak(escapeSsml(speech)).withShouldEndSession(true).getResponse();
    },
  };

  const Help: RequestHandler = {
    canHandle: (h) => getRequestType(h.requestEnvelope) === 'IntentRequest' && getIntentName(h.requestEnvelope) === 'AMAZON.HelpIntent',
    handle: (h) => h.responseBuilder.speak(SPEECH.help).reprompt(SPEECH.reprompt).getResponse(),
  };

  const StopCancel: RequestHandler = {
    canHandle: (h) =>
      getRequestType(h.requestEnvelope) === 'IntentRequest' &&
      ['AMAZON.StopIntent', 'AMAZON.CancelIntent', 'AMAZON.NavigateHomeIntent'].includes(getIntentName(h.requestEnvelope)),
    handle: (h) => h.responseBuilder.speak(SPEECH.goodbye).withShouldEndSession(true).getResponse(),
  };

  const SessionEnded: RequestHandler = {
    canHandle: (h) => getRequestType(h.requestEnvelope) === 'SessionEndedRequest',
    handle(h) {
      const req = h.requestEnvelope.request as { reason?: string; error?: { type?: string } };
      log.info({ alexaRequestId: h.requestEnvelope.request.requestId, reason: req.reason, errorType: req.error?.type }, 'session ended');
      return h.responseBuilder.getResponse();
    },
  };

  const Errors: ErrorHandler = {
    canHandle: () => true,
    handle(h, err) {
      log.error({ alexaRequestId: h.requestEnvelope.request.requestId, err: err.message, type: getRequestType(h.requestEnvelope) }, 'unhandled');
      return h.responseBuilder.speak(SPEECH.error).withShouldEndSession(true).getResponse();
    },
  };

  const builder = SkillBuilders.custom().addRequestHandlers(Launch, Command, Help, StopCancel, SessionEnded).addErrorHandlers(Errors);
  if (deps.skillId) builder.withSkillId(deps.skillId);
  const skill = builder.create();
  return {
    invoke: (envelope: RequestEnvelope): Promise<ResponseEnvelope> => skill.invoke(envelope),
  };
}

function fallbackSpeech(outcome: Outcome): string {
  if (outcome === 'timeout') return SPEECH.timeout;
  if (outcome === 'publish_failed') return SPEECH.publishFailed;
  if (outcome === 'bad_reply') return SPEECH.badReply;
  return SPEECH.error;
}
