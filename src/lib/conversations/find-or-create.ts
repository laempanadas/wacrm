// ============================================================
// One conversation per (account, contact) — shared lookup + create.
//
// Every path that opens a thread for a contact (inbound webhook, the
// dashboard send route, the public API resolver) must use this helper.
//
// Why it looks like this:
// - `.maybeSingle()` / `.single()` return an error (not the row) when
//   more than one row matches. Treating that error as "not found" made
//   each later message insert yet another conversation. So we order by
//   `created_at` and take the oldest row instead.
// - Two concurrent first messages can both miss the lookup and both
//   insert. Migration 043 adds a unique index on (account_id,
//   contact_id); when that rejects the second insert (23505) we re-read
//   the winner instead of creating a duplicate.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { isUniqueViolation } from '@/lib/contacts/dedupe';

/** Row shape the callers read; other columns pass through untouched. */
export interface ContactConversation {
  id: string;
  status: string;
  unread_count: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

export interface FindOrCreateConversationResult {
  conversation: ContactConversation;
  /** True when this call inserted the row. */
  created: boolean;
}

/**
 * Returns the (oldest) conversation for the contact, creating it when
 * missing. Returns null on a lookup/insert failure (already logged) so
 * each caller can map it to its own error response.
 */
export async function findOrCreateConversationForContact(
  db: SupabaseClient,
  accountId: string,
  ownerUserId: string,
  contactId: string
): Promise<FindOrCreateConversationResult | null> {
  const findOldest = () =>
    db
      .from('conversations')
      .select('*')
      .eq('account_id', accountId)
      .eq('contact_id', contactId)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();

  const { data: existing, error: findError } = await findOldest();
  if (findError) {
    console.error('[conversations] find error:', findError);
    return null;
  }
  if (existing) {
    return {
      conversation: existing as ContactConversation,
      created: false,
    };
  }

  const { data: created, error: createError } = await db
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: ownerUserId,
      contact_id: contactId,
    })
    .select('*')
    .single();

  if (createError || !created) {
    if (isUniqueViolation(createError)) {
      const { data: raced } = await findOldest();
      if (raced) {
        return { conversation: raced as ContactConversation, created: false };
      }
    }
    console.error('[conversations] create error:', createError);
    return null;
  }

  return { conversation: created as ContactConversation, created: true };
}
