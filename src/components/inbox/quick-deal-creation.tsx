'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Plus, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import type { Contact } from '@/types'

interface QuickDealCreationProps {
  contact: Contact
  onDealCreated?: () => void
}

/**
 * Dropdown para criar pedido rápido com valor inicial.
 * Cria deal em "Novo Pedido" e vincula ao contato.
 */
export function QuickDealCreation({
  contact,
  onDealCreated,
}: QuickDealCreationProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [value, setValue] = useState('')
  const [isLoading, setIsLoading] = useState(false)

  const handleCreateDeal = async () => {
    if (!value || isNaN(parseFloat(value))) {
      toast.error('Informe um valor válido')
      return
    }

    setIsLoading(true)
    try {
      const response = await fetch('/api/deals/quick-create', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contact_id: contact.id,
          value: parseFloat(value),
          title: `Pedido - ${contact.name || contact.phone}`,
        }),
      })

      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.error || 'Erro ao criar pedido')
      }

      toast.success('Pedido criado com sucesso!')
      setValue('')
      setIsOpen(false)
      onDealCreated?.()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Erro desconhecido'
      toast.error(message)
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
      <DropdownMenuTrigger>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 w-6 p-0 hover:bg-primary/10"
          title="Criar novo pedido"
        >
          <Plus className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="w-48">
        <div className="p-3 space-y-2">
          <label className="text-xs font-semibold text-muted-foreground">
            Valor do pedido (R$)
          </label>
          <div className="flex gap-2">
            <Input
              type="number"
              placeholder="0.00"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              step="0.01"
              min="0"
              className="h-8 text-sm"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  handleCreateDeal()
                }
              }}
              disabled={isLoading}
            />
            <Button
              size="sm"
              onClick={handleCreateDeal}
              disabled={isLoading || !value}
              className="h-8 w-12"
            >
              {isLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                'OK'
              )}
            </Button>
          </div>
          <p className="text-[10px] text-muted-foreground">
            Será criado em "Novo Pedido"
          </p>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
