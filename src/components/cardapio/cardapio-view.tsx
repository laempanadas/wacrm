'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { toast } from 'sonner';
import {
  Copy,
  Check,
  Share2,
  MessageCircle,
  Plus,
  Loader2,
  AlertCircle,
} from 'lucide-react';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  MENU,
  formatBRL,
  buildWhatsappMenuText,
  type DynamicMenuItem,
} from '@/lib/cardapio/menu';

export interface MenuItemData {
  id: string;
  name: string;
  price: number;
  category: string;
  is_available: boolean;
  description?: string | null;
  emoji?: string | null;
  created_at?: string;
  updated_at?: string;
}

export function CardapioView() {
  const [items, setItems] = useState<MenuItemData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // New Item Dialog State
  const [dialogOpen, setDialogOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPrice, setNewPrice] = useState('');
  const [newCategory, setNewCategory] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newEmoji, setNewEmoji] = useState('🥟');
  const [newAvailable, setNewAvailable] = useState(true);

  // Load menu items from CRM API
  const fetchMenu = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch('/api/menu');
      if (!res.ok) {
        throw new Error('Falha ao carregar o cardápio.');
      }
      const data = await res.json();
      setItems(data.items ?? []);
    } catch (err) {
      console.error('[CardapioView] fetch error:', err);
      setError('Não foi possível carregar os itens do cardápio.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchMenu();
  }, [fetchMenu]);

  // Existing categories for autocomplete datalist
  const existingCategories = useMemo(() => {
    const set = new Set<string>();
    MENU.forEach((c) => set.add(c.title));
    items.forEach((item) => {
      if (item.category) set.add(item.category);
    });
    return Array.from(set);
  }, [items]);

  // Group items by category
  const groupedCategories = useMemo(() => {
    const map = new Map<string, MenuItemData[]>();

    // Seed order from standard MENU first
    for (const cat of MENU) {
      map.set(cat.title, []);
    }

    // Populate with actual items
    for (const item of items) {
      const cat = item.category || 'Outros';
      const list = map.get(cat) ?? [];
      list.push(item);
      map.set(cat, list);
    }

    // Convert to array of { category, items, emoji, subtitle }
    const result: Array<{
      category: string;
      items: MenuItemData[];
      emoji: string;
      subtitle?: string;
    }> = [];

    for (const [catName, catItems] of map.entries()) {
      if (catItems.length === 0) continue;
      const staticCat = MENU.find(
        (c) => c.title.toLowerCase() === catName.toLowerCase()
      );
      result.push({
        category: catName,
        items: catItems,
        emoji: staticCat?.emoji || '🥟',
        subtitle: staticCat?.subtitle,
      });
    }

    return result;
  }, [items]);

  // Toggle availability in real-time
  async function handleToggleAvailability(item: MenuItemData) {
    const updatedStatus = !item.is_available;

    // Optimistic update
    setItems((prev) =>
      prev.map((i) =>
        i.id === item.id ? { ...i, is_available: updatedStatus } : i
      )
    );

    try {
      const res = await fetch(`/api/menu/${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_available: updatedStatus }),
      });

      if (!res.ok) {
        throw new Error('Falha ao atualizar status no servidor.');
      }

      toast.success(
        updatedStatus
          ? `${item.name} ativado!`
          : `${item.name} pausado (esgotado)!`
      );
    } catch (err) {
      console.error('[CardapioView] toggle error:', err);
      // Revert optimistic update
      setItems((prev) =>
        prev.map((i) =>
          i.id === item.id ? { ...i, is_available: !updatedStatus } : i
        )
      );
      toast.error('Erro ao atualizar status. Tente novamente.');
    }
  }

  // Create new menu item
  async function handleCreateItem(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim() || !newCategory.trim() || !newPrice.trim()) {
      toast.error('Preencha nome, categoria e preço.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/menu', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newName.trim(),
          price: newPrice.trim(),
          category: newCategory.trim(),
          description: newDescription.trim() || undefined,
          emoji: newEmoji.trim() || '🥟',
          is_available: newAvailable,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Erro ao criar item.');
      }

      const { item } = await res.json();
      setItems((prev) => [...prev, item]);
      toast.success(`Item "${item.name}" adicionado com sucesso!`);

      // Reset form and close dialog
      setNewName('');
      setNewPrice('');
      setNewDescription('');
      setNewEmoji('🥟');
      setNewAvailable(true);
      setDialogOpen(false);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'Falha ao cadastrar item.';
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  }

  // Clipboard & Sharing helpers
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
    const text = buildWhatsappMenuText(items as DynamicMenuItem[]);
    void copyToClipboard(
      text,
      'Cardápio copiado! Cole no WhatsApp para enviar.'
    );
  }

  async function handleShare() {
    const text = buildWhatsappMenuText(items as DynamicMenuItem[]);
    if (typeof navigator !== 'undefined' && navigator.share) {
      try {
        await navigator.share({ title: 'La Empanadas — Cardápio', text });
        return;
      } catch {
        // Fallback to clipboard
      }
    }
    void copyToClipboard(text, 'Cardápio copiado! Compartilhe onde quiser.');
  }

  function handleWhatsappShare() {
    const text = encodeURIComponent(
      buildWhatsappMenuText(items as DynamicMenuItem[])
    );
    window.open(`https://wa.me/?text=${text}`, '_blank', 'noopener');
  }

  return (
    <div className="space-y-6">
      {/* Cabeçalho */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-foreground text-2xl font-bold">Cardápio</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Gerencie sabores, preços e ative/pause itens esgotados em tempo real.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => setDialogOpen(true)} className="gap-2 shadow-sm">
            <Plus className="h-4 w-4" />
            Novo Item
          </Button>
          <Button variant="outline" onClick={handleCopyMenu}>
            {copied ? (
              <Check className="h-4 w-4" />
            ) : (
              <Copy className="h-4 w-4" />
            )}
            Copiar WhatsApp
          </Button>
          <Button variant="outline" onClick={handleShare}>
            <Share2 className="h-4 w-4" />
            Compartilhar
          </Button>
          <Button variant="secondary" onClick={handleWhatsappShare}>
            <MessageCircle className="h-4 w-4" />
            WhatsApp
          </Button>
        </div>
      </div>

      {/* Loading state */}
      {loading ? (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="h-8 w-8 animate-spin mb-3 text-primary" />
          <p className="text-sm">Carregando itens do cardápio...</p>
        </div>
      ) : error ? (
        <div className="rounded-lg border border-destructive/20 bg-destructive/10 p-4 text-destructive flex items-center gap-3">
          <AlertCircle className="h-5 w-5 shrink-0" />
          <p className="text-sm">{error}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={fetchMenu}
            className="ml-auto"
          >
            Tentar novamente
          </Button>
        </div>
      ) : groupedCategories.length === 0 ? (
        <Card className="p-8 text-center">
          <div className="max-w-sm mx-auto space-y-3">
            <p className="text-3xl">🥟</p>
            <h3 className="text-lg font-semibold text-foreground">
              Nenhum item cadastrado
            </h3>
            <p className="text-sm text-muted-foreground">
              Cadastre o primeiro item do seu cardápio clicando no botão abaixo.
            </p>
            <Button onClick={() => setDialogOpen(true)} className="mt-2">
              <Plus className="h-4 w-4 mr-2" />
              Adicionar Primeiro Item
            </Button>
          </div>
        </Card>
      ) : (
        /* Categorias e Itens */
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
          {groupedCategories.map((group) => {
            const total = group.items.length;
            const availableCount = group.items.filter(
              (i) => i.is_available
            ).length;

            return (
              <Card key={group.category} className="flex flex-col">
                <CardHeader className="pb-3 border-b border-border/50">
                  <div className="flex items-center justify-between">
                    <CardTitle className="flex items-center gap-2 text-lg">
                      <span aria-hidden>{group.emoji}</span>
                      {group.category}
                    </CardTitle>
                    <Badge variant="outline" className="text-xs">
                      {availableCount}/{total} disponíveis
                    </Badge>
                  </div>
                  {group.subtitle ? (
                    <CardDescription>{group.subtitle}</CardDescription>
                  ) : null}
                </CardHeader>

                <CardContent className="flex-1 p-0">
                  <ul className="divide-border divide-y">
                    {group.items.map((item) => (
                      <li
                        key={item.id}
                        className={`flex items-center justify-between gap-3 p-3.5 transition-colors ${
                          item.is_available
                            ? 'hover:bg-muted/40'
                            : 'bg-muted/20 opacity-75'
                        }`}
                      >
                        {/* Detalhes do Item */}
                        <div className="flex min-w-0 items-start gap-2.5">
                          <span
                            className="text-xl leading-none mt-0.5 select-none"
                            aria-hidden
                          >
                            {item.emoji || '🥟'}
                          </span>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <p
                                className={`text-sm font-medium leading-snug ${
                                  item.is_available
                                    ? 'text-foreground'
                                    : 'text-muted-foreground line-through'
                                }`}
                              >
                                {item.name}
                              </p>
                            </div>
                            {item.description ? (
                              <p className="text-muted-foreground text-xs line-clamp-2 mt-0.5">
                                {item.description}
                              </p>
                            ) : null}
                            <div className="mt-1 flex items-center gap-2">
                              <span className="text-primary font-semibold text-xs">
                                {formatBRL(item.price)}
                              </span>
                              <Badge
                                variant={item.is_available ? 'secondary' : 'destructive'}
                                className="text-[10px] px-1.5 py-0 h-4"
                              >
                                {item.is_available ? 'Disponível' : 'Pausado'}
                              </Badge>
                            </div>
                          </div>
                        </div>

                        {/* Switch de Ativação / Pausa em tempo real */}
                        <div className="flex items-center gap-2 shrink-0 pl-2">
                          <span className="text-xs text-muted-foreground hidden sm:inline">
                            {item.is_available ? 'Ativo' : 'Pausado'}
                          </span>
                          <Switch
                            checked={item.is_available}
                            onCheckedChange={() =>
                              void handleToggleAvailability(item)
                            }
                            aria-label={`Alternar disponibilidade de ${item.name}`}
                          />
                        </div>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Modal / Dialog Novo Item */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="border-border bg-popover text-popover-foreground sm:max-w-md">
          <form onSubmit={handleCreateItem}>
            <DialogHeader>
              <DialogTitle>Novo Item do Cardápio</DialogTitle>
              <DialogDescription>
                Cadastre um sabor, preço e categoria para disponibilizar no cardápio.
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-4 py-4">
              {/* Nome / Sabor */}
              <div className="space-y-1.5">
                <Label htmlFor="item-name">Nome / Sabor *</Label>
                <Input
                  id="item-name"
                  placeholder="Ex: Carne ao molho, Frango com Catupiry"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  required
                />
              </div>

              {/* Categoria */}
              <div className="space-y-1.5">
                <Label htmlFor="item-category">Categoria *</Label>
                <Input
                  id="item-category"
                  placeholder="Ex: Empanadas Clássicas, Bebidas, etc."
                  list="categories-list"
                  value={newCategory}
                  onChange={(e) => setNewCategory(e.target.value)}
                  required
                />
                <datalist id="categories-list">
                  {existingCategories.map((c) => (
                    <option key={c} value={c} />
                  ))}
                </datalist>
              </div>

              {/* Preço e Emoji */}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="item-price">Preço (R$) *</Label>
                  <Input
                    id="item-price"
                    placeholder="8,50"
                    value={newPrice}
                    onChange={(e) => setNewPrice(e.target.value)}
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="item-emoji">Emoji</Label>
                  <Input
                    id="item-emoji"
                    placeholder="🥟"
                    value={newEmoji}
                    onChange={(e) => setNewEmoji(e.target.value)}
                    maxLength={4}
                  />
                </div>
              </div>

              {/* Descrição */}
              <div className="space-y-1.5">
                <Label htmlFor="item-description">Descrição (Opcional)</Label>
                <Input
                  id="item-description"
                  placeholder="Ex: Queijo derretido, presunto magro e orégano"
                  value={newDescription}
                  onChange={(e) => setNewDescription(e.target.value)}
                />
              </div>

              {/* Status Inicial */}
              <div className="flex items-center justify-between pt-1">
                <Label htmlFor="item-available" className="cursor-pointer">
                  Disponível para venda imediatamente
                </Label>
                <Switch
                  id="item-available"
                  checked={newAvailable}
                  onCheckedChange={setNewAvailable}
                />
              </div>
            </div>

            <DialogFooter className="gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setDialogOpen(false)}
                disabled={submitting}
              >
                Cancelar
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    Cadastrando...
                  </>
                ) : (
                  'Cadastrar Item'
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
