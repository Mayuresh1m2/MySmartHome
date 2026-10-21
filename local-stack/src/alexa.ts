import { randomUUID } from 'node:crypto';
import type { RequestEnvelope } from 'ask-sdk-model';

export const LOCAL_SKILL_ID = 'amzn1.ask.skill.local-stack';

/** Builds the request Alexa sends for "ask ramesh dude to <text>": CommandIntent with the command slot. */
export function commandEnvelope(text: string, locale = 'en-IN'): RequestEnvelope {
  const app = { applicationId: LOCAL_SKILL_ID };
  const user = { userId: 'amzn1.ask.account.local' };
  return {
    version: '1.0',
    session: { new: true, sessionId: `amzn1.echo-api.session.${randomUUID()}`, application: app, user },
    context: { System: { application: app, user, device: { deviceId: 'local', supportedInterfaces: {} }, apiEndpoint: 'http://127.0.0.1' } },
    request: {
      type: 'IntentRequest',
      requestId: `amzn1.echo-api.request.${randomUUID()}`,
      timestamp: new Date().toISOString(),
      locale,
      dialogState: 'COMPLETED',
      intent: { name: 'CommandIntent', confirmationStatus: 'NONE', slots: { command: { name: 'command', value: text, confirmationStatus: 'NONE' } } },
    },
  } as unknown as RequestEnvelope;
}

export function speechOf(r: { response?: { outputSpeech?: unknown } }): string {
  const ssml = (r.response?.outputSpeech as { ssml?: string } | undefined)?.ssml ?? '';
  return ssml.replace(/^<speak>|<\/speak>$/g, '');
}
