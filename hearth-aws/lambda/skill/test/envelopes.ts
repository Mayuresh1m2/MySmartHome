import type { RequestEnvelope } from 'ask-sdk-model';

export const SKILL_ID = 'amzn1.ask.skill.00000000-0000-0000-0000-000000000000';

function envelope(request: Record<string, unknown>, applicationId = SKILL_ID): RequestEnvelope {
  return {
    version: '1.0',
    session: {
      new: true,
      sessionId: 'amzn1.echo-api.session.test',
      application: { applicationId },
      user: { userId: 'amzn1.ask.account.test' },
    },
    context: {
      System: {
        application: { applicationId },
        user: { userId: 'amzn1.ask.account.test' },
        device: { deviceId: 'test-device', supportedInterfaces: {} },
        apiEndpoint: 'https://api.eu.amazonalexa.com',
      },
    },
    request: { requestId: `amzn1.echo-api.request.${Math.random().toString(36).slice(2)}`, timestamp: new Date().toISOString(), locale: 'en-IN', ...request },
  } as unknown as RequestEnvelope;
}

export const launch = (appId?: string) => envelope({ type: 'LaunchRequest' }, appId);
export const intent = (name: string, slots: Record<string, string | undefined> = {}, appId?: string) =>
  envelope(
    {
      type: 'IntentRequest',
      dialogState: 'COMPLETED',
      intent: {
        name,
        confirmationStatus: 'NONE',
        slots: Object.fromEntries(Object.entries(slots).map(([k, v]) => [k, { name: k, value: v, confirmationStatus: 'NONE' }])),
      },
    },
    appId,
  );
export const command = (text: string | undefined, appId?: string) => intent('CommandIntent', { command: text }, appId);
export const sessionEnded = () => envelope({ type: 'SessionEndedRequest', reason: 'USER_INITIATED' });

export const speechOf = (r: { response: { outputSpeech?: unknown } }) =>
  ((r.response.outputSpeech as { ssml?: string } | undefined)?.ssml ?? '').replace(/^<speak>|<\/speak>$/g, '');
