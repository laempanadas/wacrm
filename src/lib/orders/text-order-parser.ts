/**
 * Parser de Pedidos por Texto Livre para WhatsApp.
 *
 * Utiliza o cardápio oficial (assets/js/cardapio.json) para:
 * 1. Detectar intenção de pedido por texto (hasOrderIntent)
 * 2. Extrair sabores/itens, quantidades e calcular valores (parseTextOrder)
 * 3. Identificar endereço de entrega na mensagem (extractAddressFromText)
 * 4. Identificar confirmação de endereço anterior (isAddressConfirmation)
 */

export interface ParsedOrderItem {
  id: string
  title: string
  quantity: number
  unitPrice: number
  totalPrice: number
}

export interface ParsedOrderResult {
  hasItems: boolean
  items: ParsedOrderItem[]
  total: number
  totalFormatted: string
  deliveryAddress?: string
  rawText: string
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
}

/** Mapa de palavras de números para dígitos numéricos */
const WORD_TO_NUMBER: Record<string, number> = {
  um: 1,
  uma: 1,
  dois: 2,
  duas: 2,
  tres: 3,
  quatro: 4,
  cinco: 5,
  seis: 6,
  sete: 7,
  oito: 8,
  nove: 9,
  dez: 10,
  onze: 11,
  doze: 12,
  'meia duzia': 6,
  'uma duzia': 12,
}

interface ProductCatalogEntry {
  id: string
  nome: string
  preco: number
  aliases: string[]
}

