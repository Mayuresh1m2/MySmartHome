export type Decision =
  | { kind: 'tool'; tool: string; args: Record<string, unknown> }
  | { kind: 'refuse'; speech: string };

export interface IntentEngine {
  readonly name: string;
  decide(text: string): Promise<Decision>;
}
