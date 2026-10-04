import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  TAG_AGUARDANDO,
  TAG_CONFIRMADO,
  buildOrderNotes,
  createDealForOrder,
  createOrderDeal,
  buildOrderTitle,
  deliveryKindLabel,
  paymentMethodLabel,
  selectStatusTagName,
} from './create-order';

describe('buildOrderTitle', () => {
  it("monta o título no formato 'Pedido - {nome}'", () => {
    expect(buildOrderTitle('Maria Silva')).toBe('Pedido - Maria Silva');
  });

  it("apara espaços e usa 'Cliente' quando o nome é vazio", () => {
    expect(buildOrderTitle('  ')).toBe('Pedido - Cliente');
    expect(buildOrderTitle('  João ')).toBe('Pedido - João');
  });
});

describe('selectStatusTagName', () => {
  it("retorna 'Confirmado' quando pago online", () => {
    expect(selectStatusTagName(true)).toBe(TAG_CONFIRMADO);
  });

  it("retorna 'Aguardando Pagamento' quando não pago online", () => {
    expect(selectStatusTagName(false)).toBe(TAG_AGUARDANDO);
  });
});

describe('paymentMethodLabel / deliveryKindLabel', () => {
  it('traduz as formas de pagamento', () => {
    expect(paymentMethodLabel('pix')).toBe('Pix');
    expect(paymentMethodLabel('dinheiro')).toBe('Dinheiro');
    expect(paymentMethodLabel('mercado_pago')).toBe(
      'Mercado Pago (link online)'
    );
    expect(paymentMethodLabel('na_retirada')).toBe('Na retirada (pagar na loja)');
  });

  it('traduz o tipo de recebimento', () => {
    expect(deliveryKindLabel('delivery')).toBe('Delivery');
    expect(deliveryKindLabel('retirada')).toBe('Retirada no local');
  });
});

describe('buildOrderNotes', () => {
  it('inclui endereço para delivery', () => {
    const notes = buildOrderNotes({
      deliveryKind: 'delivery',
      paymentMethod: 'pix',
      deliveryAddress: 'Rua A, 123 - Centro',
    });
    expect(notes).toContain('Tipo: Delivery');
    expect(notes).toContain('Forma de pagamento: Pix');
    expect(notes).toContain('Endereço: Rua A, 123 - Centro');
  });

  it('marca endereço não informado no delivery', () => {
    const notes = buildOrderNotes({
      deliveryKind: 'delivery',
      paymentMethod: 'cartao',
    });
    expect(notes).toContain('Endereço: (não informado)');
  });

  it('não inclui endereço para retirada', () => {
    const notes = buildOrderNotes({
      deliveryKind: 'retirada',
      paymentMethod: 'dinheiro',
    });
    expect(notes).toContain('Tipo: Retirada no local');
    expect(notes).not.toContain('Endereço');
  });
});

// ------------------------------------------------------------
// createOrderDeal — against an in-memory stand-in for Supabase
// ------------------------------------------------------------

type Row = Record<string, unknown>;

function fakeDb(tables: Record<string, Row[]>) {
  let seq = 0;
  const from = (table: string) => {
    const filters: Array<[string, unknown]> = [];
    let op: 'select' | 'insert' | 'upsert' | 'update' = 'select';
    let payload: Row = {};
    const rows = () => (tables[table] ??= []);
    const run = (): Row[] => {
      if (op === 'insert') {
        const row = { id: `${table}-${++seq}`, ...payload };
        rows().push(row);
        return [row];
      }
      if (op === 'upsert') {
        const key = table === 'orders' ? ['external_reference'] : ['contact_id', 'tag_id'];
        const existing = rows().find((r) => key.every((k) => r[k] === payload[k]));
        if (existing) return [Object.assign(existing, payload)];
        const row = { id: `${table}-${++seq}`, ...payload };
        rows().push(row);
        return [row];
      }
      const matched = rows().filter((r) => filters.every(([k, v]) => r[k] === v));
      if (op === 'update') matched.forEach((r) => Object.assign(r, payload));
      return matched;
    };
    const q = {
      select: () => q,
      insert: (p: Row) => ((op = 'insert'), (payload = p), q),
      upsert: (p: Row) => ((op = 'upsert'), (payload = p), q),
      update: (p: Row) => ((op = 'update'), (payload = p), q),
      eq: (k: string, v: unknown) => (filters.push([k, v]), q),
      limit: () => q,
      maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
      then: (resolve: (r: { data: Row[]; error: null }) => void) =>
        resolve({ data: run(), error: null }),
    };
    return q;
  };
  return { from } as unknown as SupabaseClient;
}

const ctx = { accountId: 'acc', userId: 'user' };

const seededTables = (): Record<string, Row[]> => ({
  pipelines: [{ id: 'pipe', account_id: 'acc', name: 'Pedidos Delivery' }],
  pipeline_stages: [{ id: 'novo', pipeline_id: 'pipe', name: 'Novo Pedido' }],
  deals: [],
  orders: [],
  tags: [],
  contact_tags: [],
});

