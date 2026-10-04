/**
 * src/lib/orders/custom-fields.ts
 *
 * Padronização dos Campos Personalizados (Custom Fields) do CRM para Delivery.
 * Define os campos oficiais, parsing de endereço e persistência resiliente.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Campos personalizados oficiais e padronizados do CRM para Delivery.
 */
export const STANDARD_DELIVERY_CUSTOM_FIELDS = [
  'endereco_completo',
  'bairro',
  'cidade',
  'ponto_referencia',
  'forma_pagamento',
  'itens_ultimo_pedido',
] as const;

export type StandardDeliveryCustomField =
  (typeof STANDARD_DELIVERY_CUSTOM_FIELDS)[number];

export interface ContactOrderFieldsInput {
  itens?: string;
  itensUltimoPedido?: string;
  endereco?: string;
  enderecoCompleto?: string;
  bairro?: string;
  cidade?: string;
  pontoReferencia?: string;
  formaPagamento?: string;
  nomeCliente?: string;
}

/**
 * Extrai componentes estruturados de um endereço textual livre.
 */
export function parseAddressComponents(rawAddress?: string): {
  endereco_completo?: string;
  bairro?: string;
  cidade?: string;
  ponto_referencia?: string;
} {
  if (!rawAddress || !rawAddress.trim()) return {};
  const trimmed = rawAddress.trim();
  const res: {
    endereco_completo: string;
    bairro?: string;
    cidade?: string;
    ponto_referencia?: string;
  } = {
    endereco_completo: trimmed,
  };

  // Tenta extrair Ponto de Referência / Complemento
  const refMatch = trimmed.match(
    /(?:ref(?:erência)?|ponto de ref(?:erência)?|próximo [aà]o?|prox [aà]o?)\s*[:\-]?\s*([^\n\r,]+)/i
  );
  if (refMatch && refMatch[1] && refMatch[1].trim().length > 2) {
    res.ponto_referencia = refMatch[1].trim();
  } else {
    const parenMatch = trimmed.match(/\(([^)]+)\)/);
    if (parenMatch && parenMatch[1] && parenMatch[1].trim().length > 2) {
      res.ponto_referencia = parenMatch[1].trim();
    }
  }

  // Tenta extrair Bairro
  const bairroExplicit = trimmed.match(
    /bairro\s*[:\-]?\s*([a-zA-ZÀ-ÿ0-9\s]+?)(?:,|-|\(|$)/i
  );
  if (
    bairroExplicit &&
    bairroExplicit[1] &&
    bairroExplicit[1].trim().length > 1
  ) {
    res.bairro = bairroExplicit[1].trim();
  } else {
    const parts = trimmed.split(/[-–]/).map((p) => p.trim());
    if (parts.length >= 2) {
      const afterDash = parts[1].split(',').map((p) => p.trim());
      if (
        afterDash[0] &&
        afterDash[0].length > 1 &&
        !afterDash[0].toLowerCase().includes('apto')
      ) {
        res.bairro = afterDash[0];
      }
      if (afterDash.length >= 2 && afterDash[1] && afterDash[1].length > 1) {
        res.cidade = afterDash[1];
      }
    }
  }

  return res;
}

/**
 * Busca endereço anterior do contato no CRM (custom_values, orders ou deals)
 */
export async function getSavedCustomerAddress(
  supabase: SupabaseClient,
  accountId: string,
  contactId: string
): Promise<string | null> {
  try {
    // 1. Tenta buscar em contact_custom_values (endereco_completo prioritário + compatibilidade)
    const { data: defs } = await supabase
      .from('custom_fields')
      .select('id, field_name')
      .eq('account_id', accountId)
      .in('field_name', [
        'endereco_completo',
        'Endereco_entrega',
        'endereco',
        'Endereço',
        'Endereço de entrega',
        'Endereco',
      ]);

    if (defs && defs.length > 0) {
      const fieldIds = defs.map((d: { id: string }) => d.id);
      const { data: val } = await supabase
        .from('contact_custom_values')
        .select('value')
        .eq('contact_id', contactId)
        .in('custom_field_id', fieldIds)
        .limit(1)
        .maybeSingle();

      if (val?.value && val.value.trim().length > 5) {
        return val.value.trim();
      }
    }

    // 2. Tenta buscar no último pedido da tabela orders
    const { data: lastOrder } = await supabase
      .from('orders')
      .select('delivery_address')
      .eq('contact_id', contactId)
      .not('delivery_address', 'is', null)
      .neq('delivery_address', '')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (
      lastOrder?.delivery_address &&
      lastOrder.delivery_address.trim().length > 5
    ) {
      return lastOrder.delivery_address.trim();
    }

    // 3. Tenta buscar nas anotações dos últimos deals
    const { data: lastDeals } = await supabase
      .from('deals')
      .select('notes')
      .eq('contact_id', contactId)
      .order('created_at', { ascending: false })
      .limit(3);

    if (lastDeals && lastDeals.length > 0) {
      for (const d of lastDeals) {
        const match = d.notes?.match(/Endereço:\s*([^\n\r]+)/i);
        if (
          match &&
          match[1] &&
          match[1].trim().length > 5 &&
          !match[1].includes('(não informado)')
        ) {
          return match[1].trim();
        }
      }
    }
  } catch (err) {
    console.warn(
      '[getSavedCustomerAddress] Erro ao buscar endereço salvo:',
      err
    );
  }

  return null;
}