const CATALOG_PRODUCTS: ProductCatalogEntry[] = [
  // Combos
  {
    id: 'combo_quatro_ovomaltine',
    nome: 'Combo 4 Empanadas + Tortinha de Ovomaltine',
    preco: 69.0,
    aliases: [
      'combo 4 empanadas + tortinha de ovomaltine',
      'combo 4 empanadas e tortinha de ovomaltine',
      'combo 4 ovomaltine',
      'combo ovomaltine',
      'combo tortinha',
    ],
  },
  {
    id: 'combo_quatro_cheesecake',
    nome: 'Combo 4 Empanadas + Cheesecake de Frutas Vermelhas',
    preco: 69.0,
    aliases: [
      'combo 4 empanadas + cheesecake de frutas vermelhas',
      'combo 4 empanadas e cheesecake',
      'combo 4 cheesecake',
      'combo cheesecake',
    ],
  },
  {
    id: 'combo_familia',
    nome: 'Combo Família (8 Empanadas Assadas)',
    preco: 102.0,
    aliases: [
      'combo familia (8 empanadas assadas)',
      'combo familia 8 empanadas',
      'combo familia',
      'combo 8 empanadas',
      'combo oito empanadas',
      'combo 8',
    ],
  },
  {
    id: 'combo_coca',
    nome: 'Combo Coca-Cola',
    preco: 62.9,
    aliases: ['combo coca-cola', 'combo coca cola', 'combo coca'],
  },
  {
    id: 'combo_quatro',
    nome: 'Combo 4 Empanadas',
    preco: 52.9,
    aliases: ['combo 4 empanadas', 'combo quatro empanadas', 'combo 4', 'combo quatro'],
  },

  // Bebidas
  {
    id: 'beb_coca_zero_2l',
    nome: 'Coca-Cola zero 2L',
    preco: 25.0,
    aliases: [
      'coca-cola zero 2l',
      'coca zero 2l',
      'coca zero 2 litros',
      'coca zero 2 litro',
      'coca zero dois litros',
      'coca 2l zero',
      'coca 2 litros zero',
    ],
  },
  {
    id: 'beb_coca_2l',
    nome: 'Coca-Cola 2L',
    preco: 25.0,
    aliases: [
      'coca-cola 2l',
      'coca 2l',
      'coca 2 litros',
      'coca 2 litro',
      'coca dois litros',
      'coca garrafa 2l',
      'coca 2 litros original',
      'coca grande',
    ],
  },
  {
    id: 'beb_coca_zero_600',
    nome: 'Coca-Cola Zero 600ml',
    preco: 15.0,
    aliases: [
      'coca-cola zero 600ml',
      'coca zero 600ml',
      'coca zero 600',
      'coca-cola zero 600',
      'coca 600ml zero',
      'coca 600 zero',
    ],
  },
  {
    id: 'beb_coca_600',
    nome: 'Coca-Cola Original 600ml',
    preco: 15.0,
    aliases: [
      'coca-cola original 600ml',
      'coca original 600ml',
      'coca 600ml',
      'coca 600',
      'coca-cola 600ml',
      'coca-cola 600',
      'coca media',
    ],
  },
  {
    id: 'beb_coca_zero_350',
    nome: 'Coca-Cola sem Açúcar 350ml',
    preco: 8.5,
    aliases: [
      'coca-cola sem acucar 350ml',
      'coca sem acucar 350ml',
      'coca sem acucar lata',
      'coca-cola sem acucar lata',
      'coca-cola sem acucar',
      'coca sem acucar',
      'coca zero lata',
      'coca lata zero',
      'coca-cola zero lata',
      'coca-cola zero 350ml',
      'coca zero 350ml',
      'coca zero 350',
      'coca zero',
    ],
  },
  {
    id: 'beb_coca_original_350',
    nome: 'Coca-Cola Original 350ml',
    preco: 8.5,
    aliases: [
      'coca-cola original 350ml',
      'coca original 350ml',
      'coca original lata',
      'coca lata original',
      'coca normal lata',
      'coca lata normal',
      'coca-cola lata',
      'coca lata',
      'coca original',
      'coca normal',
      'coca 350ml',
      'coca 350',
      'coca-cola',
      'coca',
    ],
  },

  // Vinhos
  {
    id: 'vin_san_telmo',
    nome: 'Vinho Tinto Argentino San Telmo Malbec 750ml',
    preco: 79.9,
    aliases: ['vinho san telmo malbec', 'vinho san telmo', 'san telmo malbec', 'san telmo', 'vinho malbec'],
  },
  {
    id: 'vin_la_plata',
    nome: 'Vinho La Plata Branco Argentino 750ml',
    preco: 55.9,
    aliases: ['vinho la plata branco', 'vinho la plata', 'la plata branco', 'la plata'],
  },
  {
    id: 'vin_cavic',
    nome: 'Vinho Tinto Seco Argentino Cavic 750ml',
    preco: 40.0,
    aliases: ['vinho cavic', 'vinho tinto cavic', 'cavic tinto', 'cavic'],
  },

  // Empanadas Salgadas e Doces
  {
    id: 'emp_queijo_cebola',
    nome: 'Empanada de Queijo com Cebola Caramelizada',
    preco: 14.0,
    aliases: [
      'queijo com cebola caramelizada',
      'queijo e cebola caramelizada',
      'queijo cebola caramelizada',
      'cebola caramelizada com queijo',
      'cebola caramelizada',
      'queijo com cebola',
      'queijo e cebola',
      'queijo cebola',
    ],
  },
  {
    id: 'emp_queijo_tomate',
    nome: 'Empanada de Queijo, Tomate, Manjericão e Orégano',
    preco: 14.0,
    aliases: [
      'queijo tomate manjericao e oregano',
      'queijo tomate manjericao',
      'queijo com tomate e manjericao',
      'queijo e tomate',
      'queijo com tomate',
      'queijo tomate',
      'caprese',
      'manjericao',
      'queijo',
    ],
  },
  {
    id: 'emp_hamburguer',
    nome: 'Empanada de Carne com Ovos',
    preco: 14.0,
    aliases: [
      'carne com ovos',
      'carne com ovo',
      'carne e ovo',
      'carne e ovos',
      'carne bovina',
      'carne moida',
      'carne tradicional',
      'carne',
    ],
  },
  {
    id: 'emp_ Frango com Espinafre e Cheddar',
    nome: 'Empanada de Frango com Espinafre e Cheddar',
    preco: 14.0,
    aliases: [
      'frango com espinafre e cheddar',
      'frango espinafre cheddar',
      'frango com cheddar',
      'frango cheddar',
      'frango com espinafre',
      'frango',
    ],
  },
  {
    id: 'emp_Espinafre com Ricota e Tomate Seco',
    nome: 'Empanada de Espinafre com Ricota e Tomate Seco',
    preco: 14.0,
    aliases: [
      'espinafre com ricota e tomate seco',
      'espinafre ricota tomate seco',
      'espinafre com ricota',
      'espinafre e ricota',
      'espinafre ricota',
      'ricota com espinafre',
      'espinafre',
    ],
  },
  {
    id: 'emp_Escarola com Queijo',
    nome: 'Empanada de Escarola com Queijo',
    preco: 14.0,
    aliases: ['escarola com queijo', 'escarola e queijo', 'escarola queijo', 'escarola'],
  },
  {
    id: 'emp_Bacon Cheeseburger',
    nome: 'Empanada Bacon Cheeseburger',
    preco: 14.0,
    aliases: [
      'bacon cheeseburger',
      'bacon cheeseburguer',
      'cheeseburger',
      'cheeseburguer',
      'bacon burger',
      'bacon',
    ],
  },
  {
    id: 'empcalabresa',
    nome: 'Empanada de Calabresa com Cream Cheese',
    preco: 14.0,
    aliases: [
      'calabresa com cream cheese',
      'calabresa e cream cheese',
      'calabresa cream cheese',
      'calabresa creamcheese',
      'calabresa',
    ],
  },
  {
    id: 'emp_palmito',
    nome: 'Empanada de Palmito',
    preco: 14.0,
    aliases: ['palmito pupunha', 'palmito cremoso', 'palmito'],
  },
  {
    id: 'emp_Atum',
    nome: 'Empanada de Atum com Queijo',
    preco: 14.0,
    aliases: ['atum com queijo', 'atum e queijo', 'atum queijo', 'atum'],
  },
  {
    id: 'empchocolate',
    nome: 'Empanada de Chocolate ao Leite com Morango',
    preco: 16.9,
    aliases: [
      'chocolate ao leite com morango',
      'chocolate com morango',
      'chocolate e morango',
      'chocolate morango',
      'morango com chocolate',
      'chocolate',
    ],
  },
  {
    id: 'emp_romeu',
    nome: 'Empanada Romeu e Julieta',
    preco: 14.5,
    aliases: [
      'romeu e julieta',
      'romeu julieta',
      'goiabada com queijo',
      'goiabada e queijo',
      'romeu',
      'goiabada',
    ],
  },
]

