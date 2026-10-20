import { describe, expect, it } from 'vitest';
import { shouldStartNewDraft } from './draft-lifecycle';
import type { OrderDraft } from './order-draft';

const now = Date.parse('2026-10-18T12:00:00Z');
const draft: OrderDraft = {
  id: 'old',
  version: 2,
  items: [
    { id: 'carne', title: 'Carne', quantity: 2, unitPrice: 14, totalPrice: 28 },
  ],
  unresolved: [],
  stage: 'payment_created',
  total: 28,
};
describe('new order versus old draft', () => {
  it('starts a fresh draft for a clear new order after the prior payment settled', () => {
    expect(shouldStartNewDraft(draft, 'Quero 3 carne', 'paid', now, now)).toBe(
      true
    );
  });
  it.each([
    'Oi',
    'Alô ??',
    'Pix feito',
    'Pode confirmar ?',
    'Já pageui',
    'Falar com atendente',
    'E 5 de carne',
    'quero alterar o pedido',
  ])('never resets for a followup: %s', (text) => {
    expect(
      shouldStartNewDraft(draft, text, 'paid', now - 48 * 3600000, now)
    ).toBe(false);
  });
  it('does not discard an open payment for a bare repeat purchase intent', () => {
    expect(
      shouldStartNewDraft(
        draft,
        'Quero 3 carne',
        'pending',
        now - 48 * 3600000,
        now
      )
    ).toBe(false);
  });
  it('allows an explicitly separate order without cancelling the prior pending one', () => {
    expect(
      shouldStartNewDraft(
        draft,
        'Novo pedido: quero 3 carne',
        'pending',
        now,
        now
      )
    ).toBe(true);
  });
  it.each(['checkout_processing', 'checkout_uncertain'])(
    'never rotates uncertain payment %s',
    (status) => {
      expect(
        shouldStartNewDraft(
          draft,
          'Novo pedido: quero 3 carne',
          status,
          now - 48 * 3600000,
          now
        )
      ).toBe(false);
    }
  );
  it('expires an uncharged draft based on material cart activity, not greetings', () => {
    const collecting = { ...draft, stage: 'awaiting_address' as const };
    expect(
      shouldStartNewDraft(
        collecting,
        'Quero 3 carne',
        null,
        now - 25 * 3600000,
        now
      )
    ).toBe(true);
    expect(
      shouldStartNewDraft(
        collecting,
        'Quero 3 carne',
        null,
        now - 1 * 3600000,
        now
      )
    ).toBe(false);
  });
});
