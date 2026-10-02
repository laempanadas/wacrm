'use client'

import { useState, useCallback, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Plus, Search, X, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import type { Contact, Tag } from '@/types'

interface TagManagerProps {
  contact: Contact
  activeTags: (Tag & { contact_tag_id: string })[]
  allTags: Tag[]
  onTagsUpdated?: () => void
}

/**
 * Gerenciador interativo de tags com criação rápida e otimistic update.
 * Permite adicionar/remover tags de contatos instantaneamente.
 */
export function TagManager({
  contact,
  activeTags,
  allTags,
  onTagsUpdated,
}: TagManagerProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [localActiveTags, setLocalActiveTags] = useState<string[]>(
    activeTags.map((t) => t.id)
  )

  const supabase = createClient()

  // Filtrar tags baseado na busca
  const filteredTags = useMemo(() => {
    const normalized = searchQuery.toLowerCase().trim()
    if (!normalized) return allTags

    return allTags.filter((tag) =>
      tag.name.toLowerCase().includes(normalized)
    )
  }, [allTags, searchQuery])

  // Detectar se há tag sendo criada (não existe na lista)
  const newTagName = useMemo(() => {
    const normalized = searchQuery.toLowerCase().trim()
    if (!normalized) return null
    if (filteredTags.some((t) => t.name.toLowerCase() === normalized)) {
      return null
    }
    return normalized
  }, [searchQuery, filteredTags])

  const toggleTag = useCallback(
    async (tagId: string, tagName: string) => {
      const isActive = localActiveTags.includes(tagId)

      // Optimistic update
      setLocalActiveTags((prev) =>
        isActive ? prev.filter((id) => id !== tagId) : [...prev, tagId]
      )

      try {
        if (isActive) {
          // Remover tag
          await supabase
            .from('contact_tags')
            .delete()
            .eq('contact_id', contact.id)
            .eq('tag_id', tagId)
        } else {
          // Adicionar tag
          await supabase.from('contact_tags').insert({
            contact_id: contact.id,
            tag_id: tagId,
          })
        }

        const action = isActive ? 'removida' : 'adicionada'
        toast.success(`Tag "${tagName}" ${action}`)
        onTagsUpdated?.()
      } catch (err) {
        // Reverter optimistic update em caso de erro
        setLocalActiveTags((prev) =>
          isActive ? [...prev, tagId] : prev.filter((id) => id !== tagId)
        )
        const message =
          err instanceof Error ? err.message : 'Erro ao atualizar tag'
        toast.error(message)
      }
    },
    [contact.id, localActiveTags, supabase, onTagsUpdated]
  )

  const createAndApplyTag = useCallback(
    async (tagName: string) => {
      if (!tagName.trim()) {
        toast.error('Nome da tag não pode estar vazio')
        return
      }

      setIsLoading(true)
      try {
        // 1. Criar a tag
        const { data: newTag, error: createErr } = await supabase
          .from('tags')
          .insert({ name: tagName, color: '#3b82f6' })
          .select('id, name, color')
          .single()

        if (createErr || !newTag) {
          throw new Error(createErr?.message || 'Erro ao criar tag')
        }

        // 2. Aplicar ao contato
        await supabase.from('contact_tags').insert({
          contact_id: contact.id,
          tag_id: newTag.id,
        })

        // Atualizar estado local
        setLocalActiveTags((prev) => [...prev, newTag.id])
        setSearchQuery('')
        toast.success(`Tag "${tagName}" criada e aplicada!`)
        onTagsUpdated?.()
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Erro ao criar tag'
        toast.error(message)
      } finally {
        setIsLoading(false)
      }
    },
    [contact.id, supabase, onTagsUpdated]
  )

  const removeTagQuick = useCallback(
    (tagId: string, tagName: string) => {
      toggleTag(tagId, tagName)
    },
    [toggleTag]
  )

  const activeTagsObjects = useMemo(
    () => allTags.filter((t) => localActiveTags.includes(t.id)),
    [allTags, localActiveTags]
  )

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 w-6 p-0 hover:bg-primary/10"
          title="Gerenciar tags"
        >
          <Plus className="h-4 w-4" />
        </Button>
      </PopoverTrigger>

      <PopoverContent align="start" className="w-64">
        <div className="space-y-3">
          {/* Header */}
          <div className="flex items-center gap-2">
            <Search className="h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Buscar ou criar tag..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-8 text-sm"
              disabled={isLoading}
              autoFocus
            />
          </div>

          {/* Tags ativas (badges com X) */}
          {activeTagsObjects.length > 0 && (
            <div className="flex flex-wrap gap-2 pt-2 border-t">
              {activeTagsObjects.map((tag) => (
                <div
                  key={tag.id}
                  className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium"
                  style={{
                    backgroundColor: `${tag.color}20`,
                    color: tag.color,
                  }}
                >
                  {tag.name}
                  <button
                    onClick={() => removeTagQuick(tag.id, tag.name)}
                    className="ml-1 hover:opacity-70 transition-opacity"
                    title="Remover tag"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Lista de tags disponíveis */}
          <div className="space-y-1 max-h-48 overflow-y-auto">
            {filteredTags.length > 0 ? (
              filteredTags.map((tag) => {
                const isActive = localActiveTags.includes(tag.id)
                return (
                  <button
                    key={tag.id}
                    onClick={() => toggleTag(tag.id, tag.name)}
                    disabled={isLoading}
                    className="w-full text-left px-3 py-2 rounded-md text-sm transition-colors hover:bg-muted disabled:opacity-50"
                  >
                    <div className="flex items-center gap-2">
                      <div
                        className={`h-3 w-3 rounded-full border-2 ${
                          isActive ? 'border-primary bg-primary' : 'border-muted'
                        }`}
                      />
                      <span className={isActive ? 'font-semibold' : ''}>
                        {tag.name}
                      </span>
                    </div>
                  </button>
                )
              })
            ) : (
              <p className="text-xs text-muted-foreground px-3 py-2">
                Nenhuma tag encontrada
              </p>
            )}
          </div>

          {/* Criar nova tag */}
          {newTagName && (
            <div className="border-t pt-2">
              <button
                onClick={() => createAndApplyTag(newTagName)}
                disabled={isLoading}
                className="w-full text-left px-3 py-2 rounded-md text-sm bg-primary/10 hover:bg-primary/20 transition-colors disabled:opacity-50 flex items-center gap-2 text-primary font-medium"
              >
                {isLoading ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Plus className="h-3 w-3" />
                )}
                Criar e aplicar "{newTagName}"
              </button>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
