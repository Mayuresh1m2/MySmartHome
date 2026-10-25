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
    if (/\b(disk|space|storage)\b/.test(text) && !/\b(delete|remove|clear|free up|format|wipe|erase|buy|order)\b/.test(text)) {
      return { kind: 'tool', tool: 'disk_space', args: {} };
    }
    // Vacuum status (read) — must come before the clean route, which also matches "vacuum".
    // "is the vacuum ok", "what's the vacuum doing", "why did the vacuum stop", "vacuum status".
    if (
      /\b(vacuum|hoover)\b/.test(text) &&
      /\b(status|doing|ok|okay|working|running|stuck|wrong|stop|stopped|finished|done|happening|why|how)\b/.test(text)
    ) {
      return { kind: 'tool', tool: 'vacuum_status', args: {} };
    }
    // Vacuum: "clean the house", "clean my house", "vacuum the house", "run the vacuum".
    if ((/\bclean\b/.test(text) && /\b(house|home|place|floors?)\b/.test(text)) || /\b(vacuum|hoover)\b/.test(text)) {
      return { kind: 'tool', tool: 'clean_house', args: {} };
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
