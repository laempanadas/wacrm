/**
 * UUID validation utilities.
 * Prevents "invalid input syntax for type uuid" errors from Supabase.
 */

/**
 * Checks if a value is a valid UUID v4 format.
 * Rejects null, undefined, string "null"/"undefined", and incorrect lengths.
 */
export function isValidUuid(
  id: string | null | undefined
): id is string {
  if (typeof id !== 'string') return false
  if (id === 'null' || id === 'undefined') return false
  // UUID v4 is exactly 36 characters (32 hex + 4 hyphens)
  if (id.length !== 36) return false
  // Basic UUID v4 pattern: 8-4-4-4-12 hex digits
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  return uuidPattern.test(id)
}

/**
 * Safe guard for Supabase queries.
 * Use in conditions before calling .eq('account_id', accountId)
 *
 * @example
 * if (!isValidUuid(accountId)) return;
 * const { data } = await supabase.from('tags').select('*').eq('account_id', accountId);
 */
export function guardUuid(id: string | null | undefined): boolean {
  return isValidUuid(id)
}
