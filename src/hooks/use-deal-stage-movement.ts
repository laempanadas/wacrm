import { useState } from 'react';
import { toast } from 'sonner';

/**
 * Hook para gerenciar movimento de deals entre stages do pipeline.
 * Chama POST /api/deals/[id]/move-stage para mover o deal.
 */
export function useDealStageMovement() {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const moveDealToStage = async (dealId: string, stageName: string) => {
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch(`/api/deals/${dealId}/move-stage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ stage: stageName }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `Erro ao mover card para "${stageName}"`);
      }

      const result = await response.json();
      toast.success('Card movido com sucesso', {
        description: `Pedido movido para "${stageName}"`,
      });

      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Erro desconhecido';
      setError(message);
      toast.error('Erro ao mover card', {
        description: message,
      });
      throw err;
    } finally {
      setIsLoading(false);
    }
  };

  return { moveDealToStage, isLoading, error };
}
