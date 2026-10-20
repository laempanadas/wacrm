import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const sendMocks = vi.hoisted(() => ({
  text: vi.fn(async () => ({ messageId: 'wamid.out' })),
  template: vi.fn(async () => ({ messageId: 'wamid.template' })),
  media: vi.fn(async () => ({ messageId: 'wamid.media' })),
  adminFrom: vi.fn(),
}));
vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTextMessage: sendMocks.text,
  sendTemplateMessage: sendMocks.template,
  sendMediaMessage: sendMocks.media,
}));
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: () => 'test-only-token',
  encrypt: () => 'encrypted',
  isLegacyFormat: () => false,
}));
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({ from: sendMocks.adminFrom }),
}));

import {
  sendMessageToConversation,
  SendMessageError,
  type SendMessageParams,
} from './send-message';

// A db that explodes if touched — these tests cover the param
// validation that MUST short-circuit before any query runs.
function noDb(): SupabaseClient {
  return {
    from() {
      throw new Error('db should not be queried for invalid params');
    },
  } as unknown as SupabaseClient;
}

async function expectSendError(
  params: SendMessageParams,
  status: number,
  messageMatch?: RegExp
) {
  await expect(
    sendMessageToConversation(noDb(), 'acct-1', params)
  ).rejects.toBeInstanceOf(SendMessageError);
  await sendMessageToConversation(noDb(), 'acct-1', params).catch(
    (e: SendMessageError) => {
      expect(e.status).toBe(status);
      if (messageMatch) expect(e.message).toMatch(messageMatch);
    }
  );
}

describe('sendMessageToConversation — param validation (pre-DB)', () => {
  const base = { conversationId: 'cv-1' };

  it('requires conversation_id and message_type', async () => {
    await expectSendError({ conversationId: '', messageType: 'text' }, 400);
    await expectSendError({ conversationId: 'cv-1', messageType: '' }, 400);
  });

  it('rejects an unsupported message_type', async () => {
    await expectSendError(
      { ...base, messageType: 'carrier-pigeon' },
      400,
      /Unsupported message_type/
    );
  });

  it('requires content_text for text messages', async () => {
    await expectSendError(
      { ...base, messageType: 'text' },
      400,
      /content_text is required/
    );
  });

  it('requires template_name for template messages', async () => {
    await expectSendError(
      { ...base, messageType: 'template' },
      400,
      /template_name is required/
    );
  });

  it('requires media_url for media kinds', async () => {
    for (const kind of ['image', 'video', 'document', 'audio']) {
      await expectSendError(
        { ...base, messageType: kind },
        400,
        /media_url is required/
      );
    }
  });

  it('rejects an over-long media caption (non-audio)', async () => {
    await expectSendError(
      {
        ...base,
        messageType: 'image',
        mediaUrl: 'https://x/y.jpg',
        contentText: 'a'.repeat(1025),
      },
      400,
      /1024-character limit/
    );
  });

  it('allows a long "caption" on audio (audio carries none) — so it reaches the DB', async () => {
    // Audio is exempt from the caption cap, so validation passes and we
    // proceed to the conversation lookup — proven by the stub throwing.
    const spy = vi.fn(() => {
      throw new Error('reached DB');
    });
    const db = { from: spy } as unknown as SupabaseClient;
    await expect(
      sendMessageToConversation(db, 'acct-1', {
        ...base,
        messageType: 'audio',
        mediaUrl: 'https://x/y.ogg',
        contentText: 'a'.repeat(2000),
      })
    ).rejects.toThrow('reached DB');
    expect(spy).toHaveBeenCalledWith('conversations');
  });
});

describe('SendMessageError', () => {
  it('carries a machine code and an HTTP status', () => {
    const e = new SendMessageError('meta_error', 'boom', 502);
    expect(e.code).toBe('meta_error');
    expect(e.status).toBe(502);
    expect(e).toBeInstanceOf(Error);
  });
});

