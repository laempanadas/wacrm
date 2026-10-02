import { describe, it, expect } from 'vitest'
import { PIPELINE_STAGES, STAGE_TO_ORDER_STATUS } from './pipeline-stages'

describe('pipeline-stages', () => {
  describe('stage constants', () => {
    it('should have all required stages', () => {
      expect(PIPELINE_STAGES.NEW_ORDER).toBe('Novo Pedido')
      expect(PIPELINE_STAGES.COOKING).toBe('Na Cozinha')
      expect(PIPELINE_STAGES.READY).toBe('Pronto para Entrega')
      expect(PIPELINE_STAGES.DELIVERED).toBe('Entregue')
      expect(PIPELINE_STAGES.PAID).toBe('Pago')
    })
  })

  describe('stage to order status mapping', () => {
    it('should map "Novo Pedido" to "pending"', () => {
      expect(STAGE_TO_ORDER_STATUS[PIPELINE_STAGES.NEW_ORDER]).toBe('pending')
    })

    it('should map "Na Cozinha" to "payment_approved"', () => {
      expect(STAGE_TO_ORDER_STATUS[PIPELINE_STAGES.COOKING]).toBe('payment_approved')
    })

    it('should map "Pronto para Entrega" to "ready"', () => {
      expect(STAGE_TO_ORDER_STATUS[PIPELINE_STAGES.READY]).toBe('ready')
    })

    it('should map "Entregue" to "delivered"', () => {
      expect(STAGE_TO_ORDER_STATUS[PIPELINE_STAGES.DELIVERED]).toBe('delivered')
    })

    it('should map "Pago" to "paid"', () => {
      expect(STAGE_TO_ORDER_STATUS[PIPELINE_STAGES.PAID]).toBe('paid')
    })

    it('should have all stages mapped', () => {
      for (const stage of Object.values(PIPELINE_STAGES)) {
        expect(STAGE_TO_ORDER_STATUS).toHaveProperty(stage)
      }
    })
  })
})