const input = {
  contactId: 'contact-1',
  customerName: 'Maria',
  deliveryKind: 'delivery' as const,
  paymentMethod: 'mercado_pago' as const,
  total: 33.5,
  deliveryAddress: 'Rua Teste 123',
  paidOnline: false,
  conversationId: 'conv-1',
  external_reference: 'PED-1',
};

describe('createOrderDeal', () => {
  it('cria o card no Novo Pedido, o pedido e a tag Aguardando Pagamento', async () => {
    const tables = seededTables();
    const res = await createOrderDeal(fakeDb(tables), ctx, input);

    expect(res).toMatchObject({ pipelineId: 'pipe', stageId: 'novo', tagName: TAG_AGUARDANDO });
    expect(tables.deals).toHaveLength(1);
    expect(tables.deals[0]).toMatchObject({
      account_id: 'acc',
      stage_id: 'novo',
      contact_id: 'contact-1',
      title: 'Pedido - Maria',
      value: 33.5,
    });
    expect(tables.orders).toHaveLength(1);
    expect(tables.orders[0]).toMatchObject({ external_reference: 'PED-1', deal_id: res.dealId });
    expect(tables.tags.map((t) => t.name)).toEqual([TAG_AGUARDANDO]);
  });

  it('é idempotente pelo external_reference', async () => {
    const tables = seededTables();
    const first = await createOrderDeal(fakeDb(tables), ctx, input);
    const second = await createOrderDeal(fakeDb(tables), ctx, input);

    expect(second).toMatchObject({ dealId: first.dealId, orderAlreadyExisted: true });
    expect(tables.deals).toHaveLength(1);
    expect(tables.orders).toHaveLength(1);
  });

  it('com skipOrderRecord cria só o card e a tag', async () => {
    const tables = seededTables();
    const res = await createOrderDeal(fakeDb(tables), ctx, { ...input, skipOrderRecord: true });

    expect(res.dealId).toBeTruthy();
    expect(tables.deals).toHaveLength(1);
    expect(tables.orders).toHaveLength(0);
    expect(tables.contact_tags).toHaveLength(1);
  });

  it('atualiza deal aberto existente para a conversa em vez de duplicar', async () => {
    const tables = seededTables();
    // Deal preexistente aberto criado pelo webhook (ensureAutoDealForConversation) com valor 0
    tables.deals = [
      {
        id: 'deal-existing-1',
        account_id: 'acc',
        user_id: 'user',
        pipeline_id: 'pipe',
        stage_id: 'novo',
        contact_id: 'contact-1',
        conversation_id: 'conv-1',
        title: 'Pedido - Maria',
        value: 0,
        status: 'open',
      },
    ];

    const res = await createOrderDeal(fakeDb(tables), ctx, {
      ...input,
      skipOrderRecord: true,
    });

    expect(res.dealId).toBe('deal-existing-1');
    expect(tables.deals).toHaveLength(1);
    expect(tables.deals[0]).toMatchObject({
      id: 'deal-existing-1',
      value: 33.5,
      title: 'Pedido - Maria',
      stage_id: 'novo',
    });
  });

  it('é idempotente mesmo com skipOrderRecord=true (como no Flow custom_action)', async () => {
    const tables = seededTables();
    const first = await createOrderDeal(fakeDb(tables), ctx, { ...input, skipOrderRecord: true });
    const second = await createOrderDeal(fakeDb(tables), ctx, { ...input, skipOrderRecord: true });

    expect(second.dealId).toBe(first.dealId);
    expect(tables.deals).toHaveLength(1);
  });

  it('falha com mensagem clara quando o pipeline não existe', async () => {
    const tables = seededTables();
    tables.pipelines = [];
    await expect(createOrderDeal(fakeDb(tables), ctx, input)).rejects.toThrow(
      'Pipeline "Pedidos Delivery" not found'
    );
  });
});

describe('createDealForOrder', () => {
  it('cria o card sem gravar outro pedido e vincula o deal ao pedido existente', async () => {
    const tables = seededTables();
    tables.orders = [{ id: 'order-site', external_reference: 'SITE-1', status: 'pending' }];

    const res = await createDealForOrder(fakeDb(tables), ctx, 'order-site', {
      ...input,
      external_reference: 'SITE-1',
    });

    expect(res?.dealId).toBeTruthy();
    expect(tables.deals).toHaveLength(1);
    expect(tables.orders).toHaveLength(1);
    expect(tables.orders[0].deal_id).toBe(res!.dealId);
  });

  it('não lança erro quando o pipeline não existe', async () => {
    const tables = seededTables();
    tables.pipelines = [];
    await expect(createDealForOrder(fakeDb(tables), ctx, null, input)).resolves.toBeNull();
    expect(tables.deals).toHaveLength(0);
  });
});
