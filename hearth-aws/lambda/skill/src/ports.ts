import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { IoTDataPlaneClient, PublishCommand } from '@aws-sdk/client-iot-data-plane';

export interface CommandV1 {
  v: 1;
  requestId: string;
  text: string;
  sentAt: number;
}

export interface ReplyV1 {
  v: 1;
  requestId: string;
  speech: string;
  status: 'ok' | 'refused' | 'error';
}

/** Sends a command to hearth/<hubId>/commands. */
export interface CommandPublisher {
  publish(topic: string, command: CommandV1): Promise<void>;
}

/** Reads a reply the IoT rule wrote. Returns the raw item fields, or undefined if not there yet. */
export interface ReplyStore {
  get(requestId: string): Promise<Record<string, unknown> | undefined>;
}

export class IotDataPublisher implements CommandPublisher {
  constructor(private readonly client: IoTDataPlaneClient) {}
  async publish(topic: string, command: CommandV1): Promise<void> {
    await this.client.send(new PublishCommand({ topic, qos: 1, payload: new TextEncoder().encode(JSON.stringify(command)) }));
  }
}

export class DynamoReplyStore implements ReplyStore {
  constructor(
    private readonly client: DynamoDBClient,
    private readonly table: string,
  ) {}
  async get(requestId: string): Promise<Record<string, unknown> | undefined> {
    const out = await this.client.send(
      new GetItemCommand({ TableName: this.table, Key: { requestId: { S: requestId } }, ConsistentRead: true }),
    );
    if (!out.Item) return undefined;
    const item: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(out.Item)) item[k] = v.S ?? (v.N !== undefined ? Number(v.N) : v.BOOL);
    return item;
  }
}