// Lista achatada de todos os aliases ordenados por comprimento decrescente (mais específicos primeiro)
interface FlatAlias {
  alias: string
  product: ProductCatalogEntry
}

const FLAT_ALIASES: FlatAlias[] = []
for (const prod of CATALOG_PRODUCTS) {
  for (const alias of prod.aliases) {
    FLAT_ALIASES.push({ alias, product: prod })
  }
}
FLAT_ALIASES.sort((a, b) => b.alias.length - a.alias.length)

// Palavras-chave que indicam intenção de pedir
const ORDER_VERB_PATTERNS = [
  'quero',
  'vou querer',
  'gostaria',
  'manda',
  'mandar',
  'envia',
  'enviar',
  'entrega',
  'entregar',
  'me ve',
  'me vê',
  'pedir',
  'pedido',
  'fazer pedido',
  'faz um pedido',
  'anota',
  'traz',
  'trazer',
]

/**
 * 1. Pré-checagem: detecta se a mensagem possui indicativos de pedido.
 * Utilizado pelo Fast-Path para NÃO disparar saudações ou cardápio estático.
 */
export function hasOrderIntent(text: string): boolean {
  if (!text || text.trim().length === 0) return false

  const normalized = normalize(text)

  // Perguntas puramente informativas sobre cardápio/horário sem números nem sabores específicos
  const isPureFaq =
    (normalized.includes('cardapio') ||
      normalized.includes('menu') ||
      normalized.includes('horario') ||
      normalized.includes('qual o pix') ||
      normalized.includes('chave pix')) &&
    !/\d/.test(normalized) &&
    !Object.keys(WORD_TO_NUMBER).some((w) => new RegExp(`\\b${w}\\b`).test(normalized))

  if (isPureFaq) return false

  // Se o parser determinístico já consegue extrair itens válidos do cardápio, tem intenção de pedido garantida!
  const parsed = parseTextOrder(text)
  if (parsed.hasItems) {
    return true
  }

  // Verifica se há verbos de pedido combinados com termos de cardápio
  const hasVerb = ORDER_VERB_PATTERNS.some((v) => normalized.includes(v))
  const hasFoodTerm = [
    'empanada',
    'empanadas',
    'sabor',
    'sabores',
    'carne',
    'calabresa',
    'queijo',
    'coca',
    'refrigerante',
    'combo',
  ].some((t) => normalized.includes(t))

  if (hasVerb && hasFoodTerm) {
    return true
  }

  // Verifica padrão de quantidade + qualquer sabor (ex: "2 carne", "1 calabresa", "3 de queijo")
  const quantityNumberMatch = /\b(?:\d+|um|uma|dois|duas|tres|quatro|cinco|seis)\s*(?:x\s*)?(?:de\s*)?(?:empanadas?\s*(?:de\s*)?)?[a-z]+/i.test(
    normalized
  )
  if (quantityNumberMatch && hasFoodTerm) {
    return true
  }

  return false
}

