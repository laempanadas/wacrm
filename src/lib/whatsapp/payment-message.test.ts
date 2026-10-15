import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendWhatsAppPaymentMessage } from './payment-message';

const NOW = new Date('2026-10-11T12:00:00Z');
const params = {
  phoneNumberId: 'phone-123',
  accessToken: 'test-token',
  toPhone: '5511999999999',
  bodyText:
    'Pedido pronto. [Botão: Pagar] https://payments.example/checkout?id=123&token=a%2Fb',
  buttonUrl: 'https://payments.example/checkout?id=123&token=a%2Fb',
  buttonText: 'Pagar pedido',
  lastCustomerMessageAt: '2026-10-11T11:00:00Z',
};
const fetchMock = vi.fn<typeof fetch>();
function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}
function payload(index = 0) {
  return JSON.parse(fetchMock.mock.calls[index][1]!.body as string);
}

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW.getTime());
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const approvedTemplate = {
  id: 'template-1',
  user_id: 'owner-1',
  name: 'payment_ready',
  category: 'Utility' as const,
  language: 'pt_BR',
  status: 'APPROVED' as const,
  body_text: 'Seu pedido está pronto. Pague pelo botão.',
  buttons: [
    { type: 'URL' as const, text: 'Pagar pedido', url: params.buttonUrl },
  ],
  created_at: '2026-10-01T12:00:00Z',
};

