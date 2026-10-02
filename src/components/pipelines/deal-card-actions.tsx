'use client'

import { useState, useRef, useEffect } from 'react'
import { MoreHorizontal, Loader2, ChevronRight, Trash2 } from 'lucide-react'
import { useDealStageMovement } from '@/hooks/use-deal-stage-movement'
import { toast } from 'sonner'
import type { Deal, PipelineStage } from '@/types'

interface DealCardActionsProps {
  deal: Deal
  currentStage: PipelineStage | null
  allStages: PipelineStage[]
  onDealUpdated?: () => void
}

/**
 * Menu de ações para movimentar deals entre stages.
 * Usa dropdown simples em vez de Base UI Menu para evitar error #31.
 */
export function DealCardActions({
  deal,
  currentStage,
  allStages,
  onDealUpdated,
}: DealCardActionsProps) {
  const [isOpen, setIsOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const { moveDealToStage, isLoading } = useDealStageMovement()

  // Fechar menu ao clicar fora
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isOpen])

  // Stages disponíveis para movimento (apenas para frente)
  const nextStages = allStages.filter(
    (s) => currentStage && s.position > currentStage.position
  )

  // Se o deal está em "Entregue" (final) ou não há próximos stages, não mostra menu
  if (!nextStages.length || !currentStage) {
    return null
  }

  const handleMoveToStage = async (stageName: string) => {
    try {
      await moveDealToStage(deal.id, stageName)
      setIsOpen(false)
      onDealUpdated?.()
    } catch {
      // Erro já é tratado no hook e exibido via toast
    }
  }

  const handleDelete = () => {
    toast.info('Deleção de pedido ainda não implementada')
    setIsOpen(false)
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          setIsOpen(!isOpen)
        }}
        className="inline-flex items-center justify-center h-6 w-6 p-0 rounded-md text-muted-foreground hover:bg-primary/10 transition-colors focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
        title="Ações do pedido"
        disabled={isLoading}
      >
        {isLoading ? (
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
        ) : (
          <MoreHorizontal className="h-4 w-4" />
        )}
      </button>

      {/* Dropdown Menu - Simple implementation without Base UI */}
      {isOpen && (
        <div
          ref={menuRef}
          className="absolute right-0 top-8 z-50 bg-popover rounded-lg shadow-lg border border-border p-1 min-w-[200px]"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Mover para stages */}
          <div className="space-y-0.5">
            {nextStages.map((stage) => (
              <button
                key={stage.id}
                type="button"
                onClick={() => handleMoveToStage(stage.name)}
                disabled={isLoading}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-foreground hover:bg-muted rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-left"
              >
                <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                <span>{stage.name}</span>
              </button>
            ))}
          </div>

          {/* Divider */}
          <div className="h-px bg-border my-1" />

          {/* Delete */}
          <button
            type="button"
            onClick={handleDelete}
            disabled={isLoading}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-destructive hover:bg-destructive/10 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-left"
          >
            <Trash2 className="h-4 w-4 shrink-0" />
            <span>Excluir Pedido</span>
          </button>
        </div>
      )}
    </div>
  )
}
