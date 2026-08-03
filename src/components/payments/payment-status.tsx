'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Loader2, RefreshCw, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';

/** Status normalizado do pagamento (espelha a lib do Mercado Pago). */
type PaymentUiStatus =
  'pending' | 'in_process' | 'approved' | 'rejected' | 'unknown';

interface PaymentStatusProps {
  /** Referência externa (ID do pedido) usada para consultar o status. */
  externalReference: string;
  /** Link de pagamento gerado, para reenviar ao cliente pelo WhatsApp. */
  paymentUrl?: string;
  /** Status inicial conhecido (opcional). */
  initialStatus?: PaymentUiStatus;
}

const STATUS_META: Record<
  PaymentUiStatus,
  { label: string; dot: string; className: string }
> = {
  approved: {
    label: 'Pago',
    dot: '🟢',
    className: 'bg-green-100 text-green-800 border-green-300',
  },
  in_process: {
    label: 'Em processo',
    dot: '🟡',
    className: 'bg-yellow-100 text-yellow-800 border-yellow-300',
  },
  pending: {
    label: 'Pendente',
    dot: '🔴',
    className: 'bg-red-100 text-red-800 border-red-300',
  },
  rejected: {
    label: 'Recusado',
    dot: '🔴',
    className: 'bg-red-100 text-red-800 border-red-300',
  },
  unknown: {
    label: 'Desconhecido',
    dot: '⚪',
    className: 'bg-gray-100 text-gray-700 border-gray-300',
  },
};

/**
 * Exibe o status de pagamento de um pedido com um selo colorido e
 * permite:
 *   - "Verificar pagamento" → consulta `GET /api/payments/mercado-pago/status`.
 *   - "Reenviar link" → abre o WhatsApp com o link de pagamento.
 *
 * Se a integração do Mercado Pago não estiver configurada (503), um
 * aviso amigável é mostrado em vez de quebrar.
 */
export function PaymentStatus({
  externalReference,
  paymentUrl,
  initialStatus = 'pending',
}: PaymentStatusProps) {
  const [status, setStatus] = useState<PaymentUiStatus>(initialStatus);
  const [loading, setLoading] = useState(false);

  const meta = STATUS_META[status] ?? STATUS_META.unknown;

  async function handleCheck() {
    if (!externalReference) {
      toast.error('Pedido sem referência para consultar o pagamento.');
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(
        `/api/payments/mercado-pago/status?externalReference=${encodeURIComponent(
          externalReference
        )}`
      );
      const data = (await res.json().catch(() => null)) as {
        status?: PaymentUiStatus;
        error?: string;
      } | null;

      if (!res.ok || !data?.status) {
        toast.error(
          data?.error ??
            'Não foi possível verificar o pagamento. Tente novamente.'
        );
        return;
      }

      setStatus(data.status);
      if (data.status === 'approved') {
        toast.success('Pagamento confirmado! 🟢');
      } else {
        toast.info(`Status atual: ${STATUS_META[data.status]?.label ?? '—'}`);
      }
    } catch {
      toast.error('Erro de rede ao verificar o pagamento.');
    } finally {
      setLoading(false);
    }
  }

  function handleResend() {
    if (!paymentUrl) {
      toast.error('Nenhum link de pagamento disponível para reenviar.');
      return;
    }
    const msg = encodeURIComponent(
      `🫔 *La Empanadas*\nSegue o link para pagamento do seu pedido:\n${paymentUrl}`
    );
    window.open(`https://wa.me/?text=${msg}`, '_blank', 'noopener');
  }

  return (
    <div className="border-border bg-muted/50 space-y-3 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
          Status do pagamento
        </p>
        <span
          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${meta.className}`}
        >
          <span aria-hidden>{meta.dot}</span>
          {meta.label}
        </span>
      </div>

      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={handleCheck}
          disabled={loading}
          className="flex-1"
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
          Verificar pagamento
        </Button>
        <Button
          type="button"
          onClick={handleResend}
          disabled={!paymentUrl}
          className="flex-1"
        >
          <Send className="h-4 w-4" />
          Reenviar link
        </Button>
      </div>
    </div>
  );
}
