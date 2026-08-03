'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Copy, Check, Share2, MessageCircle } from 'lucide-react';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { MENU, formatBRL, buildWhatsappMenuText } from '@/lib/cardapio/menu';

export function CardapioView() {
  const [copied, setCopied] = useState(false);

  async function copyToClipboard(text: string, successMsg: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast.success(successMsg);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Não foi possível copiar. Copie manualmente.');
    }
  }

  function handleCopyMenu() {
    void copyToClipboard(
      buildWhatsappMenuText(),
      'Cardápio copiado! Cole no WhatsApp para enviar.'
    );
  }

  async function handleShare() {
    const text = buildWhatsappMenuText();
    // Web Share API quando disponível (mobile), senão cai para cópia.
    if (typeof navigator !== 'undefined' && navigator.share) {
      try {
        await navigator.share({ title: 'La Empanadas — Cardápio', text });
        return;
      } catch {
        // usuário cancelou ou não suportado — segue para cópia
      }
    }
    void copyToClipboard(text, 'Cardápio copiado! Compartilhe onde quiser.');
  }

  function handleWhatsappShare() {
    const text = encodeURIComponent(buildWhatsappMenuText());
    // Abre o WhatsApp com o cardápio pré-preenchido para o atendente
    // escolher o contato.
    window.open(`https://wa.me/?text=${text}`, '_blank', 'noopener');
  }

  return (
    <div className="space-y-5">
      {/* Cabeçalho */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-foreground text-2xl font-bold">Cardápio</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Nosso cardápio de empanadas argentinas. Copie ou compartilhe direto
            no WhatsApp.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="lg" onClick={handleCopyMenu}>
            {copied ? (
              <Check className="h-4 w-4" />
            ) : (
              <Copy className="h-4 w-4" />
            )}
            Copiar cardápio para WhatsApp
          </Button>
          <Button variant="outline" size="lg" onClick={handleShare}>
            <Share2 className="h-4 w-4" />
            Compartilhar cardápio
          </Button>
          <Button size="lg" onClick={handleWhatsappShare}>
            <MessageCircle className="h-4 w-4" />
            Enviar no WhatsApp
          </Button>
        </div>
      </div>

      {/* Categorias */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {MENU.map((category) => (
          <Card key={category.title} className="flex flex-col">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <span aria-hidden>{category.emoji}</span>
                {category.title}
              </CardTitle>
              {category.subtitle ? (
                <CardDescription>{category.subtitle}</CardDescription>
              ) : null}
            </CardHeader>
            <CardContent className="flex-1">
              <ul className="divide-border flex flex-col divide-y">
                {category.items.map((item) => (
                  <li
                    key={item.name}
                    className="flex items-start justify-between gap-3 py-2.5"
                  >
                    <div className="flex min-w-0 items-start gap-2">
                      <span className="text-lg leading-none" aria-hidden>
                        {item.emoji}
                      </span>
                      <div className="min-w-0">
                        <p className="text-foreground text-sm font-medium">
                          {item.name}
                        </p>
                        {item.description ? (
                          <p className="text-muted-foreground text-xs">
                            {item.description}
                          </p>
                        ) : null}
                      </div>
                    </div>
                    <span className="text-primary shrink-0 text-sm font-semibold">
                      {formatBRL(item.price)}
                    </span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
