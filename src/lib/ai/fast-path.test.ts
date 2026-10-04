import { describe, it, expect } from 'vitest'
import { checkZeroTokenMatch } from './fast-path'

describe('fast-path zero-token matcher', () => {
  describe('Status/Atendimento patterns', () => {
    it('should match "estao atendendo"', () => {
      const result = checkZeroTokenMatch('Estão atendendo?')
      expect(result.matched).toBe(true)
      expect(result.response).toContain('La Empanadas Argentinas')
    })

    it('should match "ola"', () => {
      const result = checkZeroTokenMatch('Olá')
      expect(result.matched).toBe(true)
      expect(result.response).toContain('La Empanadas Argentinas')
    })

    it('should match "boa noite"', () => {
      const result = checkZeroTokenMatch('boa noite')
      expect(result.matched).toBe(true)
      expect(result.response).toContain('cardápio')
    })

    it('should match "aberto" with normalization', () => {
      const result = checkZeroTokenMatch('Está aberto agora?')
      expect(result.matched).toBe(true)
    })
  })

  describe('Cardápio/Menu patterns', () => {
    it('should match "cardapio"', () => {
      const result = checkZeroTokenMatch('Qual é o cardápio?')
      expect(result.matched).toBe(true)
      expect(result.response).toContain('cardápio')
    })

    it('should match "menu"', () => {
      const result = checkZeroTokenMatch('Qual o menu?')
      expect(result.matched).toBe(true)
      expect(result.response).toContain('cardápio')
    })

    it('should match "sabores"', () => {
      const result = checkZeroTokenMatch('Quais são os sabores?')
      expect(result.matched).toBe(true)
    })

    it('should match "empanad"', () => {
      const result = checkZeroTokenMatch('Vocês vendem empanada?')
      expect(result.matched).toBe(true)
    })
  })

  describe('Pagamento/Pix patterns', () => {
    it('should match "pix"', () => {
      const result = checkZeroTokenMatch('Vocês aceitam Pix?')
      expect(result.matched).toBe(true)
      expect(result.response).toContain('Pix')
    })

    it('should match "chave pix"', () => {
      const result = checkZeroTokenMatch('Qual a chave pix?')
      expect(result.matched).toBe(true)
    })

    it('should match "como pago"', () => {
      const result = checkZeroTokenMatch('Como pago?')
      expect(result.matched).toBe(true)
      expect(result.response).toContain('Pagamento')
    })

    it('should match "cartao"', () => {
      const result = checkZeroTokenMatch('Vocês aceitam cartão?')
      expect(result.matched).toBe(true)
    })

    it('should match "mercado pago"', () => {
      const result = checkZeroTokenMatch('Vocês usam Mercado Pago?')
      expect(result.matched).toBe(true)
    })
  })

  describe('Horário patterns', () => {
    it('should match "horario"', () => {
      const result = checkZeroTokenMatch('Qual o horário?')
      expect(result.matched).toBe(true)
      expect(result.response).toContain('Horário')
    })

    it('should match "que horas fecha"', () => {
      const result = checkZeroTokenMatch('Que horas que vocês fecham?')
      expect(result.matched).toBe(true)
    })

    it('should match "funciona ate"', () => {
      const result = checkZeroTokenMatch('Funciona até que horas?')
      expect(result.matched).toBe(true)
    })
  })

  describe('No match cases', () => {
    it('should not match arbitrary messages', () => {
      const result = checkZeroTokenMatch('Eu quero 2 empanadas de carne com queijo')
      expect(result.matched).toBe(false)
      expect(result.response).toBeNull()
    })

    it('should not match orders even if they start with greetings', () => {
      expect(checkZeroTokenMatch('boa noite, quero 2 de carne e 1 de queijo').matched).toBe(false)
      expect(checkZeroTokenMatch('oi, manda 2 carne e 1 coca zero').matched).toBe(false)
      expect(checkZeroTokenMatch('ola me ve 3 calabresa').matched).toBe(false)
      expect(checkZeroTokenMatch('2 carne, 2 calabresa, 1 coca zero lata').matched).toBe(false)
    })

    it('should not match empty string', () => {
      const result = checkZeroTokenMatch('')
      expect(result.matched).toBe(false)
      expect(result.response).toBeNull()
    })

    it('should not match whitespace only', () => {
      const result = checkZeroTokenMatch('   ')
      expect(result.matched).toBe(false)
    })
  })

  describe('Diacritics normalization', () => {
    it('should match with accents and diacritics', () => {
      const result = checkZeroTokenMatch('Estão atendendo?')
      expect(result.matched).toBe(true)
    })

    it('should match "cardápio" without accent', () => {
      const result = checkZeroTokenMatch('Qual o cardapio?')
      expect(result.matched).toBe(true)
    })

    it('should match "horário" regardless of accents', () => {
      const result = checkZeroTokenMatch('qual horario voces funcionam')
      expect(result.matched).toBe(true)
    })
  })
})