/**
 * Salva campos customizados padronizados do contato de forma resiliente e idempotente.
 * Grava exclusivamente nos campos oficiais de Delivery:
 * - 'endereco_completo'
 * - 'bairro'
 * - 'cidade'
 * - 'ponto_referencia'
 * - 'forma_pagamento'
 * - 'itens_ultimo_pedido'
 */
export async function saveContactOrderFields(
  supabase: SupabaseClient,
  accountId: string,
  contactId: string,
  fields: ContactOrderFieldsInput
): Promise<void> {
  try {
    const parsedAddr = parseAddressComponents(
      fields.enderecoCompleto || fields.endereco
    );

    const byName: Record<string, string> = {};

    // Grava exclusivamente nos campos padrão oficiais de delivery
    const fullAddr = (
      fields.enderecoCompleto ||
      parsedAddr.endereco_completo ||
      fields.endereco ||
      ''
    ).trim();
    if (fullAddr) byName['endereco_completo'] = fullAddr;

    const bairro = (fields.bairro || parsedAddr.bairro || '').trim();
    if (bairro) byName['bairro'] = bairro;

    const cidade = (fields.cidade || parsedAddr.cidade || '').trim();
    if (cidade) byName['cidade'] = cidade;

    const pontoRef = (
      fields.pontoReferencia ||
      parsedAddr.ponto_referencia ||
      ''
    ).trim();
    if (pontoRef) byName['ponto_referencia'] = pontoRef;

    const payment = (fields.formaPagamento || '').trim();
    if (payment) byName['forma_pagamento'] = payment;

    const items = (fields.itensUltimoPedido || fields.itens || '').trim();
    if (items) byName['itens_ultimo_pedido'] = items;

    const names = Object.keys(byName);
    if (names.length === 0) return;

    // Busca definições existentes no banco
    let defsQuery = supabase
      .from('custom_fields')
      .select('id, field_name')
      .eq('account_id', accountId);

    if (
      typeof (
        defsQuery as unknown as { in?: (k: string, v: string[]) => unknown }
      ).in === 'function'
    ) {
      defsQuery = (
        defsQuery as unknown as {
          in: (k: string, v: string[]) => typeof defsQuery;
        }
      ).in('field_name', names);
    }

    const { data: defs, error: defsErr } = await defsQuery;

    if (defsErr) {
      console.warn(
        '[saveContactOrderFields] Erro ao buscar custom_fields:',
        defsErr
      );
    }

    const existingNames = new Set(
      (defs || []).map((d: { field_name: string }) => d.field_name)
    );
    const allDefs = [...(defs || [])];

    // Auto-criação dos campos padrão oficiais caso não existam para a conta
    const missingStandard = STANDARD_DELIVERY_CUSTOM_FIELDS.filter(
      (fn) => byName[fn] !== undefined && !existingNames.has(fn)
    );

    if (missingStandard.length > 0) {
      try {
        const { data: newDefs } = await supabase
          .from('custom_fields')
          .insert(
            missingStandard.map((fn) => ({
              account_id: accountId,
              field_name: fn,
              field_type: 'text',
            }))
          )
          .select('id, field_name');
        if (newDefs) {
          allDefs.push(...newDefs);
        }
      } catch {
        // Se já foi inserido concorrentemente, ignora
      }
    }

    if (allDefs.length === 0) return;

    const rows = allDefs
      .filter(
        (d: { id: string; field_name: string }) =>
          byName[d.field_name] !== undefined
      )
      .map((d: { id: string; field_name: string }) => ({
        contact_id: contactId,
        custom_field_id: d.id,
        value: byName[d.field_name],
      }));

    if (rows.length > 0) {
      await supabase.from('contact_custom_values').upsert(rows, {
        onConflict: 'contact_id,custom_field_id',
      });
    }
  } catch (err) {
    console.warn(
      '[saveContactOrderFields] Erro não bloqueante ao salvar campos customizados:',
      err
    );
  }
}