function rangesOverlap(
  r1: { start: number; end: number },
  r2: { start: number; end: number }
): boolean {
  return r1.start < r2.end && r2.start < r1.end
}

/**
 * 2. Parser Determinístico de Itens do Cardápio:
 * Extrai itens e quantidades, calculando o valor total oficial.
 */
export function parseTextOrder(text: string): ParsedOrderResult {
  if (!text || text.trim().length === 0) {
    return { hasItems: false, items: [], total: 0, totalFormatted: 'R$ 0,00', rawText: text }
  }

  const normalized = normalize(text)
  const itemsFound: Map<string, ParsedOrderItem> = new Map()
  const matchedRanges: Array<{ start: number; end: number }> = []

  const numPattern =
    '(?:\\d+|um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez|meia\\s*duzia|uma\\s*duzia)'

  // Passada 1: busca padrão de quantidade explícita antes do alias (ex: "2 carne", "1 coca zero lata")
  for (const { alias, product } of FLAT_ALIASES) {
    const escapedAlias = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const regex = new RegExp(
      `\\b(${numPattern})\\s*(?:x\\s*)?(?:de\\s*)?(?:empanadas?\\s*(?:de\\s*)?)?${escapedAlias}\\b`,
      'gi'
    )

    let match: RegExpExecArray | null
    while ((match = regex.exec(normalized)) !== null) {
      const start = match.index
      const end = match.index + match[0].length

      // Ignora se sobrepõe com match mais longo já registrado
      if (matchedRanges.some((r) => rangesOverlap(r, { start, end }))) {
        continue
      }

      const rawQty = match[1].toLowerCase().trim()
      const qty = (WORD_TO_NUMBER[rawQty] ?? parseInt(rawQty, 10)) || 1

      matchedRanges.push({ start, end })

      const existing = itemsFound.get(product.id)
      if (existing) {
        existing.quantity += qty
        existing.totalPrice = Number((existing.quantity * existing.unitPrice).toFixed(2))
      } else {
        itemsFound.set(product.id, {
          id: product.id,
          title: product.nome,
          quantity: qty,
          unitPrice: product.preco,
          totalPrice: Number((qty * product.preco).toFixed(2)),
        })
      }
    }
  }

  // Passada 2: Fallback sem quantidade explícita (ex: "quero carne", "manda calabresa")
  if (itemsFound.size === 0) {
    for (const { alias, product } of FLAT_ALIASES) {
      if (['coca', 'queijo', 'bacon', 'frango'].includes(alias)) continue
      if (alias.length < 5) continue

      const escapedAlias = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const singleRegex = new RegExp(
        `\\b(?:quero|manda|envia|me ve|vou querer)?\\s*(?:uma?\\s+)?${escapedAlias}\\b`,
        'i'
      )
      const match = singleRegex.exec(normalized)
      if (match) {
        const start = match.index
        const end = match.index + match[0].length
        if (matchedRanges.some((r) => rangesOverlap(r, { start, end }))) {
          continue
        }
        matchedRanges.push({ start, end })
        itemsFound.set(product.id, {
          id: product.id,
          title: product.nome,
          quantity: 1,
          unitPrice: product.preco,
          totalPrice: product.preco,
        })
      }
    }
  }

  const items = Array.from(itemsFound.values())
  const total = Number(items.reduce((acc, it) => acc + it.totalPrice, 0).toFixed(2))
  const totalFormatted = `R$ ${total.toFixed(2).replace('.', ',')}`

  const deliveryAddress = extractAddressFromText(text) || undefined

  return {
    hasItems: items.length > 0,
    items,
    total,
    totalFormatted,
    deliveryAddress,
    rawText: text,
  }
}

