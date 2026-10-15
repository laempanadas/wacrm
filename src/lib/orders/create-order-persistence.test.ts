import { describe, expect, it } from 'vitest';
import { createOrderDeal, createDealForOrder } from './create-order';
import {
  createOrderTestDatabase,
  createOrderTestContext as ctx,
  createOrderTestInput as input,
} from './create-order-db-test-helper';

describe('create-order canonical persistence', () => {
  it.each([NaN, Infinity, -1, 1.001, 0.0000001, 1.00000001, 10_000_000_000])(
    'rejects invalid total %s before DB effects',
    async (total) => {
      const db = createOrderTestDatabase();
      await expect(
        createOrderDeal(db.db, ctx, { ...input, total })
      ).rejects.toThrow('Invalid order total');
      expect(db.calls).toHaveLength(0);
    }
  );
  it('rejects a priced-line total mismatch before DB effects', async () => {
    const db = createOrderTestDatabase();
    await expect(
      createOrderDeal(db.db, ctx, {
        ...input,
        total: 70,
        items: [{ title: 'Carne', quantity: 2, unitPrice: 14 }],
      })
    ).rejects.toThrow('Order total does not match items');
    expect(db.calls).toHaveLength(0);
  });
  it.each([
    { title: 'Carne', quantity: 0, unitPrice: 14 },
    { title: 'Carne', quantity: 1.5, unitPrice: 14 },
    { title: 'Carne', quantity: 2, unitPrice: NaN },
    { title: 'Carne', quantity: 2, unitPrice: -14 },
    { title: 'Carne', quantity: 2, unitPrice: 14.001 },
  ])('rejects invalid structured line %j before effects', async (item) => {
    const db = createOrderTestDatabase();
    await expect(
      createOrderDeal(db.db, ctx, { ...input, items: [item] })
    ).rejects.toThrow('Invalid order item');
    expect(db.calls).toHaveLength(0);
  });
  it('keeps legacy unpriced lines and supplied total without guessed prices', async () => {
    const db = createOrderTestDatabase();
    const items = [{ name: 'Carne', quantity: 2, description: 'Sem cebola' }];
    await createOrderDeal(db.db, ctx, { ...input, items });
    expect(db.tables.orders[0]).toMatchObject({
      total: 28,
      total_amount: 28,
      items,
    });
    expect(db.tables.deals[0].notes).toContain('2x Carne — Sem cebola');
    expect(db.tables.deals[0].notes).not.toContain('Carne - R$');
  });

  it('accepts exact BRL cents despite binary float noise', async () => {
    const db = createOrderTestDatabase();
    await createOrderDeal(db.db, ctx, {
      ...input,
      total: 0.1 + 0.2,
      items: [{ title: 'Item', quantity: 3, unitPrice: 0.1 }],
    });
    expect(db.tables.orders[0].total).toBeCloseTo(0.3);
  });
  it('freezes structured lines and total before asynchronous DB work', async () => {
    const db = createOrderTestDatabase();
    const draft = {
      ...input,
      items: [
        { title: 'Carne', quantity: 2, unitPrice: 14, description: 'Original' },
      ],
    };
    db.hooks.before = (call) => {
      if (call.table === 'pipelines') {
        draft.total = 70;
        draft.items[0].quantity = 5;
        draft.items[0].description = 'Changed';
      }
    };
    await createOrderDeal(db.db, ctx, draft);
    expect(db.tables.orders[0]).toMatchObject({
      total: 28,
      total_amount: 28,
      items: [{ quantity: 2, description: 'Original' }],
    });
    expect(db.tables.deals[0].notes).toContain(
      '2x Carne - R$ 14.00 — Original'
    );
  });

  it('persists an immutable pickup line snapshot, both totals and BRL deal notes', async () => {
    const db = createOrderTestDatabase();
    const items = [
      {
        id: 'carne',
        title: 'Carne',
        quantity: 2,
        unitPrice: 14,
        description: 'Sem cebola',
      },
      {
        id: 'queijo',
        name: 'Queijo',
        quantity: 1,
        unitPrice: 12,
        description: 'Bem quente',
      },
    ];
    await createOrderDeal(db.db, ctx, { ...input, total: 40, items });
    const snapshot = structuredClone(items);
    items[0].quantity = 99;
    expect(db.tables.orders[0]).toMatchObject({
      total: 40,
      total_amount: 40,
      items: snapshot,
      delivery_kind: 'retirada',
      payment_method: 'na_retirada',
    });
    expect(db.tables.deals[0]).toMatchObject({ value: 40, currency: 'BRL' });
    expect(db.tables.deals[0].notes).toContain(
      '2x Carne [carne] - R$ 14.00 — Sem cebola'
    );
    expect(db.tables.deals[0].notes).toContain(
      '1x Queijo [queijo] - R$ 12.00 — Bem quente'
    );
    expect(db.tables.deals[0].notes).toContain('Total: R$ 40.00');
  });

  it('preserves legacy free-text items without inventing prices', async () => {
    const db = createOrderTestDatabase();
    await createOrderDeal(db.db, ctx, {
      ...input,
      items: '2x Carne, sem cebola',
    });
    expect(db.tables.orders[0].items).toBe('2x Carne, sem cebola');
    expect(db.tables.deals[0].notes).toContain('2x Carne, sem cebola');
    expect(db.tables.deals[0].notes).not.toContain('R$ 0.00');
  });

  it('cannot link a deal to a foreign account order id', async () => {
    const db = createOrderTestDatabase();
    const foreign = {
      id: 'foreign-order',
      account_id: 'other',
      deal_id: 'foreign-deal',
    };
    db.tables.orders.push(structuredClone(foreign));
    expect(await createDealForOrder(db.db, ctx, foreign.id, input)).toBeNull();
    expect(db.tables.orders).toEqual([foreign]);
    expect(db.calls.some((c) => c.op !== 'select')).toBe(false);
    expect(db.tables.deals).toHaveLength(0);
  });
  it('rejects a same-account order for another contact before deal/tag effects', async () => {
    const db = createOrderTestDatabase();
    db.tables.orders.push({
      id: 'wrong-contact',
      account_id: ctx.accountId,
      contact_id: 'other-contact',
      deal_id: null,
    });
    expect(
      await createDealForOrder(db.db, ctx, 'wrong-contact', input)
    ).toBeNull();
    expect(db.calls.some((c) => c.op !== 'select')).toBe(false);
  });
  it.each(['returned error', 'missing row'])(
    'fails closed on order preflight %s without side effects',
    async (mode) => {
      const db = createOrderTestDatabase();
      if (mode === 'returned error')
        db.errors['orders:select'] = {
          code: '08006',
          message: 'preflight unavailable',
        };
      expect(
        await createDealForOrder(db.db, ctx, 'missing-order', input)
      ).toBeNull();
      expect(db.calls.some((c) => c.op !== 'select')).toBe(false);
      expect(db.tables.deals).toHaveLength(0);
    }
  );
  it.each(['other-account', 'other-contact'])(
    'rejects a persisted order deal owned by %s',
    async (owner) => {
      const db = createOrderTestDatabase();
      db.tables.orders.push({
        id: 'order',
        account_id: ctx.accountId,
        contact_id: input.contactId,
        deal_id: 'foreign-deal',
        external_reference: 'SAME',
      });
      db.tables.deals.push({
        id: 'foreign-deal',
        account_id: owner === 'other-account' ? 'other-account' : ctx.accountId,
        contact_id:
          owner === 'other-contact' ? 'other-contact' : input.contactId,
        pipeline_id: 'pipe',
        stage_id: 'novo',
      });
      await expect(createOrderDeal(db.db, ctx, input)).rejects.toThrow(
        'Canonical order deal identity'
      );
      expect(await createDealForOrder(db.db, ctx, 'order', input)).toBeNull();
      expect(db.calls.some((c) => c.op !== 'select')).toBe(false);
    }
  );
  it('rejects a conflict winner belonging to another contact without tagging either contact', async () => {
    const db = createOrderTestDatabase();
    db.hooks.before = (call) => {
      if (call.table === 'orders' && call.op === 'upsert')
        db.tables.orders.push({
          id: 'winner',
          account_id: ctx.accountId,
          contact_id: 'other-contact',
          external_reference: 'SAME',
          deal_id: 'winner-deal',
        });
    };
    await expect(createOrderDeal(db.db, ctx, input)).rejects.toThrow(
      'Canonical order identity'
    );
    expect(db.tables.contact_tags).toHaveLength(0);
    expect(db.calls.some((c) => c.table === 'custom_fields')).toBe(false);
  });

  it('returns an existing valid order deal without overwriting its linkage or notes', async () => {
    const db = createOrderTestDatabase();
    db.tables.orders.push({
      id: 'linked-order',
      account_id: ctx.accountId,
      contact_id: input.contactId,
      deal_id: 'linked-deal',
      paid_online: true,
    });
    const deal = {
      id: 'linked-deal',
      account_id: ctx.accountId,
      contact_id: input.contactId,
      pipeline_id: 'pipe',
      stage_id: 'novo',
      value: 70,
      notes: 'Frozen original',
    };
    db.tables.deals.push(structuredClone(deal));
    const result = await createDealForOrder(db.db, ctx, 'linked-order', input);
    expect(result).toMatchObject({
      dealId: 'linked-deal',
      orderId: 'linked-order',
      orderAlreadyExisted: true,
      tagName: 'Confirmado',
    });
    expect(db.tables.deals).toEqual([deal]);
    expect(db.tables.orders[0].deal_id).toBe('linked-deal');
    expect(
      db.calls.some(
        (c) => ['orders', 'deals'].includes(c.table) && c.op !== 'select'
      )
    ).toBe(false);
  });
  it('does not overwrite linkage won by another caller between preflight and update', async () => {
    const db = createOrderTestDatabase();
    db.tables.orders.push({
      id: 'raced-order',
      account_id: ctx.accountId,
      contact_id: input.contactId,
      deal_id: null,
    });
    db.tables.deals.push({
      id: 'winning-deal',
      account_id: ctx.accountId,
      contact_id: input.contactId,
      pipeline_id: 'pipe',
      stage_id: 'novo',
    });
    db.hooks.before = (call) => {
      if (call.table === 'orders' && call.op === 'update')
        db.tables.orders[0].deal_id = 'winning-deal';
    };
    const result = await createDealForOrder(db.db, ctx, 'raced-order', input);
    expect(db.tables.orders[0].deal_id).toBe('winning-deal');
    expect(result).toMatchObject({
      dealId: 'winning-deal',
      orderId: 'raced-order',
      orderAlreadyExisted: true,
    });
  });
  it.each([
    { id: undefined, contact_id: 'contact', deal_id: 'deal' },
    { id: 'order', contact_id: 'contact', deal_id: null },
    { id: 'order', contact_id: 'other-contact', deal_id: 'deal' },
    { id: 'order', contact_id: 'contact', deal_id: 'foreign-deal' },
  ])(
    'rejects invalid canonical replay identity %j without tagging or CRM writes',
    async (row) => {
      const db = createOrderTestDatabase();
      db.tables.orders.push({
        ...row,
        account_id: ctx.accountId,
        external_reference: 'SAME',
      });
      db.tables.deals.push({
        id: 'deal',
        account_id: ctx.accountId,
        contact_id: input.contactId,
        pipeline_id: 'pipe',
        stage_id: 'novo',
      });
      await expect(createOrderDeal(db.db, ctx, input)).rejects.toThrow(
        /Canonical order/
      );
      expect(db.calls.some((c) => c.op !== 'select')).toBe(false);
    }
  );
  it.each(['returned error', 'missing row'])(
    'does not report a linked deal after %s',
    async (mode) => {
      const db = createOrderTestDatabase();
      db.tables.orders.push({
        id: 'local-order',
        account_id: ctx.accountId,
        contact_id: input.contactId,
        deal_id: null,
      });
      if (mode === 'returned error')
        db.errors['orders:update'] = {
          code: '08006',
          message: 'link unavailable',
        };
      else db.missing.add('orders:update');
      expect(
        await createDealForOrder(db.db, ctx, 'local-order', input)
      ).toBeNull();
      expect(db.tables.orders[0].deal_id).toBeNull();
    }
  );
  it('preserves the canonical snapshot inserted after lookup and returns the winning deal', async () => {
    const db = createOrderTestDatabase();
    const canonical = {
      id: 'winning-order',
      account_id: 'acc',
      contact_id: 'contact',
      external_reference: 'SAME',
      deal_id: 'winning-deal',
      paid_online: true,
      status: 'paid',
      total: 70,
      total_amount: 70,
      items: [
        {
          title: 'Carne',
          quantity: 5,
          unitPrice: 14,
          description: 'Sem cebola',
        },
      ],
    };
    db.tables.deals.push({
      id: 'winning-deal',
      account_id: ctx.accountId,
      contact_id: input.contactId,
      pipeline_id: 'pipe',
      stage_id: 'novo',
    });
    db.hooks.before = (c) => {
      if (c.table === 'orders' && c.op === 'upsert')
        db.tables.orders.push(structuredClone(canonical));
    };
    const result = await createOrderDeal(db.db, ctx, input);
    expect(db.tables.orders).toEqual([canonical]);
    expect(result).toMatchObject({
      orderId: canonical.id,
      dealId: canonical.deal_id,
      tagName: 'Confirmado',
      orderAlreadyExisted: true,
    });
    expect(
      db.calls.find((c) => c.table === 'orders' && c.op === 'upsert')?.options
    ).toEqual({
      onConflict: 'account_id,external_reference',
      ignoreDuplicates: true,
    });
    expect(
      db.calls
        .filter((c) => c.table === 'orders' && c.op === 'select')
        .every((c) =>
          c.filters.some(([k, v]) => k === 'account_id' && v === ctx.accountId)
        )
    ).toBe(true);
    expect(db.calls.some((c) => c.table === 'custom_fields')).toBe(false);
  });
  it('rejects 42P10 instead of fetching nothing and reporting success without orderId', async () => {
    const db = createOrderTestDatabase();
    db.errors['orders:upsert'] = {
      code: '42P10',
      message: 'no matching unique constraint',
    };
    await expect(createOrderDeal(db.db, ctx, input)).rejects.toMatchObject({
      code: '42P10',
    });
    expect(
      db.calls.filter((c) => c.table === 'orders' && c.op === 'select')
    ).toHaveLength(1);
    expect(db.tables.contact_tags).toHaveLength(0);
  });
  it.each(['reference', 'no-reference'])(
    'rejects successful %s writes with no durable order row',
    async (mode) => {
      const db = createOrderTestDatabase();
      db.missing.add(mode === 'reference' ? 'orders:upsert' : 'orders:insert');
      await expect(
        createOrderDeal(db.db, ctx, {
          ...input,
          external_reference: mode === 'reference' ? 'SAME' : undefined,
        })
      ).rejects.toThrow('Canonical order was not persisted');
      expect(db.tables.contact_tags).toHaveLength(0);
    }
  );
  it.each(['returned', 'thrown'])(
    'fails closed on %s order lookup error before creating a deal',
    async (mode) => {
      const db = createOrderTestDatabase();
      const error = { code: '08006', message: 'lookup unavailable' };
      if (mode === 'returned') db.errors['orders:select'] = error;
      else
        db.hooks.before = (c) => {
          if (c.table === 'orders' && c.op === 'select')
            throw new Error(error.message);
        };
      await expect(createOrderDeal(db.db, ctx, input)).rejects.toMatchObject({
        message: 'lookup unavailable',
      });
      expect(db.tables.deals).toHaveLength(0);
      expect(db.tables.orders).toHaveLength(0);
      expect(db.calls.some((c) => c.op !== 'select')).toBe(false);
    }
  );
  it('never returns another account order with the same reference', async () => {
    const db = createOrderTestDatabase();
    const foreign = {
      id: 'foreign-order',
      account_id: 'other',
      external_reference: 'SAME',
      deal_id: 'foreign-deal',
      total_amount: 70,
    };
    db.tables.orders.push(foreign);
    const result = await createOrderDeal(db.db, ctx, input);
    expect(result.orderId).not.toBe('foreign-order');
    expect(db.tables.orders[0]).toEqual(foreign);
    expect(db.tables.orders).toHaveLength(2);
    expect(
      db.calls
        .filter((c) => c.table === 'orders' && c.op === 'select')
        .every((c) =>
          c.filters.some(([k, v]) => k === 'account_id' && v === ctx.accountId)
        )
    ).toBe(true);
  });
});
