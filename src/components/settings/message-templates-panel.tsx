'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Copy, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { WHATSAPP_MESSAGE_TEMPLATES } from '@/lib/templates/whatsapp-messages';

/**
 * Painel de "Mensagens Prontas" — modelos de WhatsApp para cada etapa
 * do pipeline de pedidos e para campanhas de recompra. O atendente
 * copia o texto e cola na conversa do cliente.
 */
export function MessageTemplatesPanel() {
  const [copiedId, setCopiedId] = useState<string | null>(null);

  async function handleCopy(id: string, body: string) {
    try {
      await navigator.clipboard.writeText(body);
      setCopiedId(id);
      toast.success('Mensagem copiada! Cole na conversa do cliente.');
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      toast.error('Não foi possível copiar. Copie manualmente.');
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-foreground text-lg font-semibold">
          Mensagens Prontas
        </h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Modelos de WhatsApp para cada etapa do pedido. Use os campos{' '}
          <code className="bg-muted rounded px-1">{'{nome_cliente}'}</code>,{' '}
          <code className="bg-muted rounded px-1">{'{numero_pedido}'}</code> e{' '}
          <code className="bg-muted rounded px-1">[link]</code> e substitua ao
          enviar.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {WHATSAPP_MESSAGE_TEMPLATES.map((tpl) => (
          <div
            key={tpl.id}
            className="border-border bg-card flex flex-col rounded-xl border p-4"
          >
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="text-foreground flex items-center gap-2 text-sm font-semibold">
                <span aria-hidden>{tpl.emoji}</span>
                {tpl.title}
              </h3>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => handleCopy(tpl.id, tpl.body)}
              >
                {copiedId === tpl.id ? (
                  <Check className="h-3.5 w-3.5" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
                Copiar
              </Button>
            </div>
            <pre className="bg-muted/60 text-foreground flex-1 rounded-lg p-3 font-sans text-sm whitespace-pre-wrap">
              {tpl.body}
            </pre>
          </div>
        ))}
      </div>
    </div>
  );
}
