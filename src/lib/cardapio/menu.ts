/**
 * Cardápio — fonte única de verdade do menu do La Empanadas (laempanadas.com.br).
 */

export const DEFAULT_EMPANADA_IMAGE =
  'https://images.unsplash.com/photo-1604382355076-af4b0eb60143?w=500&auto=format&fit=crop&q=60';

export interface MenuItem {
  imageUrl?: string;
  name: string;
  description?: string;
  price: number;
}

export interface MenuCategory {
  title: string;
  emoji: string;
  subtitle?: string;
  items: MenuItem[];
}

export const MENU: MenuCategory[] = [
  {
    title: 'Empanadas Salgadas',
    emoji: '🫔',
    subtitle: 'R$ 8,50 cada',
    items: [
      { name: 'Carne ao molho', price: 8.5, description: 'Carne moída temperada com especiarias' },
      { name: 'Frango com catupiry', price: 8.5, description: 'Frango desfiado com requeijão cremoso' },
      { name: 'Queijo e presunto', price: 8.5, description: 'Muçarela derretida com presunto fatiado' },
      { name: 'Cebola com azeitona', price: 8.5, description: 'Cebola caramelizada com azeitonas pretas' },
    ],
  },
  {
    title: 'Empanadas Doces',
    emoji: '🍰',
    subtitle: 'R$ 9,50 cada',
    items: [
      {
        name: 'Empanada Romeu e Julieta',
        description: 'Massa recheada com goiabada cascão e muçarela',
        price: 9.5,
      },
      {
        name: 'Doce de Leite',
        description: 'Recheio cremoso de doce de leite argentino',
        price: 9.5,
      },
    ],
  },
  {
    title: 'Combos',
    emoji: '📦',
    subtitle: 'Qualquer sabor',
    items: [
      { name: 'Combo 6 unidades', description: 'Escolha 6 empanadas de sua preferência', price: 48.0 },
      { name: 'Combo 12 unidades', description: 'Escolha 12 empanadas de sua preferência', price: 90.0 },
      { name: 'Combo 24 unidades', description: 'Escolha 24 empanadas de sua preferência', price: 170.0 },
    ],
  },
  {
    title: 'Bebidas',
    emoji: '🥤',
    items: [
      { name: 'Refrigerante lata 350ml', description: 'Coca-Cola, Guaraná Antarctica ou Sprite', price: 5.0 },
      { name: 'Água mineral', description: 'Garrafa 500ml sem gás', price: 3.0 },
      { name: 'Suco natural', description: 'Laranja ou Limão 300ml', price: 7.0 },
    ],
  },
];

/** Formata um preço em BRL (ex.: 8.5 -> "R$ 8,50"). */
export function formatBRL(value: number): string {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(value);
}

export interface DynamicMenuItem {
  id: string;
  name: string;
  price: number;
  category: string;
  is_available: boolean;
  image_url?: string | null;
  description?: string | null;
}

/**
 * Retorna itens mockados completos para uso como fallback quando a API/banco falhar.
 */
export function getMockMenuItems(): DynamicMenuItem[] {
  const items: DynamicMenuItem[] = [];
  let idCounter = 1;
  for (const cat of MENU) {
    for (const item of cat.items) {
      items.push({
        id: `mock-${idCounter++}`,
        name: item.name,
        price: item.price,
        category: cat.title,
        is_available: true,
        image_url: item.imageUrl || DEFAULT_EMPANADA_IMAGE,
        description: item.description || null,
      });
    }
  }
  return items;
}

/**
 * Gera o texto do cardápio formatado para envio no WhatsApp.
 */
export function buildWhatsappMenuText(customItems?: DynamicMenuItem[]): string {
  const sourceItems = !customItems || customItems.length === 0 ? getMockMenuItems() : customItems;

  const lines: string[] = [];
  lines.push('🫔 *La Empanadas — Cardápio* 🫔');
  lines.push('');

  const categoriesMap = new Map<string, DynamicMenuItem[]>();
  for (const item of sourceItems) {
    const cat = item.category || 'Outros';
    const list = categoriesMap.get(cat) ?? [];
    list.push(item);
    categoriesMap.set(cat, list);
  }

  for (const [catName, items] of categoriesMap.entries()) {
    const knownCat = MENU.find(
      (c) => c.title.toLowerCase() === catName.toLowerCase()
    );
    const emoji = knownCat?.emoji || '🥟';
    lines.push(`${emoji} *${catName}*`);

    for (const item of items) {
      const desc = item.description ? ` (${item.description})` : '';
      const statusNote = item.is_available ? '' : ' _(Esgotado)_';
      lines.push(
        `• ${item.name}${desc} — ${formatBRL(item.price)}${statusNote}`
      );
    }
    lines.push('');
  }

  lines.push('📲 Faça seu pedido pelo WhatsApp!');
  return lines.join('\n').trim();
}
