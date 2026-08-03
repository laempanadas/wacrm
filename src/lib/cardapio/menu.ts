/**
 * Cardápio — fonte única de verdade do menu do La Empanadas.
 *
 * Usado tanto pela página visual do Cardápio quanto pela geração do
 * texto formatado para envio no WhatsApp. Manter preços e sabores
 * aqui evita divergência entre a tela e a mensagem compartilhada.
 */

export interface MenuItem {
  /** Emoji ilustrativo do item. */
  emoji: string;
  /** Nome do sabor / produto. */
  name: string;
  /** Descrição opcional (usada em combos e itens especiais). */
  description?: string;
  /** Preço em reais (BRL). */
  price: number;
}

export interface MenuCategory {
  /** Título da categoria exibido no card. */
  title: string;
  /** Emoji da categoria. */
  emoji: string;
  /** Subtítulo opcional (ex.: "R$ 8,50 cada"). */
  subtitle?: string;
  items: MenuItem[];
}

export const MENU: MenuCategory[] = [
  {
    title: 'Empanadas Clássicas',
    emoji: '🫔',
    subtitle: 'R$ 8,50 cada',
    items: [
      { emoji: '🥩', name: 'Carne ao molho', price: 8.5 },
      { emoji: '🐔', name: 'Frango com catupiry', price: 8.5 },
      { emoji: '🧀', name: 'Queijo e presunto', price: 8.5 },
      { emoji: '🧅', name: 'Cebola com azeitona', price: 8.5 },
      { emoji: '🥚', name: 'Ovo com milho', price: 8.5 },
    ],
  },
  {
    title: 'Empanadas Especiais',
    emoji: '⭐',
    subtitle: 'R$ 10,50 cada',
    items: [
      { emoji: '🦐', name: 'Camarão com cream cheese', price: 10.5 },
      { emoji: '🥩', name: 'Carne com bacon e queijo', price: 10.5 },
      {
        emoji: '🌱',
        name: 'Vegana',
        description: 'abobrinha, espinafre e tomate seco',
        price: 10.5,
      },
      {
        emoji: '🍕',
        name: 'Pizza',
        description: 'molho, queijo e pepperoni',
        price: 10.5,
      },
    ],
  },
  {
    title: 'Combos',
    emoji: '📦',
    subtitle: 'Qualquer sabor',
    items: [
      { emoji: '🥟', name: 'Combo 6 unidades', price: 48.0 },
      { emoji: '🥟', name: 'Combo 12 unidades', price: 90.0 },
      { emoji: '🥟', name: 'Combo 24 unidades', price: 170.0 },
    ],
  },
  {
    title: 'Bebidas',
    emoji: '🥤',
    items: [
      { emoji: '🥫', name: 'Refrigerante lata 350ml', price: 5.0 },
      { emoji: '💧', name: 'Água mineral', price: 3.0 },
      { emoji: '🧃', name: 'Suco natural', price: 7.0 },
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

/**
 * Gera o texto do cardápio formatado para envio no WhatsApp
 * (usa *negrito* do WhatsApp e emojis).
 */
export function buildWhatsappMenuText(): string {
  const lines: string[] = [];
  lines.push('🫔 *La Empanadas — Cardápio* 🫔');
  lines.push('');

  for (const category of MENU) {
    const header = category.subtitle
      ? `${category.emoji} *${category.title}* (${category.subtitle})`
      : `${category.emoji} *${category.title}*`;
    lines.push(header);
    for (const item of category.items) {
      const desc = item.description ? ` (${item.description})` : '';
      lines.push(
        `${item.emoji} ${item.name}${desc} — ${formatBRL(item.price)}`
      );
    }
    lines.push('');
  }

  lines.push('📲 Faça seu pedido pelo WhatsApp!');
  return lines.join('\n').trim();
}
