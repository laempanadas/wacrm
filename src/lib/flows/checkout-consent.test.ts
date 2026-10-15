import { describe, expect, it, vi } from 'vitest';
vi.mock('./admin-client', () => ({ supabaseAdmin: vi.fn() }));
import { confirmFlowCheckout, finishFlowCheckout } from './checkout-consent';
import type { FlowRunRow } from './types';
describe('checkout consent helper', () => {
  it.each([undefined, '', 'summary-A'])(
    'rejects interactive context %s before any RPC for summary B',
    async (context) => {
      const run = {
        id: 'run',
        account_id: 'account',
        vars: {},
        consent_prompt_message: 'summary-B',
      } as FlowRunRow;
      const rpc = vi.fn();
      expect(
        await confirmFlowCheckout({ rpc } as never, run, {
          kind: 'interactive_reply',
          reply_id: 'confirmar_pedido',
          meta_message_id: 'click',
          context_message_id: context,
        })
      ).toBe(false);
      expect(rpc).not.toHaveBeenCalled();
    }
  );
  it('passes the exact Meta context to the locking RPC and respects a rejected stale snapshot', async () => {
    const run = {
      id: 'run',
      account_id: 'account',
      vars: { total: 29 },
      consent_revision: 2,
      consent_prompt_message: 'summary-B',
    } as unknown as FlowRunRow;
    const rpc = vi.fn().mockResolvedValue({ data: [], error: null });
    expect(
      await confirmFlowCheckout({ rpc } as never, run, {
        kind: 'interactive_reply',
        reply_id: 'confirmar_pedido',
        meta_message_id: 'click-B',
        context_message_id: 'summary-B',
      })
    ).toBe(false);
    expect(rpc).toHaveBeenCalledWith('flow_checkout_confirm', {
      p_account_id: 'account',
      p_run_id: 'run',
      p_revision: 2,
      p_snapshot: { total: 29 },
      p_inbound_message: 'click-B',
      p_kind: 'interactive_reply',
      p_reply: 'confirmar_pedido',
      p_context_message: 'summary-B',
    });
    expect(run.vars).toEqual({ total: 29 });
  });
  it.each(['confirmar', 'confirmar pedido', 'sim', 'confirmo'])(
    'preserves supported text confirmation %s without interactive context',
    async (text) => {
      const run = { id: 'run', account_id: 'account', vars: {} } as FlowRunRow;
      const rpc = vi.fn().mockResolvedValue({
        data: [{ ...run, consent_inbound_message: 'text-confirm' }],
        error: null,
      });
      expect(
        await confirmFlowCheckout({ rpc } as never, run, {
          kind: 'text',
          text,
          meta_message_id: 'text-confirm',
        })
      ).toBe(true);
      expect(rpc).toHaveBeenCalledWith(
        'flow_checkout_confirm',
        expect.objectContaining({
          p_kind: 'text',
          p_reply: text,
          p_context_message: null,
        })
      );
    }
  );
  it('refreshes the database snapshot and revision after finish', async () => {
    const run = {
      id: 'run',
      account_id: 'account',
      vars: { total: 29 },
      consent_revision: 2,
    } as unknown as FlowRunRow;
    const rpc = vi.fn().mockResolvedValue({
      error: null,
      data: [
        {
          owned: true,
          vars: { total: 29, order_id: 'order' },
          consent_revision: 3,
        },
      ],
    });
    expect(
      await finishFlowCheckout(
        { rpc } as never,
        run,
        'claim',
        { order_id: 'order' },
        true
      )
    ).toBe(true);
    expect(run.consent_revision).toBe(3);
    expect(run.vars).toEqual({ total: 29, order_id: 'order' });
  });
  it('does not overwrite local correction with evidence after ownership is lost', async () => {
    const run = {
      id: 'run',
      account_id: 'account',
      vars: { pedido_confirmado: 'false' },
      consent_revision: 4,
    } as unknown as FlowRunRow;
    const rpc = vi.fn().mockResolvedValue({
      error: null,
      data: [
        {
          owned: false,
          vars: { pedido_confirmado: 'false' },
          consent_revision: 4,
        },
      ],
    });
    expect(
      await finishFlowCheckout(
        { rpc } as never,
        run,
        'claim',
        { order_id: 'order' },
        true
      )
    ).toBe(false);
    expect(run.vars).toEqual({ pedido_confirmado: 'false' });
  });
});
