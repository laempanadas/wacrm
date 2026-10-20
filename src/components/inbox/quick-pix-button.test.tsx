import type { ReactElement, ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (initial: unknown) => [initial, vi.fn()],
  useMemo: (compute: () => unknown) => compute(),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
import { QuickPixButton } from './quick-pix-button';
import type { Contact, Message } from '@/types';

type Element = ReactElement<{
  children?: ReactNode;
  onClick?: () => Promise<void>;
}>;
function text(node: ReactNode): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(text).join('');
  return node && typeof node === 'object' && 'props' in node
    ? text((node as Element).props.children)
    : '';
}
function generate(node: ReactNode): (() => Promise<void>) | undefined {
  if (Array.isArray(node)) return node.map(generate).find(Boolean);
  if (!node || typeof node !== 'object' || !('props' in node)) return;
  const element = node as Element;
  if (element.props.onClick && text(node).includes('Gerar e Enviar'))
    return element.props.onClick;
  return generate(element.props.children);
}
afterEach(() => vi.unstubAllGlobals());
it('keeps full cart description in the payment snapshot even when the display title is shortened', async () => {
  const description = `• 2x ${'Empanada especial '.repeat(15)}`.trim();
  const fetch = vi
    .fn()
    .mockResolvedValue(
      Response.json({ paymentUrl: 'https://example.invalid/payment' })
    );
  vi.stubGlobal('fetch', fetch);
  const tree = QuickPixButton({
    conversationId: 'conversation',
    contact: { id: 'contact' } as Contact,
    messages: [{ content_text: `${description}\nTotal: R$ 28,00` } as Message],
    onSend: vi.fn(),
  });
  const send = generate(tree);
  expect(send).toBeTypeOf('function');
  await send!();
  const body = JSON.parse(fetch.mock.calls[0][1].body);
  expect(body.items[0].description).toBe(description);
  expect(body.items[0].title.length).toBeLessThanOrEqual(120);
});