describe('sendWhatsAppPaymentMessage', () => {
  it('sends only a trusted approved static template with exact compatible URL outside the window', async () => {
    fetchMock.mockResolvedValue(
      response({ messages: [{ id: 'wamid.template' }] })
    );
    const input = {
      ...params,
      lastCustomerMessageAt: '2026-10-09T12:00:00Z',
      template: approvedTemplate,
    };
    const result = await sendWhatsAppPaymentMessage(input);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(payload()).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: params.toPhone,
      type: 'template',
      template: { name: 'payment_ready', language: { code: 'pt_BR' } },
    });
    expect(result).toEqual({
      messageId: 'wamid.template',
      contentType: 'template',
      formattedText: approvedTemplate.body_text,
    });
  });
  it.each([
    { status: 'PENDING' },
    {
      buttons: [
        { type: 'URL', text: 'Pagar', url: 'https://wrong.example/pay' },
      ],
    },
    {
      buttons: [
        { type: 'URL', text: 'Pagar', url: 'https://payments.example/{{1}}' },
      ],
    },
    { body_text: 'Pague {{1}}' },
    { header_type: 'image' },
    { language: undefined },
  ])(
    'blocks unapproved or unsupported template configuration outside window: %j',
    async (overrides) => {
      const input = {
        ...params,
        lastCustomerMessageAt: '2026-10-09T12:00:00Z',
        template: {
          ...approvedTemplate,
          ...overrides,
        } as typeof approvedTemplate,
      };
      await expect(sendWhatsAppPaymentMessage(input)).rejects.toThrow(
        /template/i
      );
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );
  it('never falls back to text after template rejection', async () => {
    fetchMock.mockResolvedValue(
      response(
        { error: { code: 131051, message: 'Unsupported message type' } },
        400
      )
    );
    const input = {
      ...params,
      lastCustomerMessageAt: '2026-10-09T12:00:00Z',
      template: approvedTemplate,
    };
    await expect(sendWhatsAppPaymentMessage(input)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('falls back exactly once on definitive 400 CTA unsupported rejection, with explicit unmodified link', async () => {
    fetchMock.mockResolvedValueOnce(
      response(
        {
          error: { code: 100, message: 'Unsupported interactive type cta_url' },
        },
        400
      )
    );
    fetchMock.mockResolvedValueOnce(
      response({ messages: [{ id: 'wamid.text' }] })
    );
    const result = await sendWhatsAppPaymentMessage(params);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(payload(1)).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: params.toPhone,
      type: 'text',
      text: {
        body: `Pedido pronto.\n\n${params.buttonUrl}`,
        preview_url: false,
      },
    });
    expect(result).toEqual({
      messageId: 'wamid.text',
      contentType: 'text',
      formattedText: `Pedido pronto.\n\n${params.buttonUrl}`,
    });
  });
  it.each([
    response(
      {
        error: {
          code: 100,
          message: 'Outside customer service window; unsupported cta_url',
        },
      },
      400
    ),
    response(
      { messages: {}, error: { code: 100, message: 'Unsupported cta_url' } },
      400
    ),
    response({ error: { code: 100, message: 'Invalid access token' } }, 400),
    response(
      {
        error: {
          code: 131047,
          message: 'Re-engagement outside window; unsupported cta_url',
        },
      },
      400
    ),
    response(
      { error: { code: 131051, message: 'Unsupported message type' } },
      500
    ),
    response({ error: { code: 100, message: 'Unsupported cta_url' } }, 429),
    response(
      {
        error: {
          code: 100,
          message: 'Unsupported cta_url',
          is_transient: true,
        },
      },
      400
    ),
    response({ messages: [] }),
    response({ messages: [{ id: '' }] }),
    response(
      {
        messages: [{ id: 'wamid.accepted' }],
        error: { code: 100, message: 'Unsupported cta_url' },
      },
      400
    ),
    new Response('invalid json', { status: 400 }),
  ])(
    'never retries ambiguous, accepted, window, or unrelated errors %#',
    async (res) => {
      fetchMock.mockResolvedValue(res);
      await expect(sendWhatsAppPaymentMessage(params)).rejects.toThrow();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  );
  it.each([new Error('timeout'), new TypeError('network failed')])(
    'never retries network failure: %s',
    async (err) => {
      fetchMock.mockRejectedValue(err);
      await expect(sendWhatsAppPaymentMessage(params)).rejects.toThrow();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  );
  it.each([
    { buttonUrl: 'javascript:alert(1)' },
    { buttonUrl: 'http://payments.example/pay' },
    { buttonUrl: ' https://payments.example/pay' },
    { buttonUrl: 'https://user:password@payments.example/pay' },
    { buttonText: 'a'.repeat(21) },
    { buttonText: '' },
    { bodyText: 'a'.repeat(1025) },
  ])('rejects invalid CTA fields without network: %j', async (overrides) => {
    await expect(
      sendWhatsAppPaymentMessage({ ...params, ...overrides })
    ).rejects.toThrow(/URL|button|body/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('uses a clean default body and button when only a link and marker were provided', async () => {
    fetchMock.mockResolvedValue(
      response({ messages: [{ id: 'wamid.default' }] })
    );
    await sendWhatsAppPaymentMessage({
      ...params,
      bodyText: `[Botão: Pagar] ${params.buttonUrl}`,
      buttonText: undefined,
    });
    expect(payload().interactive.body.text).toBe(
      'Clique no botão abaixo para realizar o pagamento.'
    );
    expect(payload().interactive.action.parameters.display_text).toBe(
      'Pagar pedido'
    );
  });
  it.each([
    '2026-10-10T12:00:00Z',
    '2026-10-09T12:00:00Z',
    '2026-10-11T12:00:01Z',
    '2026-10-11T11:00:00',
    '2026-10-11',
    'not-a-date',
    '',
  ])(
    'blocks closed or untrustworthy windows before sending: %s',
    async (lastCustomerMessageAt) => {
      await expect(
        sendWhatsAppPaymentMessage({ ...params, lastCustomerMessageAt })
      ).rejects.toThrow(/window|timestamp/i);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );
  it('sends a native v21 CTA with clean body and preserves the exact HTTPS URL', async () => {
    fetchMock.mockResolvedValue(response({ messages: [{ id: 'wamid.cta' }] }));
    const result = await sendWhatsAppPaymentMessage(params);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://graph.facebook.com/v21.0/phone-123/messages'
    );
    expect(payload()).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: params.toPhone,
      type: 'interactive',
      interactive: {
        type: 'cta_url',
        body: { text: 'Pedido pronto.' },
        action: {
          name: 'cta_url',
          parameters: { display_text: 'Pagar pedido', url: params.buttonUrl },
        },
      },
    });
    expect(result).toEqual({
      messageId: 'wamid.cta',
      contentType: 'interactive',
      formattedText: 'Pedido pronto.',
      interactivePayload: payload().interactive,
    });
  });
});