/**
 * 3. Identifica se a mensagem contém um endereço de entrega.
 */
export function extractAddressFromText(text: string): string | null {
  if (!text) return null
  const trimmed = text.trim()
  const lower = normalize(trimmed)

  // Prefixos comuns de endereço no Brasil
  const addressPrefixMatch = trimmed.match(
    /(?:entregar\s+(?:na|no|em)|endereco(?:\s+de\s+entrega)?(?:\s+e)?:\s*|manda\s+(?:na|no|em)\s+)?((?:rua|r\.|r|av\.|av|avenida|alameda|al\.|al|travessa|tv\.|tv|rodovia|rod\.|rod|estrada|quadra|qd\.|condominio|bairro)\s+[^,\n]+(?:,\s*\d+)?(?:[^.\n]*))/i
  )

  if (addressPrefixMatch && addressPrefixMatch[1]) {
    const candidate = addressPrefixMatch[1].trim()
    if (candidate.length >= 8) {
      return candidate
    }
  }

  // Padrão estruturado "Nome da Rua, Número, Bairro/Cidade"
  // Ex: "Rua das Palmeiras, 150, Centro" ou "Av Paulista, 1000"
  const streetPattern = /\b(?:rua|r\.?|avenida|av\.?|alameda|al\.?|travessa|tv\.?)\s+[a-z0-9À-ÿ\s.'-]+,\s*\d+/i
  if (streetPattern.test(trimmed)) {
    return trimmed
  }

  // Se o cliente respondeu diretamente com tipo de logradouro + nome + número
  // Ex: "Rua dos Pinheiros 123" ou "Av Brasil 450 apto 12"
  const directAddressPattern = /^(?:rua|r\.?|avenida|av\.?|alameda|travessa|estrada)\s+[a-z0-9À-ÿ\s.'-]+\s+\d+/i
  if (directAddressPattern.test(trimmed)) {
    return trimmed
  }

  // CEP (ex: 01310-100 ou 01310100)
  if (/\b\d{5}-?\d{3}\b/.test(lower) && trimmed.length > 15) {
    return trimmed
  }

  return null
}

/**
 * 4. Identifica se o cliente confirmou o endereço anterior cadastrado.
 * Ex: "sim", "no mesmo", "pode ser", "isso", "pode entregar aí", "confirmo"
 */
export function isAddressConfirmation(text: string): boolean {
  if (!text) return false
  const normalized = normalize(text)

  const confirmationPatterns = [
    'sim',
    'pode ser',
    'no mesmo',
    'nesse mesmo',
    'no mesmo endereco',
    'nesse mesmo endereco',
    'confirmo',
    'confirmado',
    'isso',
    'esse mesmo',
    'pode entregar nesse',
    'pode mandar nesse',
    'o mesmo',
  ]

  return confirmationPatterns.some(
    (pattern) => normalized === pattern || normalized.startsWith(`${pattern} `) || normalized.endsWith(` ${pattern}`)
  )
}
