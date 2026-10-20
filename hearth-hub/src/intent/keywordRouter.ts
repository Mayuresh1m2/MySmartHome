import type { Decision, IntentEngine } from './types.js';

/** Temporary stand-in for the model (M2). Deliberately narrow: anything unmatched is refused. */
export class KeywordRouter implements IntentEngine {
  readonly name = 'keyword';

  async decide(raw: string): Promise<Decision> {
    const text = raw.toLowerCase().replace(/[?.!,]/g, ' ').replace(/\s+/g, ' ').trim();

    if (/^(ping|are you there|hub status|status)$/.test(text)) return { kind: 'tool', tool: 'ping', args: {} };
    if (/\b(what happened|last (result|command)|say that again)\b/.test(text)) {
      return { kind: 'tool', tool: 'last_result', args: {} };
    }
    if (/\b(disk|space|storage)\b/.test(text) && !/\b(delete|remove|clear|free up)\b/.test(text)) {
      return { kind: 'tool', tool: 'disk_space', args: {} };
    }
    const folder = text.match(/\b(?:list|what'?s in|what is in|show(?: me)?)\s+(?:my |the )?([a-z0-9_-]+)(?: folder)?\b/);
    if (folder?.[1] && !/\b(delete|remove)\b/.test(text)) {
      return { kind: 'tool', tool: 'list_folder', args: { folder: folder[1] } };
    }
    const device = text.match(/\bis (?:the |my )?([a-z0-9 -]+?) (?:online|up|reachable|connected|working)\b/);
    if (device?.[1]) return { kind: 'tool', tool: 'is_device_online', args: { device: device[1] } };

    return { kind: 'refuse', speech: "Sorry, I can't do that." };
  }
}
