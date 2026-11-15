-- ============================================================================
-- DIAGNÓSTICO SOMENTE LEITURA — contatos duplicados e conversas por contato.
-- Não altera dados. Rode no SQL Editor do Supabase, uma consulta por vez.
--
-- Contexto: a migration 022 já colapsou contatos com o MESMO phone_normalized
-- (índice único). Portanto, duplicatas restantes têm dígitos diferentes:
--   - 9º dígito ausente/presente (55 11 8237-8636 vs 55 11 9 8237-8636);
--   - identificador que não é telefone (BSUID da Meta, ex. "BR.1349…");
--   - telefone gravado com formato inesperado.
-- ============================================================================

-- 1) Contatos da mesma conta com os mesmos 8 últimos dígitos e os mesmos
--    4 primeiros dígitos (ex.: 5511 + final 82378636). Candidatos a merge.
SELECT account_id,
       left(regexp_replace(phone, '\D', '', 'g'), 4)  AS prefixo,
       right(regexp_replace(phone, '\D', '', 'g'), 8) AS final,
       count(*)                                       AS qtd,
       array_agg(id ORDER BY created_at)              AS contact_ids,
       array_agg(phone ORDER BY created_at)           AS telefones
FROM public.contacts
WHERE length(regexp_replace(phone, '\D', '', 'g')) BETWEEN 8 AND 15
GROUP BY account_id,
         left(regexp_replace(phone, '\D', '', 'g'), 4),
         right(regexp_replace(phone, '\D', '', 'g'), 8)
HAVING count(*) > 1
ORDER BY qtd DESC;

-- 2) Mesmos 8 últimos dígitos, mas prefixo diferente (suspeita de DDD/país
--    diferente ou formato estranho). Revisar manualmente; NÃO mesclar às cegas.
SELECT account_id,
       right(regexp_replace(phone, '\D', '', 'g'), 8) AS final,
       count(DISTINCT left(regexp_replace(phone, '\D', '', 'g'), 4)) AS prefixos_distintos,
       array_agg(id ORDER BY created_at)              AS contact_ids,
       array_agg(phone ORDER BY created_at)           AS telefones
FROM public.contacts
WHERE length(regexp_replace(phone, '\D', '', 'g')) BETWEEN 8 AND 15
GROUP BY account_id, right(regexp_replace(phone, '\D', '', 'g'), 8)
HAVING count(*) > 1
   AND count(DISTINCT left(regexp_replace(phone, '\D', '', 'g'), 4)) > 1
ORDER BY account_id;

-- 3) Contatos cujo "telefone" não tem formato de telefone (letras, ponto,
--    tamanho fora de 8–15 dígitos). Forte indício de BSUID/LID gravado como phone.
SELECT id, account_id, phone, name, created_at
FROM public.contacts
WHERE phone !~ '^\+?[0-9 ().-]+$'
   OR length(regexp_replace(phone, '\D', '', 'g')) NOT BETWEEN 8 AND 15
ORDER BY created_at DESC
LIMIT 200;

-- 4) Caso relatado: contatos com o final 82378636 e o contato da conversa
--    407a3aa0-69ad-497c-881b-d9117a74cb04, com a quantidade de conversas de cada um.
SELECT ct.id AS contact_id,
       ct.phone,
       ct.name,
       ct.created_at,
       (SELECT count(*) FROM public.conversations v WHERE v.contact_id = ct.id) AS conversas
FROM public.contacts ct
WHERE regexp_replace(ct.phone, '\D', '', 'g') LIKE '%82378636'
   OR ct.id = (SELECT contact_id FROM public.conversations
               WHERE id = '407a3aa0-69ad-497c-881b-d9117a74cb04')
ORDER BY ct.created_at;

-- 5) Payloads recebidos da cliente (recibos gravados antes do processamento).
--    Mostra o campo `from` e o `user_id` (BSUID, se a Meta enviar) de cada
--    mensagem. Se `from` mudar de telefone para BSUID, o contato se separa.
SELECT r.created_at,
       r.payload->>'from'    AS from_id,
       r.payload->>'user_id' AS user_id_bsuid,
       r.payload->>'type'    AS tipo,
       r.meta_message_id
FROM public.whatsapp_inbound_receipts r
WHERE r.payload::text LIKE '%82378636%'
ORDER BY r.created_at
LIMIT 200;

-- 6) Conversas por contato, em contas com duplicidade (visão geral).
SELECT account_id, contact_id, count(*) AS conversas,
       array_agg(id ORDER BY created_at) AS conversation_ids
FROM public.conversations
GROUP BY account_id, contact_id
HAVING count(*) > 1
ORDER BY conversas DESC;
