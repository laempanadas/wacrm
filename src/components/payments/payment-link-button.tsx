'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { CreditCard, Copy, Check, Loader2, MessageCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface PaymentLinkButtonProps {
  /** Título/descrição do pedido (ex.: "Pedido #123 — La Empanadas"). */
  title: string;
  /** Valor total do pedido em reais (BRL). */
  amount: number;
  /** Referência externa opcional (ex.: ID do pedido). */
  externalReference?: string;
  /** Nome do cliente, apenas informativo na preferência. */
  payerName?: string;
}

/**
 * Botão de geração de link de pagamento via Mercado Pago.
 *
 * Chama `POST /api/payments/mercado-pago`. Se a integração ainda não
 * estiver configurada (sem MP_ACCESS_TOKEN), o endpoint responde 503
 * e mostramos um aviso amigável — nada quebra.
 */
export function PaymentLinkButton({
  title,
  amount,
  externalReference,
  payerName,
}: PaymentLinkButtonProps) {
  const [loading, setLoading] = useState(false);
  const [paymentUrl, setPaymentUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function handleGenerate() {
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error(
        'Defina um valor válido para o pedido antes de gerar o link.'
      );
      return;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/payments/mercado-pago', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [{ title, quantity: 1, unitPrice: amount }],
          externalReference,
          payerName,
        }),
      });
      const data = (await res.json().catch(() => null)) as {
        paymentUrl?: string;
        error?: string;
      } | null;

      if (!res.ok || !data?.paymentUrl) {
        toast.error(
          data?.error ??
            'Não foi possível gerar o link de pagamento. Tente novamente.'
        );
        return;
      }

      setPaymentUrl(data.paymentUrl);
      toast.success('Link de pagamento gerado!');
    } catch {
      toast.error('Erro de rede ao gerar o link de pagamento.');
    } finally {
      setLoading(false);
    }
  }

  async function handleCopy() {
    if (!paymentUrl) return;
    try {
      await navigator.clipboard.writeText(paymentUrl);
      setCopied(true);
      toast.success('Link copiado! Cole no WhatsApp para enviar ao cliente.');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Não foi possível copiar o link.');
    }
  }

  function handleSendWhatsapp() {
    if (!paymentUrl) return;
    const msg = encodeURIComponent(
      `🫔 *La Empanadas*\nAqui está o link para pagamento do seu pedido:\n${paymentUrl}`
    );
    window.open(`https://wa.me/?text=${msg}`, '_blank', 'noopener');
  }

  return (
    <div className="border-border bg-muted/50 space-y-2 rounded-lg border p-3">
      <p className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
        Pagamento (Mercado Pago)
      </p>

      {!paymentUrl ? (
        <Button
          type="button"
          onClick={handleGenerate}
          disabled={loading}
          className="w-full"
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <CreditCard className="h-4 w-4" />
          )}
          Gerar link de pagamento
        </Button>
      ) : (
        <div className="space-y-2">
          <p className="bg-background text-muted-foreground rounded-md px-2 py-1.5 text-xs break-all">
            {paymentUrl}
          </p>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={handleCopy}
              className="flex-1"
            >
              {copied ? (
                <Check className="h-4 w-4" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
              Copiar link
            </Button>
            <Button
              type="button"
              onClick={handleSendWhatsapp}
              className="flex-1"
            >
              <MessageCircle className="h-4 w-4" />
              Enviar no WhatsApp
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
