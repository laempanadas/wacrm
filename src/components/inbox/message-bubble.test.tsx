import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Message } from '@/types';
import { MessageBubble } from './message-bubble';

const url = 'https://payments.example/checkout?id=123&token=a%2Fb';
const interactivePayload = {
  type: 'cta_url',
  body: { text: 'Seu pedido está pronto.' },
  action: {
    name: 'cta_url',
    parameters: { display_text: 'Pagar pedido', url },
  },
};
const message: Message & { interactive_payload?: unknown } = {
  id: 'message-1',
  conversation_id: 'conversation-1',
  sender_type: 'bot',
  content_type: 'interactive',
  content_text: 'Seu pedido está pronto.',
  status: 'sent',
  created_at: '2026-10-11T12:00:00Z',
  interactive_payload: interactivePayload,
};
function render(overrides: Partial<typeof message> = {}) {
  return renderToStaticMarkup(
    <MessageBubble message={{ ...message, ...overrides }} />
  );
}

describe('MessageBubble payment CTA', () => {
  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'http://payments.example/pay',
    '//payments.example/pay',
    ' https://payments.example/pay',
    'https://user:password@payments.example/pay',
    'https://payments.example/pay\n',
  ])('does not render unsafe payment URL as an anchor: %s', (unsafeUrl) => {
    const html = render({
      interactive_payload: {
        ...interactivePayload,
        action: {
          name: 'cta_url',
          parameters: { display_text: 'Pagar pedido', url: unsafeUrl },
        },
      },
    });
    expect(html).not.toContain('<a');
    expect(html).toContain('Seu pedido está pronto.');
    expect(html).not.toContain('Resposta de Botão');
  });
  it.each([
    undefined,
    null,
    [],
    'bad',
    { type: 'cta_url' },
    { ...interactivePayload, action: null },
    { ...interactivePayload, body: { text: 123 } },
    {
      ...interactivePayload,
      action: { name: 'cta_url', parameters: { url, display_text: '' } },
    },
  ])(
    'tolerates missing or malformed persisted payload %#',
    (interactive_payload) => {
      const html = render({ interactive_payload });
      expect(html).not.toContain('<a');
      expect(html).toContain('Seu pedido está pronto.');
      expect(html).not.toContain('Resposta de Botão');
    }
  );
  it('escapes persisted text and does not infer a button from simulation markers or raw URLs', () => {
    const html = render({
      interactive_payload: undefined,
      content_text: `[Botão: Pagar] ${url} <script>alert(1)</script>`,
    });
    expect(html).not.toContain('<a');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
  it.each(['bot', 'agent'] as const)(
    'renders persisted outbound CTA as a real safe anchor for %s',
    (sender_type) => {
      const html = render({ sender_type });
      expect(html).toContain(`href="${url.replace('&', '&amp;')}"`);
      expect(html).toContain('target="_blank"');
      expect(html).toContain('rel="noopener noreferrer"');
      expect(html).toContain('Pagar pedido</a>');
      expect(html).toContain('Seu pedido está pronto.');
      expect(html).not.toContain('Resposta de Botão');
      expect(html).not.toContain('[Botão:');
    }
  );
  it('keeps inbound interactive replies unchanged even if they carry a CTA-shaped payload', () => {
    const html = render({
      sender_type: 'customer',
      content_text: 'Sim, confirmado',
      interactive_reply_id: 'confirm',
    });
    expect(html).toContain('Resposta de Botão');
    expect(html).toContain('Sim, confirmado');
    expect(html).not.toContain('<a');
  });
});
