'use client';

import { useState, useRef, useEffect } from 'react';
import { MoreHorizontal, Loader2, ChevronRight, Trash2 } from 'lucide-react';
import { useDealStageMovement } from '@/hooks/use-deal-stage-movement';
import { createClient } from '@/lib/supabase/client';
import { toast } from 'sonner';
import type { Deal, PipelineStage } from '@/types';

interface DealCardActionsProps {
  deal: Deal;
  currentStage: PipelineStage | null;
  allStages: PipelineStage[];
  onDealUpdated?: () => void;
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
  const [isOpen, setIsOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const { moveDealToStage, isLoading } = useDealStageMovement();

  // Fechar menu ao clicar fora
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () =>
        document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen]);

  // Stages disponíveis para movimento (apenas para frente)
  const nextStages = allStages.filter(
    (s) => currentStage && s.position > currentStage.position
  );

  // Se não há stage definido, não mostra menu
  if (!currentStage) {
    return null;
  }

  const handleMoveToStage = async (stageName: string) => {
    try {
      await moveDealToStage(deal.id, stageName);
      setIsOpen(false);
      onDealUpdated?.();
    } catch {
      // Erro já é tratado no hook e exibido via toast
    }
  };

  const handleDelete = async () => {
    if (
      !window.confirm(
        `Tem certeza que deseja excluir o pedido "${deal.title}"?`
      )
    ) {
      return;
    }
    setIsDeleting(true);
    try {
      const supabase = createClient();
      const { error } = await supabase.from('deals').delete().eq('id', deal.id);
      if (error) {
        toast.error('Erro ao excluir pedido');
        return;
      }
      toast.success('Pedido excluído com sucesso');
      setIsOpen(false);
      onDealUpdated?.();
    } catch {
      toast.error('Erro ao excluir pedido');
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setIsOpen(!isOpen);
        }}
        className="text-muted-foreground hover:bg-primary/10 inline-flex h-6 w-6 items-center justify-center rounded-md p-0 transition-colors focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        title="Ações do pedido"
        disabled={isLoading || isDeleting}
      >
        {isLoading || isDeleting ? (
          <Loader2 className="text-primary h-4 w-4 animate-spin" />
        ) : (
          <MoreHorizontal className="h-4 w-4" />
        )}
      </button>

      {/* Dropdown Menu - Simple implementation without Base UI */}
      {isOpen && (
        <div
          ref={menuRef}
          className="bg-popover border-border absolute top-8 right-0 z-50 min-w-[200px] rounded-lg border p-1 shadow-lg"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Mover para stages */}
          {nextStages.length > 0 && (
            <>
              <div className="space-y-0.5">
                {nextStages.map((stage) => (
                  <button
                    key={stage.id}
                    type="button"
                    onClick={() => handleMoveToStage(stage.name)}
                    disabled={isLoading || isDeleting}
                    className="text-foreground hover:bg-muted flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <ChevronRight className="text-muted-foreground h-4 w-4 shrink-0" />
                    <span>{stage.name}</span>
                  </button>
                ))}
              </div>

              {/* Divider */}
              <div className="bg-border my-1 h-px" />
            </>
          )}

          {/* Delete */}
          <button
            type="button"
            onClick={handleDelete}
            disabled={isLoading || isDeleting}
            className="text-destructive hover:bg-destructive/10 flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isDeleting ? (
              <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
            ) : (
              <Trash2 className="h-4 w-4 shrink-0" />
            )}
            <span>{isDeleting ? 'Excluindo...' : 'Excluir Pedido'}</span>
          </button>
        </div>
      )}
    </div>
  );
}
