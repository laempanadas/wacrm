/**
 * Nomes dos produtos do catálogo da Meta a partir do cardápio do site.
 *
 * Pedidos do catálogo chegam só com o `product_retailer_id` (ex.:
 * "beb_coca_2l"). O `assets/js/cardapio.json` — a mesma fonte das
 * páginas de produto — usa esses ids, então resolvemos o nome aqui sem
 * depender de uma chamada à Graph API.
 */

import cardapio from '../../../assets/js/cardapio.json';

// Ids no catálogo às vezes têm espaço extra ou caixa diferente
// ("emp_ Frango com Espinafre e Cheddar"); compara normalizado.
const normalize = (id: string) => id.toLowerCase().replace(/\s+/g, '');

const NAMES = new Map<string, string>(
  (cardapio.itens as Array<{ id: string; nome: string }>).map((item) => [
    normalize(item.id),
    item.nome,
  ])
);

export function productNameFromCardapio(
  retailerId: string
): string | undefined {
  return NAMES.get(normalize(retailerId));
}
