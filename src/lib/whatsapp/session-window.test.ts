import { describe, expect, it } from 'vitest';
import { sessionWindow } from './session-window';

const now = Date.parse('2026-10-18T12:00:00Z');
describe('WhatsApp customer service window', () => {
  it('requires a valid inbound timestamp, including empty history', () => {
    for (const value of [
      undefined,
      null,
      '',
      'invalid',
      '2026-10-19T12:00:00Z',
    ]) {
      expect(sessionWindow(value, now).expired).toBe(true);
    }
  });
  it('expires exactly at 24 hours and counts down without new messages', () => {
    const inbound = '2026-10-17T12:00:01Z';
    expect(sessionWindow(inbound, now)).toMatchObject({
      expired: false,
      remaining: '1m remaining',
    });
    expect(sessionWindow(inbound, now + 1000).expired).toBe(true);
  });
});
