'use client'

import { useState } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { ChevronRight, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { useDealStageMovement } from '@/hooks/use-deal-stage-movement'
import { PIPELINE_STAGES } from '@/lib/orders/pipeline-stages'
import type { Deal, PipelineStage } from '@/types'

interface DealQuickActionsProps {
  deal: Deal
  currentStage: PipelineStage | null
  allStages: PipelineStage[]
  onDealUpdated?: () => void
}

/**
 * Menu de ações rápidas para mover deal entre stages.
 * Renderizado no painel lateral, dentro dos cards de deal.
 */
export function DealQuickActions({
  deal,
  currentStage,
  allStages,
  onDealUpdated,
}: DealQuickActionsProps) {
  const [isOpen, setIsOpen] = useState(false)
  const { moveDealToStage, isLoading } = useDealStageMovement()

  const nextStages = allStages.filter(
    (s) => currentStage && s.position > currentStage.position
  )

  if (!nextStages.length || !currentStage) {
    return null
  }

  const handleMoveToStage = async (stageName: string) => {
    try {
      await moveDealToStage(deal.id, stageName)
      setIsOpen(false)
      onDealUpdated?.()
    } catch {
      // Erro já tratado no hook
    }
  }

  return (
    <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
      <DropdownMenuTrigger>
        <Button
          size="sm"
          variant="ghost"
          className="h-5 w-5 p-0 hover:bg-primary/10"
          onClick={(e) => e.stopPropagation()}
          title="Ações rápidas"
        >
          {isLoading ? (
            <Loader2 className="h-3 w-3 animate-spin text-primary" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-40">
        {nextStages.map((stage) => (
          <DropdownMenuItem
            key={stage.id}
            onClick={() => handleMoveToStage(stage.name)}
            disabled={isLoading}
            className="cursor-pointer text-xs"
          >
            {stage.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
