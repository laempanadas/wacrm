import { describe, expect, it } from 'vitest';
import { sortConversationsByActivity } from './sort-conversations';

type C = {
  id: string;
  last_message_at?: string | null;
  created_at: string;
};

describe('sortConversationsByActivity', () => {
  it('puts the most recent activity first, regardless of input order', () => {
    // A realtime INSERT is prepended; an UPDATE keeps its old slot. Both
    // must still end up ordered by last activity.
    const input: C[] = [
      { id: 'old-14min', last_message_at: '2026-11-14T10:00:00Z', created_at: '2026-11-01T00:00:00Z' },
      { id: 'fresh-1min', last_message_at: '2026-11-14T10:14:00Z', created_at: '2026-11-14T09:00:00Z' },
      { id: 'mid', last_message_at: '2026-11-14T10:05:00Z', created_at: '2026-11-02T00:00:00Z' },
    ];

    expect(sortConversationsByActivity(input).map((c) => c.id)).toEqual([
      'fresh-1min',
      'mid',
      'old-14min',
    ]);
  });

  it('falls back to created_at when last_message_at is null', () => {
    const input: C[] = [
      { id: 'no-msg-old', last_message_at: null, created_at: '2026-11-01T00:00:00Z' },
      { id: 'msg-recent', last_message_at: '2026-11-10T00:00:00Z', created_at: '2026-10-01T00:00:00Z' },
      { id: 'no-msg-new', last_message_at: null, created_at: '2026-11-12T00:00:00Z' },
    ];

    expect(sortConversationsByActivity(input).map((c) => c.id)).toEqual([
      'no-msg-new',
      'msg-recent',
      'no-msg-old',
    ]);
  });

  it('does not mutate the input array', () => {
    const input: C[] = [
      { id: 'a', last_message_at: '2026-01-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z' },
      { id: 'b', last_message_at: '2026-02-01T00:00:00Z', created_at: '2026-02-01T00:00:00Z' },
    ];
    sortConversationsByActivity(input);
    expect(input.map((c) => c.id)).toEqual(['a', 'b']);
  });
});
