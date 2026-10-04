'use client';

import { useState, useMemo } from 'react';
import { toast } from 'sonner';
import { CreditCard, Loader2, Send, Copy, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import type { Contact, Message } from '@/types';

interface QuickPixButtonProps {
  conversationId: string;
  contact?: Contact | null;
  messages?: Message[];
  onSend: (text: string) => void;
  disabled?: boolean;
  readOnly?: boolean;
}

export function QuickPixButton({
  conversationId,
  contact,
  messages = [],
  onSend,
  disabled = false,
  readOnly = false,
}: QuickPixButtonProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [generatedUrl, setGeneratedUrl] = useState<string | null>(null);

  // Detecta automaticamente valor, itens e endereço a partir do histórico recente de mensagens
  const detected = useMemo(() => {
    let amount = '';
    let itemsText = 'Pedido La Empanadas';
    let address = '';

    // Procura nas mensagens mais recentes primeiro
    const reversed = [...messages].reverse();

    for (const m of reversed) {
      const text = m.content_text || '';

      // Tenta achar total em formato brasileiro (ex: Total: R$ 140,00 ou R$ 140,00 ou 140,00)
      if (!amount) {
        const totalMatch = text.match(/Total:\s*(?:R\$\s*)?([\d]+(?:[.,]\d{2})?)/i) ||
                           text.match(/R\$\s*([\d]+(?:[.,]\d{2})?)/i) ||
                           text.match(/\b([\d]{2,4}[.,]\d{2})\b/);
        if (totalMatch && totalMatch[1]) {
          amount = totalMatch[1].replace('.', ',');
        }
      }

      // Tenta extrair lista de itens do catálogo se houver marcadores com bullet
      if (itemsText === 'Pedido La Empanadas' && text.includes('•')) {
        const bulletLines = text
          .split('\n')
          .filter((l) => l.trim().startsWith('•'))
          .map((l) => l.trim())
          .join('\n');
        if (bulletLines) {
          itemsText = bulletLines;
        }
      }

      // Tenta extrair endereço mencionado
      if (!address) {
        const addrMatch = text.match(/(?:Entrega|Endereço|rua|av\.|alameda):\s*([^\n\r]+)/i);
        if (addrMatch && addrMatch[1] && addrMatch[1].trim().length > 5) {
          address = addrMatch[1].trim();
        }
      }
    }

    return { amount, itemsText, address };
  }, [messages]);

  const [amountStr, setAmountStr] = useState(detected.amount || '');
  const [description, setDescription] = useState(detected.itemsText || 'Pedido La Empanadas');
  const [addressStr, setAddressStr] = useState(detected.address || '');

  // Sincroniza se o modal abrir e os valores iniciais estiverem vazios
  function handleOpenChange(newOpen: boolean) {
    if (newOpen) {
      if (!amountStr && detected.amount) setAmountStr(detected.amount);
      if (description === 'Pedido La Empanadas' && detected.itemsText !== 'Pedido La Empanadas') {
        setDescription(detected.itemsText);
      }
      if (!addressStr && detected.address) setAddressStr(detected.address);
    }
    setOpen(newOpen);
  }

  const parsedAmount = useMemo(() => {
    const clean = amountStr.replace(/\s+/g, '').replace('R$', '').replace(',', '.');
    const num = parseFloat(clean);
    return isNaN(num) ? 0 : num;
  }, [amountStr]);

  async function handleGenerate(shouldSendToChat: boolean) {
    if (parsedAmount <= 0) {
      toast.error('Informe um valor válido em reais (ex: 140,00).');
      return;
    }

    setLoading(true);
    try {
      const title = description.trim() || 'Pedido La Empanadas';
      const payerName = contact?.name || undefined;
      const payerPhone = contact?.phone || undefined;

      const res = await fetch('/api/payments/mercado-pago', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [
            {
              title: title.length > 120 ? title.substring(0, 117) + '...' : title,
              quantity: 1,
              unitPrice: parsedAmount,
            },
          ],
          payerName,
          payerPhone,
          contactId: contact?.id,
          conversationId,
          deliveryKind: 'delivery',
          deliveryAddress: addressStr.trim() || undefined,
        }),
      });

      const data = (await res.json().catch(() => null)) as {
        paymentUrl?: string;
        error?: string;
      } | null;

      if (!res.ok || !data?.paymentUrl) {
        toast.error(
          data?.error ?? 'Não foi possível gerar o link do Mercado Pago. Verifique a integração.'
        );
        return;
      }

      setGeneratedUrl(data.paymentUrl);

      if (shouldSendToChat) {
        const formattedAmount = parsedAmount.toLocaleString('pt-BR', {
          style: 'currency',
          currency: 'BRL',
        });

        const addressLine = addressStr.trim() ? `📍 *Entrega:* ${addressStr.trim()}\n\n` : '';
        const itemsBlock = description.trim() ? `${description.trim()}\n` : '';

        const chatMessage =
          `🫔 *Pedido Confirmado!*\n` +
          `${itemsBlock}` +
          `💵 *Total: ${formattedAmount}*\n` +
          `${addressLine}` +
          `💳 *Pague online com Pix ou Cartão pelo link abaixo:*\n` +
          `${data.paymentUrl}\n\n` +
          `Assim que o pagamento for aprovado, seu pedido entra automaticamente em preparo!`;

        onSend(chatMessage);
        toast.success('Link Pix / Mercado Pago gerado e enviado na conversa!');
        setOpen(false);
      } else {
        toast.success('Link gerado com sucesso!');
      }
    } catch (err) {
      console.error('[QuickPixButton] Erro ao gerar link:', err);
      toast.error('Erro de conexão ao gerar link do Mercado Pago.');
    } finally {
      setLoading(false);
    }
  }

  async function handleCopy() {
    if (!generatedUrl) return;
    try {
      await navigator.clipboard.writeText(generatedUrl);
      setCopied(true);
      toast.success('Link copiado para a área de transferência!');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Não foi possível copiar o link.');
    }
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        disabled={disabled || readOnly}
        title="Gerar link de pagamento Pix / Mercado Pago"
        className="inline-flex items-center justify-center rounded-md font-semibold transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 border shadow-xs h-9 gap-1.5 px-2.5 text-xs border-emerald-500/40 text-emerald-700 dark:text-emerald-300 bg-emerald-50 hover:bg-emerald-100/80 dark:bg-emerald-950/40 dark:hover:bg-emerald-900/60 shrink-0 cursor-pointer"
      >
        <CreditCard className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
        <span className="hidden sm:inline">💳 Gerar Link Pix</span>
        <span className="sm:hidden">Pix</span>
      </PopoverTrigger>

      <PopoverContent
        align="start"
        side="top"
        className="w-84 p-4 shadow-lg border-border bg-popover"
      >
        <div className="space-y-3.5">
          <div className="flex items-center justify-between pb-1 border-b border-border/60">
            <div className="flex items-center gap-1.5 font-semibold text-sm text-foreground">
              <CreditCard className="h-4 w-4 text-emerald-500" />
              <span>Gerar Link Mercado Pago</span>
            </div>
            {parsedAmount > 0 && (
              <span className="text-xs font-mono font-medium text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded">
                R$ {parsedAmount.toFixed(2).replace('.', ',')}
              </span>
            )}
          </div>

          <div className="space-y-2">
            <div>
              <Label htmlFor="pix-amount" className="text-xs font-medium">
                Valor Total (R$) <span className="text-destructive">*</span>
              </Label>
              <div className="relative mt-1">
                <span className="absolute left-2.5 top-2 text-xs font-medium text-muted-foreground">
                  R$
                </span>
                <Input
                  id="pix-amount"
                  placeholder="140,00"
                  value={amountStr}
                  onChange={(e) => setAmountStr(e.target.value)}
                  className="pl-8 text-sm h-8 font-medium"
                />
              </div>
            </div>

            <div>
              <Label htmlFor="pix-desc" className="text-xs font-medium">
                Descrição dos Itens
              </Label>
              <Input
                id="pix-desc"
                placeholder="Ex: 4x Carne Suave, 2x Queijo..."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="mt-1 text-xs h-8"
              />
            </div>

            <div>
              <Label htmlFor="pix-address" className="text-xs font-medium">
                Endereço de Entrega (opcional)
              </Label>
              <Input
                id="pix-address"
                placeholder="Rua, número e bairro"
                value={addressStr}
                onChange={(e) => setAddressStr(e.target.value)}
                className="mt-1 text-xs h-8"
              />
            </div>
          </div>

          {generatedUrl && (
            <div className="space-y-1.5 rounded-md bg-muted/60 p-2 text-xs border border-border/80">
              <span className="text-[10px] uppercase font-semibold text-muted-foreground tracking-wider">
                Link Gerado:
              </span>
              <p className="font-mono text-[11px] text-foreground truncate break-all">
                {generatedUrl}
              </p>
              <div className="flex gap-2 pt-1">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleCopy}
                  className="h-6 text-[11px] px-2 flex-1"
                >
                  {copied ? (
                    <>
                      <Check className="h-3 w-3 mr-1 text-emerald-500" />
                      Copiado!
                    </>
                  ) : (
                    <>
                      <Copy className="h-3 w-3 mr-1" />
                      Copiar Link
                    </>
                  )}
                </Button>
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  onClick={() => handleGenerate(true)}
                  disabled={loading}
                  className="h-6 text-[11px] px-2 flex-1 bg-emerald-600 hover:bg-emerald-700 text-white"
                >
                  <Send className="h-3 w-3 mr-1" />
                  Reenviar
                </Button>
              </div>
            </div>
          )}

          <div className="flex flex-col gap-1.5 pt-1">
            <Button
              type="button"
              onClick={() => handleGenerate(true)}
              disabled={loading || parsedAmount <= 0}
              className="w-full h-8 text-xs font-semibold bg-emerald-600 hover:bg-emerald-700 text-white gap-1.5 shadow-sm"
            >
              {loading ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Gerando Link...
                </>
              ) : (
                <>
                  <Send className="h-3.5 w-3.5" />
                  ⚡ Gerar e Enviar no WhatsApp
                </>
              )}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
