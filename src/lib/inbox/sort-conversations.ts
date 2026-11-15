// ============================================================
// Inbox ordering: most recent activity first.
//
// The initial list is fetched ORDER BY last_message_at DESC, but realtime
// handlers patch rows in place (which keeps a stale position) and prepend
// new conversations. Every state update that touches the list must run
// through this so the order stays correct between refetches.
//
// Falls back to created_at when a conversation has no message yet. Ties
// break on id so the order is deterministic.
// ============================================================

export interface ActivitySortable {
  id: string;
  last_message_at?: string | null;
  created_at: string;
}

function activityKey(c: ActivitySortable): number {
  const raw = c.last_message_at ?? c.created_at;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? 0 : t;
}

export function sortConversationsByActivity<T extends ActivitySortable>(
  list: T[]
): T[] {
  return [...list].sort((a, b) => {
    const diff = activityKey(b) - activityKey(a);
    if (diff !== 0) return diff;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
}
