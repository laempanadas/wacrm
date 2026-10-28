import { classifyNote } from './kitchen-notes';
import {
  extractAddressFromText,
  isCompleteDeliveryAddress,
  isAddressConfirmation,
  parseCatalogOrder,
  type ParsedOrderItem,
  type ProductCatalogEntry,
} from './text-order-parser';

export interface OrderDraft {
  id: string;
  version: number;
  items: ParsedOrderItem[];
  unresolved: string[];
  stage:
    | 'collecting'
    | 'awaiting_address'
    | 'awaiting_confirmation'
    | 'needs_human'
    | 'payment_created';
  deliveryAddress?: string;
  paymentReference?: string;
  cartUpdatedAt?: string;
  total: number;
}

export interface DraftTransition {
  draft: OrderDraft;
  reply: string;
  checkout: boolean;
}

const normalized = (text: string) =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
export const orderLineKey = (item: ParsedOrderItem) =>
  `${item.id}:${normalized(item.notes || '')}`;
export function orderSummary(draft: OrderDraft): string {
  return draft.items
    .map((item, index) => {
      const notes = !item.notes
        ? ''
        : classifyNote(item.notes) === 'safe'
          ? `\n📝 Obs.: ${item.notes}`
          : ` — ${item.notes}`;
      return `${index + 1}. ${item.quantity}x ${item.title}${notes}`;
    })
    .join('\n');
}

function summaryReply(draft: OrderDraft, previous: OrderDraft): string {
  const summary = `La Empanadas — Resumo do pedido\n${orderSummary(draft)}`;
  if (draft.stage === 'needs_human')
    return `${summary}\n${draft.unresolved.length ? `Não confirmado: ${draft.unresolved.join('; ')}\n` : ''}As observações/itens precisam de esclarecimento ou aprovação da cozinha. Um atendente deve revisar. Nenhuma cobrança foi gerada.`;
  const total = `Total: R$ ${draft.total.toFixed(2).replace('.', ',')}`;
  if (!isCompleteDeliveryAddress(draft.deliveryAddress || '')) {
    const quantity = draft.items.reduce((sum, item) => sum + item.quantity, 0);
    const noun = draft.items.every((item) => /^empanada\b/i.test(item.title))
      ? quantity === 1
        ? 'empanada'
        : 'empanadas'
      : quantity === 1
        ? 'item'
        : 'itens';
    const notes = draft.items
      .filter((item) => item.notes)
      .map((item) => `📝 Obs.: ${item.notes}`)
      .join('\n');
    return `Anotado! Temos ${quantity} ${noun} no seu pedido. Gostaria de adicionar mais alguma coisa ou podemos fechar? Para fechar, envie o endereço completo (Rua, Número e Bairro).${notes ? `\n${notes}` : ''}`;
  }
  if (
    previous.stage === 'awaiting_confirmation' &&
    previous.version === draft.version
  )
    return 'Seu pedido continua salvo. Responda CONFIRMO O PEDIDO para gerar o pagamento, ou envie uma correção.';
  return `${summary}\n🚚 Entrega: *GRÁTIS*\n${total}\nEndereço: ${draft.deliveryAddress}\nConfira todas as linhas e observações. Responda CONFIRMO O PEDIDO para gerar o pagamento, ou envie uma correção.`;
}

