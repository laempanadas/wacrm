'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Plus, Loader2, Check } from 'lucide-react';
import { toast } from 'sonner';
import type { Contact } from '@/types';

interface QuickDealCreationProps {
  contact: Contact;
  onDealCreated?: () => void;
}

/**
 * Dropdown para criar pedido rápido com valor inicial.
 * Cria deal em "Novo Pedido" e vincula ao contato.
 */
export function QuickDealCreation({
  contact,
  onDealCreated,
}: QuickDealCreationProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [value, setValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  /**
   * Limpa e normaliza entrada de valor.
   * Remove "R$", símbolos, espaços extras e converte vírgula para ponto.
   */
  const cleanValue = (input: string): string => {
    // Remove "R$", símbolos de moeda e caracteres indesejados
    let cleaned = input
      .replace(/[R$\s]/g, '') // Remove R$, espaços
      .replace(/[^\d,.-]/g, '') // Remove tudo exceto dígitos, vírgula, ponto, hífen
      .trim();

    return cleaned;
  };

  const parseValue = (input: string): number | null => {
    if (!input.trim()) return null;
    const cleaned = cleanValue(input);
    if (!cleaned) return null;
    // Converte vírgula para ponto
    const normalized = cleaned.replace(',', '.');
    const parsed = parseFloat(normalized);
    return isNaN(parsed) ? null : parsed;
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    e.stopPropagation();
    const cleaned = cleanValue(e.target.value);
    setValue(cleaned);
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    e.preventDefault();
    const pastedText = e.clipboardData?.getData('text') || '';
    const cleaned = cleanValue(pastedText);
    setValue(cleaned);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !isLoading) {
      e.preventDefault();
      handleCreateDeal();
    }
  };

  const handleKeyUp = (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
  };

  const handleKeyPress = (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
  };

  const handleCreateDeal = async () => {
    const parsedValue = parseValue(value);
    if (parsedValue === null || parsedValue < 0) {
      toast.error('Informe um valor válido');
      return;
    }

    setIsLoading(true);
    try {
      const response = await fetch('/api/deals/quick-create', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contact_id: contact.id,
          value: parsedValue,
          title: `Pedido - ${contact.name || contact.phone}`,
        }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Erro ao criar pedido');
      }

      toast.success('Pedido criado com sucesso!');
      setValue('');
      setIsOpen(false);
      onDealCreated?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Erro desconhecido';
      toast.error(message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
      <DropdownMenuTrigger>
        <Button
          size="sm"
          variant="ghost"
          className="hover:bg-primary/10 h-6 w-6 p-0"
          title="Criar novo pedido"
        >
          <Plus className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="w-56">
        <div className="space-y-3 p-4">
          {/* Título */}
          <div>
            <label className="text-foreground text-xs font-semibold">
              Valor do Pedido
            </label>
          </div>

          {/* Input com prefixo R$ */}
          <div className="relative">
            <span className="text-muted-foreground absolute top-2.5 left-3 text-sm font-medium">
              R$
            </span>
            <Input
              type="text"
              placeholder="0,00"
              value={value}
              onChange={handleChange}
              onPaste={handlePaste}
              onKeyDown={handleKeyDown}
              onKeyUp={handleKeyUp}
              onKeyPress={handleKeyPress}
              autoFocus
              className="h-9 pr-3 pl-8 text-sm"
              disabled={isLoading}
              inputMode="decimal"
            />
          </div>

          {/* Botão Salvar */}
          <Button
            onClick={handleCreateDeal}
            disabled={isLoading || !value}
            className="h-9 w-full gap-2 bg-green-600 text-white hover:bg-green-700"
          >
            {isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <>
                <Check className="h-4 w-4" />
                Salvar
              </>
            )}
          </Button>

          {/* Hint sutil */}
          <p className="text-muted-foreground text-center text-[11px]">
            Pressione Enter para salvar
          </p>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
