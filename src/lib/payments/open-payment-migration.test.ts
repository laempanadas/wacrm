import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

let db: PGlite;
const account = '00000000-0000-0000-0000-000000000001';
const contact = '00000000-0000-0000-0000-000000000002';
const other = '00000000-0000-0000-0000-000000000003';
const fingerprint = 'a'.repeat(64);
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`CREATE TABLE orders (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid, contact_id uuid,
    external_reference text, status text, UNIQUE(account_id, external_reference));`);
  await db.exec(
    readFileSync('supabase/migrations/040_open_payment_identity.sql', 'utf8')
  );
}, 30000);
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  await db.exec('TRUNCATE orders');
});
function claim(
  reference: string,
  status: string | null = 'checkout_uncertain',
  owner = account,
  buyer = contact,
  hash: string | null = fingerprint
) {
  return db.query(
    `INSERT INTO orders (account_id,contact_id,external_reference,status,payment_fingerprint)
    VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [owner, buyer, reference, status, hash]
  );
}
describe('open payment claim on isolated PostgreSQL', () => {
  it('lets only one concurrent reference claim the same account/contact/cart', async () => {
    const result = await Promise.allSettled([claim('FIRST'), claim('SECOND')]);
    expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failure = result.find(
      (r) => r.status === 'rejected'
    ) as PromiseRejectedResult;
    expect(failure.reason.code).toBe('23505');
    expect((await db.query('SELECT * FROM orders')).rows).toHaveLength(1);
  });
  it.each(['checkout_uncertain', 'pending', 'in_process', 'rejected', null])(
    'retains the claim for ambiguous or still payable status %s',
    async (status) => {
      await claim('FIRST', status);
      await expect(claim('SECOND')).rejects.toMatchObject({ code: '23505' });
    }
  );
  it('releases only a paid cart for a new purchase, not its old reference', async () => {
    await claim('FIRST');
    await db.query(
      "UPDATE orders SET status='paid' WHERE external_reference='FIRST'"
    );
    await claim('SECOND');
    await expect(claim('FIRST')).rejects.toMatchObject({ code: '23505' });
    expect((await db.query('SELECT * FROM orders')).rows).toHaveLength(2);
  });
  it('scopes uniqueness to account/contact and the full fingerprint', async () => {
    await claim('FIRST');
    await claim('SECOND', 'pending', other);
    await claim('THIRD', 'pending', account, other);
    await claim('FOURTH', 'pending', account, contact, 'b'.repeat(64));
    expect((await db.query('SELECT * FROM orders')).rows).toHaveLength(4);
  });
  it('does not backfill or collapse ambiguous legacy rows', async () => {
    await claim('LEGACY-1', 'pending', account, contact, null);
    await claim('LEGACY-2', 'pending', account, contact, null);
    expect((await db.query('SELECT * FROM orders')).rows).toHaveLength(2);
  });
});
