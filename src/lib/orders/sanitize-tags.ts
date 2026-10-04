/**
 * src/lib/orders/sanitize-tags.ts
 *
 * Módulo de higienização e padronização de Tags e Custom Fields do CRM para Delivery.
 *
 * Executa:
 * 1. Fusão de 'aguardando_pagamento' em 'Aguardando Pagamento' (TAG_AGUARDANDO).
 * 2. Remoção de tags de controle interno do flow ('aguardando_tipo', 'aguardando_nome', etc.)
 *    e etapas do Kanban ('em_preparo', 'saiu_para_entrega', 'entregue', etc.) da tabela tags / contact_tags.
 * 3. Criação e garantia dos campos customizados oficiais de delivery ('endereco_completo',
 *    'bairro', 'cidade', 'ponto_referencia', 'forma_pagamento', 'itens_ultimo_pedido').
 * 4. Migração de dados de campos customizados legados para os campos oficiais.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  TAG_AGUARDANDO,
  TAG_CONFIRMADO,
  TAG_HUMANO,
  FORBIDDEN_CONTACT_TAGS,
} from './create-order';
import { STANDARD_DELIVERY_CUSTOM_FIELDS } from './custom-fields';

export interface SanitizeStats {
  mergedAguardando: number;
  removedForbiddenTags: number;
  createdCustomFields: number;
  migratedCustomValues: number;
}

export async function sanitizeTagsAndCustomFields(
  supabase: SupabaseClient,
  targetAccountId?: string
): Promise<SanitizeStats> {
  const stats: SanitizeStats = {
    mergedAguardando: 0,
    removedForbiddenTags: 0,
    createdCustomFields: 0,
    migratedCustomValues: 0,
  };

  // 1. Obter lista de contas a higienizar
  let accountsQuery = supabase.from('accounts').select('id');
  if (targetAccountId) {
    accountsQuery = accountsQuery.eq('id', targetAccountId);
  }
  const { data: accounts } = await accountsQuery;
  const accountIds = (accounts || []).map((a: { id: string }) => a.id);

  if (targetAccountId && !accountIds.includes(targetAccountId)) {
    accountIds.push(targetAccountId);
  }

  for (const accountId of accountIds) {
    // -------------------------------------------------------------
    // ETAPA 1: Fusão de 'aguardando_pagamento' em 'Aguardando Pagamento'
    // -------------------------------------------------------------
    const { data: accountTags } = await supabase
      .from('tags')
      .select('id, name, color')
      .eq('account_id', accountId);

    const tagsList = accountTags || [];

    const officialAguardando = tagsList.find(
      (t: { name: string }) =>
        t.name.trim().toLowerCase() === TAG_AGUARDANDO.toLowerCase()
    );

    const legacyAguardandoList = tagsList.filter((t: { name: string }) => {
      const lower = t.name.trim().toLowerCase();
      return (
        lower === 'aguardando_pagamento' ||
        (lower === 'aguardando pagamento' && t.name !== TAG_AGUARDANDO)
      );
    });

    let activeAguardandoTagId = officialAguardando?.id;

    if (legacyAguardandoList.length > 0) {
      if (!activeAguardandoTagId) {
        // Se ainda não existe a oficial, renomeia a primeira legada
        const firstLegacy = legacyAguardandoList[0];
        await supabase
          .from('tags')
          .update({ name: TAG_AGUARDANDO, color: '#f59e0b' })
          .eq('id', firstLegacy.id);
        activeAguardandoTagId = firstLegacy.id;
        stats.mergedAguardando++;
        // Remove da lista para não deletar
        legacyAguardandoList.shift();
      }

      // Para as tags legadas restantes, migra contact_tags e remove a tag
      for (const leg of legacyAguardandoList) {
        if (activeAguardandoTagId && leg.id !== activeAguardandoTagId) {
          // Busca contatos associados à tag legada
          const { data: contactAssocs } = await supabase
            .from('contact_tags')
            .select('contact_id')
            .eq('tag_id', leg.id);

          if (contactAssocs && contactAssocs.length > 0) {
            for (const assoc of contactAssocs) {
              await supabase
                .from('contact_tags')
                .upsert(
                  {
                    contact_id: assoc.contact_id,
                    tag_id: activeAguardandoTagId,
                  },
                  { onConflict: 'contact_id,tag_id' }
                );
            }
          }

          // Deleta associações legadas e a tag
          await supabase.from('contact_tags').delete().eq('tag_id', leg.id);
          await supabase.from('tags').delete().eq('id', leg.id);
          stats.mergedAguardando++;
        }
      }
    }

    // -------------------------------------------------------------
    // ETAPA 2: Remover tags de variáveis de flow e etapas de kanban
    // -------------------------------------------------------------
    const tagsToRemove = tagsList.filter((t: { name: string; id: string }) => {
      const lower = t.name.trim().toLowerCase();
      const under = lower.replace(/[\s-]+/g, '_');
      // Não remove se for a tag oficial ativa
      if (t.id === activeAguardandoTagId) return false;
      if (
        lower === TAG_AGUARDANDO.toLowerCase() ||
        lower === TAG_CONFIRMADO.toLowerCase() ||
        lower === TAG_HUMANO.toLowerCase()
      ) {
        return false;
      }
      return (
        FORBIDDEN_CONTACT_TAGS.has(lower) || FORBIDDEN_CONTACT_TAGS.has(under)
      );
    });

    for (const tag of tagsToRemove) {
      await supabase.from('contact_tags').delete().eq('tag_id', tag.id);
      await supabase.from('tags').delete().eq('id', tag.id);
      stats.removedForbiddenTags++;
    }

    // -------------------------------------------------------------
    // ETAPA 3: Garantir Custom Fields padronizados de Delivery
    // -------------------------------------------------------------
    const { data: customFields } = await supabase
      .from('custom_fields')
      .select('id, field_name')
      .eq('account_id', accountId);

    const existingFieldNames = new Set(
      (customFields || []).map((f: { field_name: string }) => f.field_name)
    );
    const missingFields = STANDARD_DELIVERY_CUSTOM_FIELDS.filter(
      (fn) => !existingFieldNames.has(fn)
    );

    if (missingFields.length > 0) {
      const { data: insertedFields } = await supabase
        .from('custom_fields')
        .insert(
          missingFields.map((fn) => ({
            account_id: accountId,
            field_name: fn,
            field_type: 'text',
          }))
        )
        .select('id, field_name');

      stats.createdCustomFields +=
        insertedFields?.length || missingFields.length;
    }

    // -------------------------------------------------------------
    // ETAPA 4: Migração de valores legados para campos oficiais
    // -------------------------------------------------------------
    const { data: updatedFields } = await supabase
      .from('custom_fields')
      .select('id, field_name')
      .eq('account_id', accountId);

    const fieldMap = new Map<string, string>();
    for (const f of updatedFields || []) {
      fieldMap.set(f.field_name, f.id);
    }

    const officialAddressId = fieldMap.get('endereco_completo');
    const legacyAddressIds = [
      fieldMap.get('Endereco_entrega'),
      fieldMap.get('endereco'),
      fieldMap.get('Endereço'),
      fieldMap.get('Endereço de entrega'),
    ].filter(Boolean) as string[];

    if (officialAddressId && legacyAddressIds.length > 0) {
      for (const legacyId of legacyAddressIds) {
        const { data: legacyVals } = await supabase
          .from('contact_custom_values')
          .select('contact_id, value')
          .eq('custom_field_id', legacyId);

        if (legacyVals && legacyVals.length > 0) {
          for (const lv of legacyVals) {
            if (lv.value && lv.value.trim().length > 3) {
              await supabase.from('contact_custom_values').upsert(
                {
                  contact_id: lv.contact_id,
                  custom_field_id: officialAddressId,
                  value: lv.value.trim(),
                },
                { onConflict: 'contact_id,custom_field_id' }
              );
              stats.migratedCustomValues++;
            }
          }
        }
      }
    }
  }

  return stats;
}
