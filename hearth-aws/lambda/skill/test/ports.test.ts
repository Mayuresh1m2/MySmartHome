import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { IoTDataPlaneClient, PublishCommand } from '@aws-sdk/client-iot-data-plane';
import { mockClient } from 'aws-sdk-client-mock';
import { describe, expect, it } from 'vitest';
import { DynamoReplyStore, IotDataPublisher } from '../src/ports.js';

describe('IotDataPublisher', () => {
  it('publishes JSON at QoS 1 to the given topic', async () => {
    const iot = mockClient(IoTDataPlaneClient);
    iot.on(PublishCommand).resolves({});
    const cmd = { v: 1 as const, requestId: 'r', text: 'ping', sentAt: 1 };
    await new IotDataPublisher(new IoTDataPlaneClient({ region: 'eu-west-1' })).publish('hearth/laptop/commands', cmd);
    const input = iot.commandCalls(PublishCommand)[0]!.args[0].input;
    expect(input.topic).toBe('hearth/laptop/commands');
    expect(input.qos).toBe(1);
    expect(JSON.parse(new TextDecoder().decode(input.payload as Uint8Array))).toEqual(cmd);
  });
});

describe('DynamoReplyStore', () => {
  it('reads with ConsistentRead and unmarshals the item', async () => {
    const ddb = mockClient(DynamoDBClient);
    ddb.on(GetItemCommand).resolves({
      Item: { requestId: { S: 'r' }, v: { N: '1' }, speech: { S: 'hi' }, status: { S: 'ok' }, expiresAt: { N: '123' } },
    });
    const item = await new DynamoReplyStore(new DynamoDBClient({ region: 'eu-west-1' }), 'replies').get('r');
    expect(item).toEqual({ requestId: 'r', v: 1, speech: 'hi', status: 'ok', expiresAt: 123 });
    expect(ddb.commandCalls(GetItemCommand)[0]!.args[0].input).toMatchObject({ TableName: 'replies', ConsistentRead: true, Key: { requestId: { S: 'r' } } });
  });
  it('returns undefined when the reply is not there yet', async () => {
    mockClient(DynamoDBClient).on(GetItemCommand).resolves({});
    expect(await new DynamoReplyStore(new DynamoDBClient({ region: 'eu-west-1' }), 't').get('r')).toBeUndefined();
  });
});
