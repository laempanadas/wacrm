'use client'

import { useState } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { MoreHorizontal, Loader2, ChevronRight } from 'lucide-react'
import { useDealStageMovement } from '@/hooks/use-deal-stage-movement'
import { PIPELINE_STAGES } from '@/lib/orders/pipeline-stages'
import type { Deal, PipelineStage } from '@/types'

interface DealCardActionsProps {
  deal: Deal
  currentStage: PipelineStage | null
  allStages: PipelineStage[]
  onDealUpdated?: () => void
}

/**
 * Menu de ações para movimentar deals entre stages.
 * Exibe apenas os próximos stages disponíveis (fluxo para frente).
 */
export function DealCardActions({
  deal,
  currentStage,
  allStages,
  onDealUpdated,
}: DealCardActionsProps) {
  const [isOpen, setIsOpen] = useState(false)
  const { moveDealToStage, isLoading } = useDealStageMovement()

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

  return (
    <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
      <DropdownMenuTrigger>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0 hover:bg-primary/10"
          onClick={(e) => {
            e.stopPropagation()
            e.preventDefault()
          }}
        >
          {isLoading ? (
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
          ) : (
            <MoreHorizontal className="h-4 w-4" />
          )}
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel className="text-xs font-semibold text-muted-foreground">
          Mover para
        </DropdownMenuLabel>
        <DropdownMenuSeparator />

        {nextStages.map((stage) => (
          <DropdownMenuItem
            key={stage.id}
            onClick={() => handleMoveToStage(stage.name)}
            disabled={isLoading}
            className="cursor-pointer"
          >
            <ChevronRight className="mr-2 h-4 w-4 text-muted-foreground" />
            <span className="flex-1">{stage.name}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
