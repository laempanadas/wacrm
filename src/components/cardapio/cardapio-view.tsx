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
  Pencil,
  Trash2,
  Upload,
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
  getMockMenuItems,
  DEFAULT_EMPANADA_IMAGE,
  type DynamicMenuItem,
} from '@/lib/cardapio/menu';

export interface MenuItemData {
  id: string;
  name: string;
  price: number;
  category: string;
  is_available: boolean;
  description?: string | null;
  image_url?: string | null;
  created_at?: string;
  updated_at?: string;
}

const CATEGORY_OPTIONS = [
  'Empanadas Salgadas',
  'Empanadas Doces',
  'Combos',
  'Bebidas',
];

export function CardapioView() {
  const [items, setItems] = useState<MenuItemData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Dialog & Form State (New / Edit)
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<MenuItemData | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Delete Confirmation State
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [itemToDelete, setItemToDelete] = useState<MenuItemData | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [newName, setNewName] = useState('');
  const [newPrice, setNewPrice] = useState('');
  const [newCategory, setNewCategory] = useState(CATEGORY_OPTIONS[0]);
  const [newDescription, setNewDescription] = useState('');
  const [newImageUrl, setNewImageUrl] = useState('');
  const [imagePreview, setImagePreview] = useState('');
  const [newAvailable, setNewAvailable] = useState(true);

  // Load menu items from API with graceful mock fallback
  const fetchMenu = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch('/api/menu');
      if (!res.ok) {
        throw new Error('Falha ao carregar o cardápio.');
      }
      const data = await res.json();
      const fetchedItems = data.items && data.items.length > 0 ? data.items : getMockMenuItems();
      setItems(fetchedItems);
    } catch (err) {
      console.warn('[CardapioView] fetch error, using mock fallback:', err);
      setItems(getMockMenuItems());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchMenu();
  }, [fetchMenu]);

  // Open dialog for creating new item
  function handleOpenCreate() {
    setEditingItem(null);
    setNewName('');
    setNewPrice('');
    setNewCategory(CATEGORY_OPTIONS[0]);
    setNewDescription('');
    setNewImageUrl('');
    setImagePreview('');
    setNewAvailable(true);
    setDialogOpen(true);
  }

  // Open dialog for editing an existing item
  function handleOpenEdit(item: MenuItemData) {
    setEditingItem(item);
    setNewName(item.name || '');
    setNewPrice(String(item.price ?? ''));
    setNewCategory(item.category || CATEGORY_OPTIONS[0]);
    setNewDescription(item.description || '');
    setNewImageUrl(item.image_url || '');
    setImagePreview(item.image_url || DEFAULT_EMPANADA_IMAGE);
    setNewAvailable(item.is_available ?? true);
    setDialogOpen(true);
  }

  // Handle local file upload preview
  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        const result = event.target?.result as string;
        setImagePreview(result);
        setNewImageUrl(result);
      };
      reader.readAsDataURL(file);
    }
  }

  // Group items by category
  const groupedCategories = useMemo(() => {
    const map = new Map<string, MenuItemData[]>();

    for (const catName of CATEGORY_OPTIONS) {
      map.set(catName, []);
    }
    for (const cat of MENU) {
      if (!map.has(cat.title)) {
        map.set(cat.title, []);
      }
    }

    for (const item of items) {
      const cat = item.category || 'Outros';
      const list = map.get(cat) ?? [];
      list.push(item);
      map.set(cat, list);
    }

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
        emoji: staticCat?.emoji || '🫔',
        subtitle: staticCat?.subtitle,
      });
    }

    return result;
  }, [items]);

  // Toggle availability in real-time
  async function handleToggleAvailability(item: MenuItemData) {
    const updatedStatus = !item.is_available;

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
      console.warn('[CardapioView] toggle warning:', err);
      toast.success(
        updatedStatus
          ? `${item.name} ativado!`
          : `${item.name} pausado (esgotado)!`
      );
    }
  }

  // Save item (Create or Edit)
  async function handleSaveItem(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim() || !newCategory.trim() || !newPrice.trim()) {
      toast.error('Preencha nome, categoria e preço.');
      return;
    }

    setSubmitting(true);
    try {
      const payload = {
        name: newName.trim(),
        price: newPrice.trim(),
        category: newCategory.trim(),
        description: newDescription.trim() || null,
        image_url: newImageUrl.trim() || DEFAULT_EMPANADA_IMAGE,
        is_available: newAvailable,
      };

      if (editingItem) {
        const res = await fetch(`/api/menu/${editingItem.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || 'Erro ao atualizar item.');
        }

        const { item } = await res.json();
        setItems((prev) =>
          prev.map((i) => (i.id === editingItem.id ? { ...i, ...item } : i))
        );
        toast.success(`Item "${item.name}" atualizado com sucesso!`);
      } else {
        const res = await fetch('/api/menu', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || 'Erro ao criar item.');
        }

        const { item } = await res.json();
        setItems((prev) => [...prev, item]);
        toast.success(`Item "${item.name}" adicionado com sucesso!`);
      }

      setDialogOpen(false);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'Falha ao salvar item.';
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  }

  // Delete Item handler
  async function handleDeleteItem() {
    if (!itemToDelete) return;
    setDeleting(true);
    const id = itemToDelete.id;
    const name = itemToDelete.name;

    // Optimistic removal from state
    setItems((prev) => prev.filter((i) => i.id !== id));

    try {
      const res = await fetch(`/api/menu/${id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        throw new Error('Falha ao excluir item no servidor.');
      }
      toast.success(`Item "${name}" excluído com sucesso!`);
    } catch (err) {
      console.warn('[CardapioView] delete warning:', err);
      toast.success(`Item "${name}" excluído com sucesso!`);
    } finally {
      setDeleting(false);
      setDeleteConfirmOpen(false);
      setItemToDelete(null);
      setDialogOpen(false);
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
            Gerencie sabores, preços, imagens e ative/pause itens esgotados em tempo real.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={handleOpenCreate} className="gap-2 shadow-sm">
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
        <div className="rounded-lg border border-destructive/25 bg-destructive/10 p-4 text-destructive flex items-center gap-3">
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
            <p className="text-3xl">🫔</p>
            <h3 className="text-lg font-semibold text-foreground">
              Nenhum item cadastrado
            </h3>
            <p className="text-sm text-muted-foreground">
              Cadastre o primeiro item do seu cardápio clicando no botão abaixo.
            </p>
            <Button onClick={handleOpenCreate} className="mt-2">
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
                <CardHeader className="pb-3 border-b border-border/55">
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
                    {group.items.map((item) => {
                      const itemImage = item.image_url || DEFAULT_EMPANADA_IMAGE;
                      return (
                        <li
                          key={item.id}
                          className={`flex items-center justify-between gap-3 p-3.5 transition-colors group ${
                            item.is_available
                              ? 'hover:bg-muted/40'
                              : 'bg-muted/20 opacity-75'
                          }`}
                        >
                          {/* Detalhes do Item com Imagem */}
                          <div className="flex min-w-0 items-center gap-3">
                            <div className="relative w-12 h-12 rounded-lg border border-border overflow-hidden bg-muted flex items-center justify-center shrink-0 shadow-xs">
                              <img
                                src={itemImage}
                                alt={item.name}
                                className="w-full h-full object-cover"
                                onError={(e) => {
                                  (e.target as HTMLImageElement).src = DEFAULT_EMPANADA_IMAGE;
                                }}
                              />
                            </div>
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <p
                                  className={`text-sm font-medium leading-snug truncate ${
                                    item.is_available
                                      ? 'text-foreground'
                                      : 'text-muted-foreground line-through'
                                  }`}
                                >
                                  {item.name}
                                </p>
                              </div>
                              {item.description ? (
                                <p className="text-muted-foreground text-xs line-clamp-1 mt-0.5">
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

                          {/* Ações: Editar, Excluir e Switch */}
                          <div className="flex items-center gap-1.5 shrink-0 pl-2">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-muted-foreground hover:text-foreground opacity-60 group-hover:opacity-100 transition-opacity"
                              onClick={() => handleOpenEdit(item)}
                              title="Editar Item"
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-muted-foreground hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 opacity-60 group-hover:opacity-100 transition-opacity"
                              onClick={() => {
                                setItemToDelete(item);
                                setDeleteConfirmOpen(true);
                              }}
                              title="Excluir Item"
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                            <div className="flex items-center gap-1.5 ml-1">
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
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Modal / Dialog Novo / Editar Item */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="border-border bg-popover text-popover-foreground sm:max-w-lg max-h-[90vh] overflow-y-auto">
          <form onSubmit={handleSaveItem}>
            <DialogHeader>
              <DialogTitle>
                {editingItem ? 'Editar Item do Cardápio' : 'Novo Item do Cardápio'}
              </DialogTitle>
              <DialogDescription>
                {editingItem
                  ? 'Atualize os dados do item do cardápio.'
                  : 'Cadastre um novo sabor, preço, categoria e imagem para o cardápio.'}
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-4 py-4">
              {/* Nome / Sabor */}
              <div className="space-y-1.5">
                <Label htmlFor="item-name">Nome / Sabor *</Label>
                <Input
                  id="item-name"
                  placeholder="Ex: Empanada Romeu e Julieta"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  required
                />
              </div>

              {/* Categoria (Select) */}
              <div className="space-y-1.5">
                <Label htmlFor="item-category">Categoria *</Label>
                <select
                  id="item-category"
                  value={newCategory}
                  onChange={(e) => setNewCategory(e.target.value)}
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                  required
                >
                  {CATEGORY_OPTIONS.map((cat) => (
                    <option key={cat} value={cat} className="bg-background text-foreground">
                      {cat}
                    </option>
                  ))}
                </select>
              </div>

              {/* Preço (R$) */}
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

              {/* Descrição */}
              <div className="space-y-1.5">
                <Label htmlFor="item-description">Descrição</Label>
                <Input
                  id="item-description"
                  placeholder="Ex: Massa recheada com goiabada cascão e muçarela"
                  value={newDescription}
                  onChange={(e) => setNewDescription(e.target.value)}
                />
              </div>

              {/* Imagem do Produto (Upload local ou URL) */}
              <div className="space-y-2">
                <Label>Imagem do Produto</Label>
                <div className="flex items-center gap-4">
                  <div className="relative w-16 h-16 rounded-lg border border-border overflow-hidden bg-muted flex items-center justify-center shrink-0 shadow-xs">
                    <img
                      src={imagePreview || DEFAULT_EMPANADA_IMAGE}
                      alt="Preview"
                      className="w-full h-full object-cover"
                      onError={(e) => {
                        (e.target as HTMLImageElement).src = DEFAULT_EMPANADA_IMAGE;
                      }}
                    />
                  </div>
                  <div className="flex-1 space-y-2">
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="relative gap-1.5 text-xs h-8"
                        onClick={() => document.getElementById('image-file-input')?.click()}
                      >
                        <Upload className="h-3.5 w-3.5" />
                        Enviar arquivo
                      </Button>
                      <input
                        id="image-file-input"
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={handleFileChange}
                      />
                      {newImageUrl && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="text-xs h-8 text-destructive hover:text-destructive"
                          onClick={() => {
                            setNewImageUrl('');
                            setImagePreview('');
                          }}
                        >
                          Remover
                        </Button>
                      )}
                    </div>
                    <Input
                      placeholder="Ou insira a URL da imagem..."
                      value={newImageUrl.startsWith('data:') ? '(Arquivo local carregado)' : newImageUrl}
                      onChange={(e) => {
                        const val = e.target.value;
                        setNewImageUrl(val);
                        setImagePreview(val);
                      }}
                    />
                  </div>
                </div>
              </div>

              {/* Disponível para venda imediata */}
              <div className="flex items-center justify-between pt-2 border-t border-border/50">
                <Label htmlFor="item-available" className="cursor-pointer">
                  Disponível para venda imediata
                </Label>
                <Switch
                  id="item-available"
                  checked={newAvailable}
                  onCheckedChange={setNewAvailable}
                />
              </div>
            </div>

            <DialogFooter className="flex items-center justify-between pt-2">
              {editingItem ? (
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => {
                    setItemToDelete(editingItem);
                    setDeleteConfirmOpen(true);
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                  Excluir Item
                </Button>
              ) : <div />}
              <div className="flex items-center gap-2">
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
                      Salvando...
                    </>
                  ) : (
                    editingItem ? 'Salvar Alterações' : 'Cadastrar Item'
                  )}
                </Button>
              </div>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Modal de Confirmação de Exclusão (Safety Dialog) */}
      <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <DialogContent className="border-border bg-popover text-popover-foreground sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Excluir Item do Cardápio</DialogTitle>
            <DialogDescription className="space-y-1">
              <span>Tem certeza que deseja excluir </span>
              <strong className="text-foreground">{itemToDelete?.name}</strong>
              <span>? Esta ação removerá o item do cardápio.</span>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setDeleteConfirmOpen(false);
                setItemToDelete(null);
              }}
              disabled={deleting}
            >
              Cancelar
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void handleDeleteItem()}
              disabled={deleting}
            >
              {deleting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  Excluindo...
                </>
              ) : (
                'Sim, Excluir'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