/** Pure transition: no gateway, messages or inferred state from bot prose. */
export function advanceOrderDraft(
  previous: OrderDraft,
  text: string,
  catalog: ProductCatalogEntry[],
  savedAddress?: string | null
): DraftTransition {
  const input = normalized(text);
  const confirms = /^(?:confirmo(?: o pedido)?|confirmar pedido|sim)$/.test(
    input
  );
  if (previous.stage === 'payment_created')
    return {
      draft: previous,
      checkout: false,
      reply:
        'Este pedido já foi encaminhado para pagamento. Para alterar ou iniciar outro pedido, fale com um atendente; não geramos outra cobrança automaticamente.',
    };
  if (/^(?:oi|ola|alo|bom dia|boa tarde|boa noite)[\s.!?]*$/.test(input))
    return {
      draft: previous,
      checkout: false,
      reply:
        'Olá! Como posso ajudar com seu pedido? Seu carrinho continua salvo.',
    };
  const draft: OrderDraft = structuredClone(previous);
  const removeLine = /^(?:remova|retire|tire) (?:a )?linha (\d+)$/.exec(input);
  const editLine =
    /^(?:altere|corrija|mude) (?:a )?linha (\d+) para (.+)$/i.exec(text.trim());
  const parsed = parseCatalogOrder(
    removeLine ? '' : editLine ? editLine[2] : text,
    catalog
  );
  // Match complete conversational replies only; kitchen notes and item changes
  // must still be preserved for review, never discarded as small talk.
  const conversationalInput = input.replace(/[.!?]+$/, '').trim();
  let conversationalReply: string | undefined;
  if (
    !parsed.hasItems &&
    !parsed.unresolved?.length &&
    !parsed.deliveryAddress
  ) {
    if (
      /^(?:vixi(?: esta)?(?: meio)? confuso|(?:esta|ficou)(?: meio)? confuso|nao entendi|seria (?:este|esse|o) pedido)$/.test(
        conversationalInput
      )
    )
      conversationalReply =
        'Sem problema! Seu pedido continua salvo, sem alterações.';
    else if (
      /^(?:qual (?:o )?(?:valor|preco|taxa)(?: da| de)? entrega|(?:a )?entrega e gratis|tem taxa de entrega)$/.test(
        conversationalInput
      )
    )
      conversationalReply = 'A entrega é GRÁTIS, sem taxa adicional.';
    else if (
      /^(?:ok|okay|certo|beleza|obrigado|obrigada|podemos fechar|pode fechar|fechar|finalizar|so isso|e so isso)$/.test(
        conversationalInput
      )
    )
      conversationalReply = 'Certo! Seu pedido está salvo.';
  }
  const isCorrection = /^na verdade\b/.test(input);
  const hadItems = draft.items.length > 0;
  const replacement = /^(.+?) nao e (.+?),\s*e (?:o |a )?(.+?)[.!?]*$/.exec(
    input
  );
  let naturalChange:
    { index: number; product: ProductCatalogEntry } | undefined;
  if (replacement) {
    const [, subject, rejected, destination] = replacement;
    const sourceNames = [
      `${subject} ${rejected}`,
      `${subject} com ${rejected}`,
      `${subject} e ${rejected}`,
    ];
    const sources = catalog.filter((product) =>
      [product.nome, ...product.aliases].some((alias) =>
        sourceNames.includes(normalized(alias))
      )
    );
    const destinations = catalog.filter((product) =>
      [product.nome, ...product.aliases].some(
        (alias) => normalized(alias) === destination
      )
    );
    const targets = draft.items
      .map((item, index) => (item.id === sources[0]?.id ? index : -1))
      .filter((index) => index >= 0);
    if (
      sources.length === 1 &&
      destinations.length === 1 &&
      targets.length === 1
    )
      naturalChange = { index: targets[0], product: destinations[0] };
  }
  const ambiguousChange =
    !removeLine &&
    !editLine &&
    !naturalChange &&
    !conversationalReply &&
    /\b(?:nao|troque|substitua|remova|retire|tire|cancele)\b/.test(input);
  if (removeLine) {
    const index = Number(removeLine[1]) - 1;
    if (index < 0 || index >= draft.items.length)
      draft.unresolved.push('Qual linha deseja remover?');
    else {
      draft.items.splice(index, 1);
      draft.version += 1;
    }
  }
  if (naturalChange) {
    const { index, product } = naturalChange;
    draft.items[index] = {
      ...draft.items[index],
      id: product.id,
      title: product.nome,
      unitPrice: product.preco,
      requestedText: text.trim(),
    };
    draft.version += 1;
  } else if (ambiguousChange)
    draft.unresolved.push(`Esclarecer alteração: ${text.trim()}`);
  else if (parsed.hasItems || parsed.unresolved?.length) {
    // Only explicitly requested corrections may change a previous-turn quantity.
    if (!hadItems) draft.items = parsed.items;
    else if (editLine) {
      const index = Number(editLine[1]) - 1;
      if (index < 0 || index >= draft.items.length || parsed.items.length !== 1)
        draft.unresolved.push(
          'Informe uma linha válida e um único item para a correção.'
        );
      else draft.items[index] = parsed.items[0];
    } else {
      const incomingLineCounts = new Map<string, number>();
      for (const item of parsed.items) {
        const key = orderLineKey(item);
        incomingLineCounts.set(key, (incomingLineCounts.get(key) ?? 0) + 1);
      }
      for (const item of parsed.items) {
        // A line appended in this inbound is never a correction target.
        const targets = previous.items
          .map((line, index) =>
            orderLineKey(line) === orderLineKey(item) ? index : -1
          )
          .filter((index) => index >= 0);
        // Resolve the whole inbound group before applying any correction,
        // including no-op quantities. Reusing a target would drop a line.
        if (
          isCorrection &&
          targets.length &&
          (incomingLineCounts.get(orderLineKey(item)) ?? 0) > 1
        ) {
          draft.unresolved.push(
            `Esclarecer linhas repetidas na alteração: ${text.trim()}`
          );
          continue;
        }
        if (isCorrection && targets.length > 1)
          draft.unresolved.push(
            `Qual linha deve ser alterada: ${item.requestedText || item.title}?`
          );
        else if (
          targets.length === 1 &&
          (incomingLineCounts.get(orderLineKey(item)) ?? 0) === 1
        ) {
          const target = targets[0];
          if (isCorrection) draft.items[target] = item;
          else if (
            Number.isSafeInteger(draft.items[target].quantity + item.quantity)
          ) {
            draft.items[target].quantity += item.quantity;
          } else
            draft.unresolved.push(
              `Quantidade fora do limite: ${item.requestedText || item.title}`
            );
        } else draft.items.push(item);
      }
    }
    draft.unresolved.push(...(parsed.unresolved ?? []));
    draft.version += 1;
  }
  const address = parsed.deliveryAddress || extractAddressFromText(text);
  if (address) {
    if (address !== draft.deliveryAddress) {
      draft.deliveryAddress = address;
      draft.version += 1;
    }
  } else if (
    previous.stage === 'awaiting_address' &&
    isAddressConfirmation(text) &&
    savedAddress
  ) {
    draft.deliveryAddress = savedAddress;
    draft.version += 1;
  } else if (
    text.trim() &&
    !confirms &&
    !removeLine &&
    !ambiguousChange &&
    !naturalChange &&
    !conversationalReply &&
    !parsed.hasItems &&
    !parsed.unresolved?.length
  ) {
    // A follow-up that was not consumed is not consent. Preserve it for review.
    draft.unresolved.push(text.trim());
    draft.version += 1;
  }

  // Revalidate all lines on every turn, including confirmation. Price changes invalidate consent.
  let catalogChanged = false;
  for (const item of draft.items) {
    const product = catalog.find((entry) => entry.id === item.id);
    if (!product) {
      draft.unresolved.push(`Item indisponível no catálogo: ${item.title}`);
      continue;
    }
    if (item.unitPrice !== product.preco || item.title !== product.nome)
      catalogChanged = true;
    item.unitPrice = product.preco;
    item.title = product.nome;
    item.totalPrice = (Math.round(product.preco * 100) * item.quantity) / 100;
  }
  if (catalogChanged) draft.version += 1;
  draft.total =
    draft.items.reduce(
      (sum, item) => sum + Math.round(item.totalPrice * 100),
      0
    ) / 100;
  draft.unresolved = Array.from(new Set(draft.unresolved));
  draft.stage =
    !draft.items.length ||
    draft.unresolved.length ||
    draft.items.some(
      (item) => item.notes && classifyNote(item.notes) === 'review'
    ) ||
    previous.stage === 'needs_human'
      ? 'needs_human'
      : isCompleteDeliveryAddress(draft.deliveryAddress || '')
        ? 'awaiting_confirmation'
        : 'awaiting_address';
  const checkout =
    confirms &&
    previous.stage === 'awaiting_confirmation' &&
    draft.stage === 'awaiting_confirmation' &&
    draft.version === previous.version &&
    draft.items.length > 0;
  const reply =
    conversationalReply &&
    draft.stage !== 'needs_human' &&
    previous.version === draft.version
      ? `${conversationalReply} ${
          draft.stage === 'awaiting_address'
            ? 'Por favor, envie o endereço completo (Rua, Número e Bairro).'
            : 'Para gerar o pagamento, responda CONFIRMO O PEDIDO, ou envie uma correção.'
        }`
      : summaryReply(draft, previous);
  return { draft, checkout, reply };
}
