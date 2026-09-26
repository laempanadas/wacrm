import { describe, it, expect } from 'vitest'
import { shouldAttemptAiReply } from './route'

describe('shouldAttemptAiReply', () => {
  it('returns false for empty text', () => {
    expect(
      shouldAttemptAiReply({
        flowConsumed: false,
        interactiveReplyId: null,
        inboundText: '   ',
      }),
    ).toBe(false)
  })

  it('returns false for interactive reply', () => {
    expect(
      shouldAttemptAiReply({
        flowConsumed: false,
        interactiveReplyId: 'button-1',
        inboundText: 'Oi',
      }),
    ).toBe(false)
  })

  it('returns true when the flow did not consume a normal text message', () => {
    expect(
      shouldAttemptAiReply({
        flowConsumed: false,
        interactiveReplyId: null,
        inboundText: 'Olá, quero fazer um pedido',
      }),
    ).toBe(true)
  })

  it('returns true when the flow ended in no_match', () => {
    expect(
      shouldAttemptAiReply({
        flowConsumed: true,
        outcome: 'no_match',
        interactiveReplyId: null,
        inboundText: 'Quero saber o preço',
      }),
    ).toBe(true)
  })

  it('returns false when the flow already handled the message', () => {
    expect(
      shouldAttemptAiReply({
        flowConsumed: true,
        outcome: 'advanced',
        interactiveReplyId: null,
        inboundText: 'Quero saber o preço',
      }),
    ).toBe(false)
  })
})
