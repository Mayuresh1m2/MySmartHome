import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { IoTDataPlaneClient } from '@aws-sdk/client-iot-data-plane';
import type { RequestEnvelope } from 'ask-sdk-model';
import { DynamoReplyStore, IotDataPublisher } from './ports.js';
import { createSkill } from './skill.js';

const env = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};

// Clients are created once per container and reused across invocations.
const skill = createSkill({
  hubId: env('HUB_ID'),
  replyTimeoutMs: Number(process.env.REPLY_TIMEOUT_MS ?? 3000),
  skillId: env('SKILL_ID'),
  debugUtterances: process.env.DEBUG_UTTERANCES === 'true',
  publisher: new IotDataPublisher(new IoTDataPlaneClient({ endpoint: `https://${env('IOT_ENDPOINT')}` })),
  replies: new DynamoReplyStore(new DynamoDBClient({}), env('REPLIES_TABLE')),
});

export const handler = (event: RequestEnvelope) => skill.invoke(event);
