import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  handleConversationHandoff,
  isHumanRequest,
  sendHandoffNotice,
} from './handoff';

function fixture(decision: Record<string, unknown>) {
  const rpc = vi.fn(async () => ({ data: decision, error: null }));
  const send = vi.fn(async () => undefined);
  return {
    rpc,
    send,
    input: {
      db: { rpc } as unknown as SupabaseClient,
      accountId: 'account',
      conversationId: 'conversation',
      contactId: 'contact',
      text: 'Oi',
      messageId: 'wamid-1',
      send,
    },
  };
}

describe('durable conversation handoff', () => {
  it('does not repeat an episode notice after a successful or ambiguous send', async () => {
    const reserved = new Set<string>();
    const db = {
      from: () => ({
        insert: async (row: { effect_key: string }) => {
          if (reserved.has(row.effect_key)) return { error: { code: '23505' } };
          reserved.add(row.effect_key);
          return { error: null };
        },
        update: () => {
          const q = {
            eq: () => q,
            then: (resolve: (value: unknown) => unknown) =>
              Promise.resolve({ error: null }).then(resolve),
          };
          return q;
        },
      }),
    } as unknown as SupabaseClient;
    const send = vi.fn(async () => undefined);
    await sendHandoffNotice(db, 'account', 'conv', 'episode1', 'waiting', send);
    await sendHandoffNotice(db, 'account', 'conv', 'episode1', 'waiting', send);
    expect(send).toHaveBeenCalledTimes(1);
    send.mockRejectedValueOnce(new Error('ambiguous Meta response'));
    await expect(
      sendHandoffNotice(db, 'account', 'conv', 'episode2', 'waiting', send)
    ).rejects.toThrow('ambiguous');
    await sendHandoffNotice(db, 'account', 'conv', 'episode2', 'waiting', send);
    expect(send).toHaveBeenCalledTimes(2);
  });
  it.each([
    'Falar com atendente',
    'Quero falar com um atendente',
    'atendente por favor',
  ])('recognizes explicit human request: %s', (text) => {
    expect(isHumanRequest(text)).toBe(true);
  });
  it.each(['Oi', 'Alô ??', 'Pix feito', '2 carne'])(
    'does not classify %s as human request',
    (text) => {
      expect(isHumanRequest(text)).toBe(false);
    }
  );
  it.each(['Oi', 'Alô', 'Pix feito', 'Falar com atendente'])(
    'acknowledges a paused %s without a payment CTA',
    async (text) => {
      const f = fixture({
        blocked: true,
        episode_id: 'episode-1',
        notice: 'waiting',
      });
      expect(await handleConversationHandoff({ ...f.input, text })).toBe(true);
      expect(f.send).toHaveBeenCalledWith(
        'handoff:episode-1:waiting',
        'Um atendente já vai te responder.'
      );
      expect(f.rpc).toHaveBeenCalledWith(
        'handle_conversation_handoff',
        expect.objectContaining({
          p_account_id: 'account',
          p_conversation_id: 'conversation',
          p_contact_id: 'contact',
          p_request: text === 'Falar com atendente',
        })
      );
    }
  );
  it('leaves unpaused traffic to the order flow', async () => {
    const f = fixture({ blocked: false });
    expect(await handleConversationHandoff(f.input)).toBe(false);
    expect(f.send).not.toHaveBeenCalled();
  });
  it('offers resumption after human inactivity without silently charging', async () => {
    const f = fixture({
      blocked: true,
      episode_id: 'episode-1',
      notice: 'resume',
    });
    expect(await handleConversationHandoff(f.input)).toBe(true);
    expect(f.send).toHaveBeenCalledWith(
      'handoff:episode-1:resume',
      'Ainda não consegui um atendente. Posso continuar seu pedido por aqui? Responda CONTINUAR COM O BOT.'
    );
  });
  it('passes explicit resume consent to the locked policy', async () => {
    const f = fixture({ blocked: false });
    await handleConversationHandoff({
      ...f.input,
      text: 'Continuar com o bot',
    });
    expect(f.rpc).toHaveBeenCalledWith(
      'handle_conversation_handoff',
      expect.objectContaining({ p_resume: true })
    );
  });
  it('fails closed when handoff persistence fails', async () => {
    const f = fixture({ blocked: false });
    f.rpc.mockResolvedValueOnce({
      data: null as never,
      error: { message: 'db unavailable' } as never,
    });
    await expect(handleConversationHandoff(f.input)).rejects.toThrow(
      'db unavailable'
    );
    expect(f.send).not.toHaveBeenCalled();
  });
});
