-- ==============================================================================
-- Migration: 033_sanitize_tags_and_custom_fields.sql
-- Higienização e Padronização de Tags e Custom Fields para Delivery CRM
-- ==============================================================================

-- 1. Fundir 'aguardando_pagamento' em 'Aguardando Pagamento' (TAG_AGUARDANDO)
DO $$
DECLARE
    rec RECORD;
    v_target_tag_id UUID;
BEGIN
    FOR rec IN 
        SELECT id, account_id, user_id 
        FROM tags 
        WHERE lower(trim(name)) IN ('aguardando_pagamento', 'aguardando pagamento') 
          AND name <> 'Aguardando Pagamento'
    LOOP
        -- Verifica se já existe a tag oficial 'Aguardando Pagamento' na conta
        SELECT id INTO v_target_tag_id 
        FROM tags 
        WHERE account_id = rec.account_id 
          AND name = 'Aguardando Pagamento'
        LIMIT 1;

        IF v_target_tag_id IS NOT NULL THEN
            -- Transfere os contatos para a tag oficial
            UPDATE contact_tags ct
            SET tag_id = v_target_tag_id
            WHERE ct.tag_id = rec.id
              AND NOT EXISTS (
                  SELECT 1 FROM contact_tags existing
                  WHERE existing.contact_id = ct.contact_id 
                    AND existing.tag_id = v_target_tag_id
              );
            
            -- Remove vínculos residuais e a tag duplicada
            DELETE FROM contact_tags WHERE tag_id = rec.id;
            DELETE FROM tags WHERE id = rec.id;
        ELSE
            -- Se não havia a oficial, renomeia a tag existente
            UPDATE tags 
            SET name = 'Aguardando Pagamento', color = '#f59e0b'
            WHERE id = rec.id;
        END IF;
    END LOOP;
END $$;

-- 2. Remover variáveis de controle de fluxo e etapas de Kanban da tabela tags
DELETE FROM tags
WHERE lower(trim(name)) IN (
    'aguardando_tipo',
    'aguardando_nome',
    'aguardando_catalogo',
    'aguardando_catálogo',
    'aguardando_endereco',
    'aguardando_endereço',
    'aguardando_itens',
    'aguardando_telefone',
    'aguardando_pedido',
    'aguardando tipo',
    'aguardando nome',
    'aguardando catalogo',
    'aguardando catálogo',
    'aguardando endereco',
    'aguardando endereço',
    'em_preparo',
    'em preparo',
    'saiu_para_entrega',
    'saiu para entrega',
    'entregue',
    'novo_pedido',
    'novo pedido',
    'na_cozinha',
    'na cozinha',
    'pronto_para_entrega',
    'pronto para entrega',
    'pago'
);

-- 3. Garantir a existência dos Custom Fields oficiais de Delivery para todas as contas
INSERT INTO custom_fields (account_id, field_name, field_type)
SELECT a.id, cf.field_name, 'text'
FROM accounts a
CROSS JOIN (
    VALUES 
        ('endereco_completo'),
        ('bairro'),
        ('cidade'),
        ('ponto_referencia'),
        ('forma_pagamento'),
        ('itens_ultimo_pedido')
) AS cf(field_name)
WHERE NOT EXISTS (
    SELECT 1 FROM custom_fields existing
    WHERE existing.account_id = a.id AND existing.field_name = cf.field_name
);

-- 4. Garantir tags operacionais oficiais mínimas para cada conta
INSERT INTO tags (account_id, user_id, name, color)
SELECT a.id, a.owner_id, t.name, t.color
FROM accounts a
CROSS JOIN (
    VALUES 
        ('Aguardando Pagamento', '#f59e0b'),
        ('Confirmado', '#22c55e'),
        ('Precisa de Atendente', '#ef4444')
) AS t(name, color)
WHERE a.owner_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM tags existing
    WHERE existing.account_id = a.id AND existing.name = t.name
);
