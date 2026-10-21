import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('derives client id and topics from HUB_ID', () => {
    const c = loadConfig({ IOT_ENDPOINT: 'x.iot.ap-southeast-2.amazonaws.com', HUB_ID: 'kitchen-1' });
    expect(c.clientId).toBe('hearth-kitchen-1');
    expect(c.commandsTopic).toBe('hearth/kitchen-1/commands');
    expect(c.repliesTopic).toBe('hearth/kitchen-1/replies');
    expect(c.AWS_REGION).toBe('ap-southeast-2');
    expect(c.AUDIT_TEXT).toBe(true);
  });
  it('defaults hubId to laptop', () => {
    expect(loadConfig({ IOT_ENDPOINT: 'x' }).HUB_ID).toBe('laptop');
  });
  it('rejects an invalid hubId and a missing endpoint', () => {
    expect(() => loadConfig({ IOT_ENDPOINT: 'x', HUB_ID: 'Bad_ID' })).toThrow(/HUB_ID/);
    expect(() => loadConfig({})).toThrow(/IOT_ENDPOINT/);
  });
  it('parses AUDIT_TEXT=false', () => {
    expect(loadConfig({ IOT_ENDPOINT: 'x', AUDIT_TEXT: 'false' }).AUDIT_TEXT).toBe(false);
  });
});
