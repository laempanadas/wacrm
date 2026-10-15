import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PEDIDO_EMPANADAS_FLOW } from './pedido-empanadas-flow';
const mocks = vi.hoisted(() => ({
  db: { from: vi.fn(), rpc: vi.fn() },
  mp: vi.fn(),
  pickup: vi.fn(),
  text: vi.fn(),
  buttons: vi.fn(),
  payment: vi.fn(),
  save: vi.fn(),
  catalog: vi.fn(),
}));
vi.mock('./admin-client', () => ({ supabaseAdmin: () => mocks.db }));
vi.mock('./meta-send', () => ({
  engineSendText: mocks.text,
  engineSendPayment: mocks.payment,
  engineSendInteractiveButtons: mocks.buttons,
  engineSendInteractiveList: vi.fn(),
  engineSendMedia: vi.fn(),
}));
vi.mock('@/lib/orders/create-order-with-mercado-pago', () => ({
  createOrderWithMercadoPago: mocks.mp,
}));
vi.mock('@/lib/orders/create-order', () => ({ createOrderDeal: mocks.pickup }));
vi.mock('@/lib/orders/text-order-flow', () => ({
  getSavedCustomerAddress: vi.fn(),
  saveContactOrderFields: mocks.save,
}));
vi.mock('@/lib/orders/order-catalog', () => ({
  loadOrderCatalog: mocks.catalog,
}));
import { dispatchInboundToFlows } from './engine';
import { transitionFlowRun, writeFlowVars } from './checkout-consent';
const id = '11111111-1111-4111-8111-111111111111';
let run: Record<string, unknown>;
let active: boolean;
let failVarsPersistence: boolean;
let missingVarsRow: boolean;
let failRunLookup: boolean;
let failEventLookup: boolean;
let writes: Array<{ table: string; value: Record<string, unknown> }>;
let claim: {
  state: string;
  snapshot: unknown;
  evidence?: unknown;
  revision: number;
} | null;
let seedDisplayedSummary: boolean;
let consumedConfirmations: Set<string>;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const input = (message: Record<string, unknown>) => {
  // Existing parked-run fixtures represent an already delivered summary.
  // SQL tests exercise actual prompt registration and reject absent evidence.
  if (
    seedDisplayedSummary &&
    String(run.current_node_key).startsWith('confirmar_') &&
    !run.consent_prompt_snapshot
  ) {
    run.consent_prompt_snapshot = structuredClone(run.vars);
    run.consent_prompt_node = run.current_node_key;
    run.consent_prompt_message = 'shown-summary';
  }
  return {
    accountId: 'account',
    userId: 'user',
    contactId: 'contact',
    conversationId: 'conversation',
    isFirstInboundMessage: false,
    message: {
      meta_message_id: 'inbound',
      ...(message.kind === 'interactive_reply'
        ? { context_message_id: 'shown-summary' }
        : {}),
      ...message,
    },
  } as Parameters<typeof dispatchInboundToFlows>[0];
};
beforeEach(() => {
  vi.clearAllMocks();
  writes = [];
  active = true;
  failVarsPersistence = false;
  failRunLookup = false;
  missingVarsRow = false;
  failEventLookup = false;
  claim = null;
  seedDisplayedSummary = true;
  consumedConfirmations = new Set();
  mocks.db.rpc.mockImplementation(async (name, args) => {
    if (
      name === 'flow_checkout_confirm' ||
      name === 'flow_checkout_transition'
    ) {
      if (failVarsPersistence)
        return { error: { message: 'DB unavailable' }, data: null };
      if (
        missingVarsRow ||
        run.status !== 'active' ||
        Number(run.consent_revision ?? 0) !== args.p_revision ||
        JSON.stringify(run.vars) !== JSON.stringify(args.p_snapshot)
      )
        return { data: [], error: null };
      if (name === 'flow_checkout_confirm') {
        if (
          run.consent_inbound_message ||
          consumedConfirmations.has(args.p_inbound_message) ||
          run.consent_prompt_node !== run.current_node_key ||
          JSON.stringify(run.consent_prompt_snapshot) !==
            JSON.stringify(run.vars)
        )
          return { data: [], error: null };
        run.vars = { ...(run.vars as object), pedido_confirmado: 'true' };
        run.consent_confirmed_snapshot = structuredClone(run.vars);
        run.consent_inbound_message = args.p_inbound_message;
        consumedConfirmations.add(args.p_inbound_message);
      } else {
        if (run.current_node_key !== args.p_node)
          return { data: [], error: null };
        Object.assign(run, args.p_patch);
        if (
          args.p_prompt_message &&
          String(run.current_node_key).startsWith('confirmar_')
        ) {
          run.consent_prompt_snapshot = structuredClone(run.vars);
          run.consent_prompt_node = run.current_node_key;
          run.consent_prompt_message = args.p_prompt_message;
          run.consent_inbound_message = null;
          run.consent_confirmed_snapshot = null;
        }
      }
      run.consent_revision = args.p_revision + 1;
      writes.push({ table: 'flow_runs', value: structuredClone(run) });
      return { data: [structuredClone(run)], error: null };
    }
    if (name === 'flow_checkout_correct') {
      const vars = {
        ...(run.vars as object),
        catalog_review_text: args.p_text,
        pedido_confirmado: 'false',
      };
      if (claim) claim.state = 'reconciliation_required';
      Object.assign(run, {
        vars,
        status: 'handed_off',
        consent_revision: Number(run.consent_revision ?? 0) + 1,
      });
      writes.push({ table: 'flow_runs', value: { vars } });
      return { data: [{ ...structuredClone(run) }], error: null };
    }
    if (name === 'flow_checkout_finish') {
      if (failVarsPersistence)
        return { error: { message: 'DB unavailable' }, data: null };
      if (missingVarsRow) return { error: null, data: [] };
      if (!claim || claim.evidence) return { data: [], error: null };
      claim.evidence = args.p_evidence;
      const owned =
        run.status === 'active' && run.consent_revision === claim.revision;
      claim.state =
        owned && args.p_success ? 'completed' : 'reconciliation_required';
      if (owned && args.p_success) {
        run.vars = { ...(run.vars as object), ...args.p_evidence };
        run.consent_revision = Number(run.consent_revision) + 1;
        writes.push({ table: 'flow_runs', value: { vars: run.vars } });
      } else if (owned) {
        run.status = 'handed_off';
      }
      return {
        data: [
          {
            owned,
            vars: structuredClone(run.vars),
            consent_revision: run.consent_revision,
          },
        ],
        error: null,
      };
    }
    if (name === 'flow_checkout_authorize' || name === 'flow_checkout_write') {
      if (failVarsPersistence)
        return { error: { message: 'DB unavailable' }, data: null };
      if (
        missingVarsRow ||
        run.status !== 'active' ||
        Number(run.consent_revision ?? 0) !== args.p_revision ||
        JSON.stringify(run.vars) !== JSON.stringify(args.p_snapshot)
      )
        return { data: [], error: null };
      if (name === 'flow_checkout_authorize') {
        if (
          claim ||
          !run.consent_inbound_message ||
          JSON.stringify(run.consent_confirmed_snapshot) !==
            JSON.stringify(run.vars)
        )
          return { data: [], error: null };
        claim = {
          state: 'started',
          snapshot: structuredClone(args.p_snapshot),
          revision: args.p_revision,
        };
        return { data: [{ claim_id: 'claim-id' }], error: null };
      }
      if (claim) return { data: [], error: null };
      if (JSON.stringify(run.vars) === JSON.stringify(args.p_vars))
        return { data: [structuredClone(run)], error: null };
      Object.assign(run, {
        vars: args.p_vars,
        consent_revision: args.p_revision + 1,
        consent_inbound_message: null,
        consent_confirmed_snapshot: null,
      });
      writes.push({ table: 'flow_runs', value: { vars: args.p_vars } });
      return { data: [structuredClone(run)], error: null };
    }
    return { error: null };
  });
  mocks.catalog.mockResolvedValue([
    { id, nome: 'Carne', preco: 14.5, aliases: [] },
  ]);
  run = {
    status: 'active',
    consent_revision: 0,
    id: 'run-id',
    account_id: 'account',
    user_id: 'user',
    flow_id: 'flow',
    contact_id: 'contact',
    conversation_id: 'conversation',
    current_node_key: 'ask_endereco',
    reprompt_count: 0,
    vars: {
      catalog_order_version: 1,
      nome: 'Cliente',
      tipo_entrega: 'delivery',
      total: 29,
      total_formatado: 'R$ 29,00',
      itens_lista: '2x Carne',
      itens: [
        {
          id,
          title: 'Carne',
          description: 'Carne',
          quantity: 2,
          unitPrice: 14.5,
        },
      ],
      observacoes: 'Nenhuma',
    },
  };
  mocks.db.from.mockImplementation((table: string) => {
    let operation = 'select';
    let value: Record<string, unknown> = {};
    const filters: Array<[string, unknown]> = [];
    const q: Record<string, unknown> = {};
    for (const key of ['eq', 'in', 'filter', 'order', 'limit', 'is', 'select'])
      q[key] = () => q;
    q.eq = (key: string, expected: unknown) => {
      filters.push([key, expected]);
      return q;
    };
    for (const key of ['update', 'insert'])
      q[key] = (payload: Record<string, unknown>) => {
        operation = key;
        value = payload;
        writes.push({ table, value: payload });
        return q;
      };
    const result = () => {
      const matches = filters.every(
        ([key, expected]) =>
          key === 'contact_id' ||
          key === 'account_id' ||
          key === 'id' ||
          run[key] === expected
      );
      if (
        table === 'flow_runs' &&
        operation === 'update' &&
        matches &&
        !failVarsPersistence &&
        !missingVarsRow
      )
        Object.assign(run, structuredClone(value));
      return {
        data:
          table === 'flow_runs'
            ? operation === 'select'
              ? active
                ? [structuredClone(run)]
                : []
              : missingVarsRow && writes.at(-1)?.value.vars
                ? []
                : [{ id: 'run-id' }]
            : table === 'flow_nodes'
              ? PEDIDO_EMPANADAS_FLOW.nodes
              : table === 'flows'
                ? {
                    id: 'flow',
                    account_id: 'account',
                    user_id: 'user',
                    entry_node_id: 'start',
                    trigger_type: 'catalog_order',
                  }
                : table === 'contacts'
                  ? { phone: '5511999999999' }
                  : null,
        error:
          (table === 'flow_run_events' &&
            operation === 'select' &&
            failEventLookup) ||
          (table === 'flow_runs' &&
            ((operation === 'select' && failRunLookup) ||
              (operation === 'update' &&
                failVarsPersistence &&
                writes.at(-1)?.value.vars)))
            ? { message: 'DB unavailable' }
            : null,
        count: 0,
      };
    };
    q.then = (resolve: (value: unknown) => void) => {
      const r = result();
      return Promise.resolve(
        table === 'flows' ? { ...r, data: [r.data] } : r
      ).then(resolve);
    };
    q.maybeSingle = q.single = async () =>
      table === 'flow_runs' && operation === 'insert'
        ? {
            data: {
              ...run,
              vars: writes.filter((w) => w.table === 'flow_runs').at(-1)?.value
                .vars,
            },
            error: null,
          }
        : result();
    return q;
  });
  mocks.mp.mockResolvedValue({
    ok: true,
    link_mercado_pago: 'https://pay.example/checkout',
    dealId: 'deal',
    orderId: 'order',
  });
  for (const send of [mocks.text, mocks.buttons, mocks.payment])
    send.mockResolvedValue({ whatsapp_message_id: 'outbound' });
});
describe('catalog engine safety', () => {
  it('never lets the button from summary A authorize the newer snapshot B', async () => {
    seedDisplayedSummary = false;
    run.current_node_key = 'confirmar_delivery';
    (run.vars as Record<string, unknown>).endereco = 'Rua A, 123 Centro';
    await transitionFlowRun(mocks.db as never, run as never, {}, 'summary-A');
    await writeFlowVars(mocks.db as never, run as never, {
      ...(run.vars as object),
      endereco: 'Rua B, 456 Centro',
    });
    await transitionFlowRun(mocks.db as never, run as never, {}, 'summary-B');
    await dispatchInboundToFlows(
      input({
        kind: 'interactive_reply',
        reply_id: 'confirmar_pedido',
        reply_title: 'Confirmar pedido',
        context_message_id: 'summary-A',
      })
    );
    expect(mocks.mp).not.toHaveBeenCalled();
    expect(mocks.pickup).not.toHaveBeenCalled();
    expect(mocks.payment).not.toHaveBeenCalled();
    expect(claim).toBeNull();
    expect(run.current_node_key).toBe('confirmar_delivery');
    expect(run.vars).toMatchObject({ endereco: 'Rua B, 456 Centro' });
    expect(run.consent_inbound_message).toBeNull();
    // A rejected click must not consume the new summary's valid confirmation.
    await dispatchInboundToFlows(
      input({
        kind: 'interactive_reply',
        reply_id: 'confirmar_pedido',
        reply_title: 'Confirmar pedido',
        context_message_id: 'summary-B',
        meta_message_id: 'fresh-click-B',
      })
    );
    expect(mocks.mp).toHaveBeenCalledTimes(1);
    expect(mocks.mp).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ deliveryAddress: 'Rua B, 456 Centro' })
    );
  });
  it.each([undefined, ''])(
    'fails closed for interactive confirmation without context (%s)',
    async (context) => {
      run.current_node_key = 'confirmar_delivery';
      (run.vars as Record<string, unknown>).endereco = 'Rua B, 456 Centro';
      const result = await dispatchInboundToFlows(
        input({
          kind: 'interactive_reply',
          reply_id: 'confirmar_pedido',
          reply_title: 'Confirmar pedido',
          context_message_id: context,
        })
      );
      expect(result.consumed).toBe(true);
      expect(mocks.mp).not.toHaveBeenCalled();
      expect(claim).toBeNull();
    }
  );
  it('does not authorize an arbitrary boolean without a delivered confirmation snapshot', async () => {
    seedDisplayedSummary = false;
    run.current_node_key = 'confirmar_delivery';
    Object.assign(run.vars as object, {
      pedido_confirmado: 'true',
      endereco: 'Rua Um, 123 Centro',
    });
    await dispatchInboundToFlows(input({ kind: 'text', text: 'confirmar' }));
    expect(mocks.mp).not.toHaveBeenCalled();
    expect(claim).toBeNull();
  });
  it('stops progression when set_var persistence throws', async () => {
    run.current_node_key = 'pedido_recebido';
    failVarsPersistence = true;
    await dispatchInboundToFlows(input({ kind: 'text', text: 'delivery' }));
    expect(mocks.text).not.toHaveBeenCalled();
    expect(mocks.buttons).not.toHaveBeenCalled();
    expect(mocks.mp).not.toHaveBeenCalled();
  });
  it('blocks obsolete confirmation paused in catalog I/O when correction wins authorization', async () => {
    run.current_node_key = 'confirmar_delivery';
    (run.vars as Record<string, unknown>).endereco = 'Rua Um, 123 Centro';
    const entered = deferred(),
      release = deferred();
    mocks.catalog.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return [{ id, nome: 'Carne', preco: 14.5, aliases: [] }];
    });
    const confirmation = dispatchInboundToFlows(
      input({ kind: 'text', text: 'confirmar' })
    );
    await entered.promise;
    await dispatchInboundToFlows(
      input({
        kind: 'text',
        text: 'troca para 1 carne',
        meta_message_id: 'correction',
      })
    );
    release.resolve();
    await confirmation;
    expect(mocks.mp).not.toHaveBeenCalled();
    expect(mocks.payment).not.toHaveBeenCalled();
    expect(run.vars).toMatchObject({
      pedido_confirmado: 'false',
      catalog_review_text: 'troca para 1 carne',
    });
    expect(run.status).toBe('handed_off');
  });
  it('retains started checkout evidence for reconciliation after correction without overwriting consent', async () => {
    run.current_node_key = 'confirmar_delivery';
    (run.vars as Record<string, unknown>).endereco = 'Rua Um, 123 Centro';
    const entered = deferred(),
      release = deferred();
    mocks.mp.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return {
        ok: true,
        orderId: 'order',
        dealId: 'deal',
        link_mercado_pago: 'https://pay.example/checkout',
      };
    });
    const confirmation = dispatchInboundToFlows(
      input({ kind: 'text', text: 'confirmar' })
    );
    await entered.promise;
    await dispatchInboundToFlows(
      input({
        kind: 'text',
        text: 'troca para 1 carne',
        meta_message_id: 'correction',
      })
    );
    release.resolve();
    await confirmation;
    expect(mocks.mp).toHaveBeenCalledTimes(1);
    expect(mocks.payment).not.toHaveBeenCalled();
    expect(run.vars).toMatchObject({
      pedido_confirmado: 'false',
      catalog_review_text: 'troca para 1 carne',
    });
    expect(claim).toMatchObject({
      state: 'reconciliation_required',
      evidence: { order_id: 'order', deal_id: 'deal' },
    });
  });
  it('authorizes only one of simultaneous duplicate confirmations', async () => {
    run.current_node_key = 'confirmar_delivery';
    (run.vars as Record<string, unknown>).endereco = 'Rua Um, 123 Centro';
    await Promise.all([
      dispatchInboundToFlows(
        input({ kind: 'text', text: 'confirmar', meta_message_id: 'first' })
      ),
      dispatchInboundToFlows(
        input({ kind: 'text', text: 'confirmar', meta_message_id: 'second' })
      ),
    ]);
    expect(mocks.mp).toHaveBeenCalledTimes(1);
    expect(mocks.payment).toHaveBeenCalledTimes(1);
    expect(claim).toMatchObject({ state: 'completed' });
  });
  it('persists pickup using complete frozen lines and never creates online payment', async () => {
    run.current_node_key = 'confirmar_retirada';
    (run.vars as Record<string, unknown>).tipo_entrega = 'retirada';
    mocks.pickup.mockResolvedValue({
      dealId: 'pickup-deal',
      orderId: 'pickup-order',
    });
    await dispatchInboundToFlows(input({ kind: 'text', text: 'confirmar' }));
    expect(mocks.pickup).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        items: (run.vars as Record<string, unknown>).itens,
        total: 29,
        paymentMethod: 'na_retirada',
        paidOnline: false,
      })
    );
    expect(mocks.mp).not.toHaveBeenCalled();
    expect(mocks.payment).not.toHaveBeenCalled();
  });
  it('hands off pickup without reporting success when canonical order is absent', async () => {
    run.current_node_key = 'confirmar_retirada';
    (run.vars as Record<string, unknown>).tipo_entrega = 'retirada';
    mocks.pickup.mockResolvedValue({ dealId: 'pickup-deal' });
    const result = await dispatchInboundToFlows(
      input({ kind: 'text', text: 'confirmar' })
    );
    expect(result.outcome).toBe('handed_off');
    expect(
      mocks.text.mock.calls.some(([arg]) => arg.text?.includes('confirmado'))
    ).toBe(false);
    expect(mocks.mp).not.toHaveBeenCalled();
  });
  it('blocks checkout with an incomplete delivery address', async () => {
    run.current_node_key = 'confirmar_delivery';
    (run.vars as Record<string, unknown>).endereco = 'Rua Flores';
    const result = await dispatchInboundToFlows(
      input({
        kind: 'interactive_reply',
        reply_id: 'confirmar_pedido',
        reply_title: 'Confirmar pedido',
      })
    );
    expect(result.outcome).toBe('handed_off');
    expect(mocks.mp).not.toHaveBeenCalled();
    expect(mocks.payment).not.toHaveBeenCalled();
  });
  it('keeps collecting instead of showing confirmation for an incomplete address', async () => {
    await dispatchInboundToFlows(input({ kind: 'text', text: 'Rua Flores' }));
    expect(mocks.buttons).not.toHaveBeenCalled();
    expect(mocks.mp).not.toHaveBeenCalled();
  });
  it('sends a short branded payment body with canonical order identity and no duplicated URL', async () => {
    run.current_node_key = 'confirmar_delivery';
    (run.vars as Record<string, unknown>).endereco = 'Rua Um, 123 Centro';
    await dispatchInboundToFlows(
      input({
        kind: 'interactive_reply',
        reply_id: 'confirmar_pedido',
        reply_title: 'Confirmar pedido',
      })
    );
    expect(mocks.payment).toHaveBeenCalledWith(
      expect.objectContaining({
        bodyText:
          'La Empanadas — Pedido order\nTotal: R$ 29,00\nPague com segurança pelo Mercado Pago.',
        buttonUrl: 'https://pay.example/checkout',
      })
    );
  });
  it.each(['unavailable', 'price_changed'])(
    'blocks confirmation when the live catalog is %s',
    async (change) => {
      run.current_node_key = 'confirmar_delivery';
      (run.vars as Record<string, unknown>).endereco = 'Rua Um, 123 Centro';
      mocks.catalog.mockResolvedValue(
        change === 'unavailable'
          ? []
          : [{ id, nome: 'Carne', preco: 15, aliases: [] }]
      );
      const result = await dispatchInboundToFlows(
        input({
          kind: 'interactive_reply',
          reply_id: 'confirmar_pedido',
          reply_title: 'Confirmar pedido',
        })
      );
      expect(result.outcome).toBe('handed_off');
      expect(mocks.mp).not.toHaveBeenCalled();
      expect(mocks.pickup).not.toHaveBeenCalled();
      expect(mocks.payment).not.toHaveBeenCalled();
    }
  );
  it('does not create checkout when inbound deduplication cannot be read', async () => {
    failEventLookup = true;
    run.current_node_key = 'confirmar_delivery';
    (run.vars as Record<string, unknown>).endereco = 'Rua Um, 123 Centro';
    const result = await dispatchInboundToFlows(
      input({
        kind: 'interactive_reply',
        reply_id: 'confirmar_pedido',
        reply_title: 'Confirmar pedido',
      })
    );
    expect(result.consumed).toBe(true);
    expect(mocks.mp).not.toHaveBeenCalled();
    expect(mocks.payment).not.toHaveBeenCalled();
  });

  it('consumes inbound on active-run lookup errors instead of allowing other commerce paths', async () => {
    failRunLookup = true;
    const result = await dispatchInboundToFlows(
      input({ kind: 'text', text: 'confirmar pedido' })
    );
    expect(result.consumed).toBe(true);
    expect(mocks.mp).not.toHaveBeenCalled();
    expect(mocks.buttons).not.toHaveBeenCalled();
  });
  it('does not send checkout if canonical references update affects no row', async () => {
    run.current_node_key = 'confirmar_delivery';
    (run.vars as Record<string, unknown>).endereco = 'Rua Um, 123 Centro';
    mocks.mp.mockImplementation(async () => {
      missingVarsRow = true;
      return {
        ok: true,
        link_mercado_pago: 'https://pay.example/checkout',
        dealId: 'deal',
        orderId: 'order',
      };
    });
    const result = await dispatchInboundToFlows(
      input({
        kind: 'interactive_reply',
        reply_id: 'confirmar_pedido',
        reply_title: 'Confirmar pedido',
      })
    );
    expect(result.outcome).toBe('handed_off');
    expect(mocks.payment).not.toHaveBeenCalled();
  });
  it('does not send checkout if saving canonical references fails', async () => {
    run.current_node_key = 'confirmar_delivery';
    (run.vars as Record<string, unknown>).endereco = 'Rua Um, 123 Centro';
    mocks.mp.mockImplementation(async () => {
      failVarsPersistence = true;
      return {
        ok: true,
        link_mercado_pago: 'https://pay.example/checkout',
        dealId: 'deal',
        orderId: 'order',
      };
    });
    const result = await dispatchInboundToFlows(
      input({
        kind: 'interactive_reply',
        reply_id: 'confirmar_pedido',
        reply_title: 'Confirmar pedido',
      })
    );
    expect(result.outcome).toBe('handed_off');
    expect(mocks.payment).not.toHaveBeenCalled();
  });
  it('hands off payment-send uncertainty rather than marking the run complete', async () => {
    run.current_node_key = 'confirmar_delivery';
    (run.vars as Record<string, unknown>).endereco = 'Rua Um, 123 Centro';
    mocks.payment.mockRejectedValueOnce(new Error('delivery uncertain'));
    const result = await dispatchInboundToFlows(
      input({
        kind: 'interactive_reply',
        reply_id: 'confirmar_pedido',
        reply_title: 'Confirmar pedido',
      })
    );
    expect(result.outcome).toBe('handed_off');
  });
  it('preserves a correction offered as address and hands off without charging', async () => {
    const result = await dispatchInboundToFlows(
      input({ kind: 'text', text: 'troca para 3 de carne sem cebola' })
    );
    expect(result.outcome).toBe('handed_off');
    expect(
      writes.some(
        (w) =>
          (w.value.vars as Record<string, unknown>)?.catalog_review_text ===
          'troca para 3 de carne sem cebola'
      )
    ).toBe(true);
    expect(mocks.mp).not.toHaveBeenCalled();
  });

  it('rejects an incomplete successful checkout without a canonical order ID', async () => {
    run.current_node_key = 'confirmar_delivery';
    (run.vars as Record<string, unknown>).endereco = 'Rua Um, 123 Centro';
    mocks.mp.mockResolvedValueOnce({
      ok: true,
      link_mercado_pago: 'https://pay.example/checkout',
      dealId: 'deal',
    });
    const result = await dispatchInboundToFlows(
      input({
        kind: 'interactive_reply',
        reply_id: 'confirmar_pedido',
        reply_title: 'Confirmar pedido',
      })
    );
    expect(result.outcome).toBe('handed_off');
    expect(mocks.payment).not.toHaveBeenCalled();
  });
  it('never creates a second delivery deal to repair an incomplete saved checkout', async () => {
    run.current_node_key = 'confirmar_delivery';
    Object.assign(run.vars as Record<string, unknown>, {
      endereco: 'Rua Um, 123 Centro',
      link_mercado_pago: 'https://pay.example/checkout',
    });
    const result = await dispatchInboundToFlows(
      input({
        kind: 'interactive_reply',
        reply_id: 'confirmar_pedido',
        reply_title: 'Confirmar pedido',
      })
    );
    expect(result.outcome).toBe('handed_off');
    expect(mocks.pickup).not.toHaveBeenCalled();
    expect(mocks.payment).not.toHaveBeenCalled();
  });
  it('preserves native notes for review instead of silently charging the base cart', async () => {
    active = false;
    const message = {
      kind: 'catalog_order',
      text: 'cart',
      total: 29,
      notes: 'sem cebola',
      items: [{ retailer_id: id, quantity: 2, unit_price: 14.5 }],
    };
    const result = await dispatchInboundToFlows(input(message));
    expect(result.outcome).toBe('handed_off');
    expect(
      writes.find((w) => w.table === 'flow_runs' && w.value.status === 'active')
        ?.value.vars
    ).toMatchObject({ catalog_inbound: { notes: 'sem cebola' } });
    expect(mocks.buttons).not.toHaveBeenCalled();
    expect(mocks.mp).not.toHaveBeenCalled();
  });
  it('blocks unsafe monetary totals before sending any catalog summary', async () => {
    active = false;
    const result = await dispatchInboundToFlows(
      input({
        kind: 'catalog_order',
        text: 'cart',
        total: 1,
        items: [
          {
            retailer_id: id,
            quantity: Number.MAX_SAFE_INTEGER,
            unit_price: 0.01,
          },
        ],
      })
    );
    expect(result.outcome).toBe('handed_off');
    expect(mocks.buttons).not.toHaveBeenCalled();
    expect(mocks.mp).not.toHaveBeenCalled();
  });
  it('grounds new carts on live catalog prices and preserves every separate line', async () => {
    active = false;
    const result = await dispatchInboundToFlows(
      input({
        kind: 'catalog_order',
        text: 'untrusted summary',
        total: 0.02,
        items: [
          { retailer_id: id, quantity: 1, unit_price: 0.01 },
          { retailer_id: id, quantity: 1, unit_price: 0.01 },
        ],
      })
    );
    expect(result.consumed).toBe(true);
    expect(mocks.catalog).toHaveBeenCalledWith(mocks.db, 'account');
    const vars = writes.find(
      (w) => w.table === 'flow_runs' && w.value.status === 'active'
    )?.value.vars as Record<string, unknown>;
    expect(vars).toMatchObject({
      catalog_order_version: 1,
      total: 29,
      observacoes: 'Nenhuma',
    });
    expect(vars.itens).toEqual(
      Array(2).fill({
        id,
        title: 'Carne',
        description: 'Carne',
        quantity: 1,
        unitPrice: 14.5,
      })
    );
    expect(vars.itens_texto).not.toBe('untrusted summary');
    expect(mocks.mp).not.toHaveBeenCalled();
  });

  it('shows the integral summary after the address without creating a checkout', async () => {
    const result = await dispatchInboundToFlows(
      input({ kind: 'text', text: 'Rua Um, 123 Centro' })
    );
    expect(result.outcome).toBe('advanced');
    expect(mocks.mp).not.toHaveBeenCalled();
    expect(mocks.buttons).toHaveBeenCalledWith(
      expect.objectContaining({
        bodyText: expect.stringContaining('Rua Um, 123 Centro'),
      })
    );
  });
  it('hands off legacy active catalog runs lacking grounded confirmation markers', async () => {
    run.vars = {
      total: 29,
      itens: [{ retailer_id: id, quantity: 2, unit_price: 14.5 }],
      tipo_entrega: 'delivery',
    };
    const result = await dispatchInboundToFlows(
      input({ kind: 'text', text: 'Rua Um, 123 Centro' })
    );
    expect(result.outcome).toBe('handed_off');
    expect(mocks.mp).not.toHaveBeenCalled();
  });
  it('passes the existing PED reference and frozen lines, persists orderId and sends a CTA', async () => {
    run.current_node_key = 'confirmar_delivery';
    (run.vars as Record<string, unknown>).endereco = 'Rua Um, 123 Centro';
    (run.vars as Record<string, unknown>).external_reference = 'PED-existing';
    const result = await dispatchInboundToFlows(
      input({
        kind: 'interactive_reply',
        reply_id: 'confirmar_pedido',
        reply_title: 'Confirmar pedido',
      })
    );
    expect(result.outcome).toBe('handed_off');
    expect(mocks.mp).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        externalReference: 'PED-existing',
        items: [
          {
            id,
            title: 'Carne',
            description: 'Carne',
            quantity: 2,
            unitPrice: 14.5,
          },
        ],
      })
    );
    expect(
      writes.some(
        (w) => (w.value.vars as Record<string, unknown>)?.order_id === 'order'
      )
    ).toBe(true);
    expect(mocks.payment).toHaveBeenCalledWith(
      expect.objectContaining({
        buttonUrl: 'https://pay.example/checkout',
        effectKey: 'flow:run-id:payment',
      })
    );
    expect(mocks.text).not.toHaveBeenCalled();
  });
  it('does not treat a negative sentence containing confirmar as confirmation', async () => {
    run.current_node_key = 'confirmar_delivery';
    await dispatchInboundToFlows(
      input({ kind: 'text', text: 'não quero confirmar pedido' })
    );
    expect(mocks.mp).not.toHaveBeenCalled();
  });
  it('preserves pickup without calling the online orchestrator', async () => {
    run.current_node_key = 'confirmar_retirada';
    (run.vars as Record<string, unknown>).tipo_entrega = 'retirada';
    mocks.pickup.mockResolvedValue({
      dealId: 'pickup-deal',
      orderId: 'pickup-order',
    });
    await dispatchInboundToFlows(
      input({
        kind: 'interactive_reply',
        reply_id: 'confirmar_pedido',
        reply_title: 'Confirmar pedido',
      })
    );
    expect(mocks.mp).not.toHaveBeenCalled();
    expect(mocks.pickup).toHaveBeenCalled();
    expect(mocks.payment).not.toHaveBeenCalled();
  });
});