describe('manual send ownership and last customer session', () => {
  function fixture(inbound: string | null, inboundError: unknown = null) {
    const updates: Array<{ table: string; value: Record<string, unknown> }> =
      [];
    const queries: Array<{ table: string; filters: Array<[string, unknown]> }> =
      [];
    const from = (table: string) => {
      let inserting = false;
      const filters: Array<[string, unknown]> = [];
      queries.push({ table, filters });
      const result = () => ({ data: null, error: null });
      const q = {
        select: () => q,
        eq: (key: string, value: unknown) => (filters.push([key, value]), q),
        order: () => q,
        limit: () => q,
        insert: () => ((inserting = true), q),
        update: (value: Record<string, unknown>) => (
          updates.push({ table, value }),
          q
        ),
        single: async () => ({
          data:
            table === 'conversations'
              ? {
                  id: 'cv-1',
                  last_message_at: new Date().toISOString(),
                  contact: { id: 'contact', phone: '5511999999999' },
                }
              : table === 'whatsapp_config'
                ? { phone_number_id: 'phone', access_token: 'encrypted' }
                : inserting
                  ? { id: 'outbound' }
                  : null,
          error: null,
        }),
        maybeSingle: async () => ({
          data:
            table === 'messages' && inbound ? { created_at: inbound } : null,
          error: table === 'messages' ? inboundError : null,
        }),
        then: (resolve: (r: ReturnType<typeof result>) => unknown) =>
          Promise.resolve(result()).then(resolve),
      };
      return q;
    };
    sendMocks.adminFrom.mockImplementation(from);
    return { db: { from } as unknown as SupabaseClient, updates, queries };
  }

  it('marks a successful human send and pauses active runs for 30 minutes', async () => {
    const started = Date.now();
    const f = fixture(new Date(started - 1000).toISOString());
    await sendMessageToConversation(f.db, 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'text',
      contentText: 'Olá',
    });
    const update = f.updates.find((r) => r.table === 'conversations')!.value;
    expect(update).toMatchObject({
      ai_autoreply_disabled: true,
      bot_pause_reason: 'human_active',
    });
    expect(Date.parse(String(update.bot_paused_at))).toBeGreaterThanOrEqual(
      started
    );
    expect(
      Date.parse(String(update.bot_resume_after)) -
        Date.parse(String(update.bot_paused_at))
    ).toBe(30 * 60 * 1000);
    expect(update.last_agent_message_at).toBe(update.bot_paused_at);
    expect(f.updates).toContainEqual({
      table: 'flow_runs',
      value: expect.objectContaining({
        status: 'paused_by_agent',
        end_reason: 'agent_replied',
      }),
    });
    expect(f.queries.find((q) => q.table === 'messages')!.filters).toEqual([
      ['conversation_id', 'cv-1'],
      ['sender_type', 'customer'],
    ]);
  });
  it('does not reopen an expired customer session with recent outbound activity', async () => {
    const f = fixture(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
    await expect(
      sendMessageToConversation(f.db, 'acct-1', {
        conversationId: 'cv-1',
        messageType: 'text',
        contentText: 'Hi',
      })
    ).rejects.toMatchObject({ code: 'session_expired', status: 409 });
    expect(sendMocks.text).not.toHaveBeenCalled();
  });
  it('allows an approved template without customer history', async () => {
    const f = fixture(null);
    await expect(
      sendMessageToConversation(f.db, 'acct-1', {
        conversationId: 'cv-1',
        messageType: 'template',
        templateName: 'welcome',
      })
    ).resolves.toMatchObject({ whatsappMessageId: 'wamid.template' });
    expect(sendMocks.template).toHaveBeenCalled();
  });
  it('fails closed when customer history cannot be read', async () => {
    const f = fixture(null, { code: '08006' });
    await expect(
      sendMessageToConversation(f.db, 'acct-1', {
        conversationId: 'cv-1',
        messageType: 'text',
        contentText: 'Hi',
      })
    ).rejects.toMatchObject({ code: 'db_error', status: 500 });
    expect(sendMocks.text).not.toHaveBeenCalled();
  });
});

describe('server-side customer session gate', () => {
  it.each(['text', 'image', 'audio', 'video', 'document'])(
    'rejects %s without a customer session before touching Meta config',
    async (messageType) => {
      const conversation = { id: 'cv-1', contact: { phone: '5511999999999' } };
      const from = vi.fn((table: string) => {
        const q = {
          select: () => q,
          eq: () => q,
          order: () => q,
          limit: () => q,
          single: async () => ({ data: conversation, error: null }),
          maybeSingle: async () => ({ data: null, error: null }),
        };
        if (!['conversations', 'messages'].includes(table))
          throw new Error('must gate before config');
        return q;
      });
      await expect(
        sendMessageToConversation(
          { from } as unknown as SupabaseClient,
          'acct-1',
          {
            conversationId: 'cv-1',
            messageType,
            contentText: 'Hi',
            mediaUrl: 'https://example.invalid/a',
          }
        )
      ).rejects.toMatchObject({ code: 'session_expired', status: 409 });
    }
  );
});
