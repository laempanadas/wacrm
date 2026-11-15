-- ============================================================================
-- MANUAL SCRIPT — NOT A MIGRATION. Do not place in supabase/migrations/.
--
-- Mescla contatos duplicados que são o MESMO número escrito com dígitos
-- diferentes (hoje: 9º dígito ausente ou presente em celular brasileiro).
-- A migration 022 já cuida de duplicatas com dígitos idênticos; este script
-- cuida do resto.
--
-- ORDEM DE EXECUÇÃO (com autorização):
--   1) supabase/manual/diagnostico_contatos_duplicados.sql   (somente leitura)
--   2) ESTE script, em dry-run; revisar os NOTICEs (pares manter <- absorver)
--   3) ESTE script com apply := true, se o dry-run estiver correto
--   4) supabase/manual/merge_duplicate_conversations.sql     (dry-run e depois apply)
--   5) migration 043 (índice único em conversations)
--
-- Regra de candidato (conservadora): mesma conta, mesmos 4 primeiros e
-- 8 últimos dígitos, e todos os membros com 12 ou 13 dígitos. O contato de
-- 13 dígitos (com o 9º) vira o que fica; empate desfeito pelo mais antigo.
-- Contatos com formato diferente (ex.: BSUID) NÃO entram aqui.
--
-- Segurança:
--   * Um único bloco DO = uma transação. Qualquer erro reverte tudo.
--   * apply := false por padrão: sempre reverte no fim (dry-run).
--   * Aborta (RAISE EXCEPTION) se existir tabela com FK para contacts que não
--     esteja listada em `handled` — assim uma tabela nova nunca é apagada em
--     cascata sem tratamento.
--   * Aborta se o contato perdedor tiver rascunho com claim ativo, efeito de
--     saída 'sending'/'uncertain' ou fluxo 'active' também no contato mantido.
--   * Perdedores são apagados só depois de uma verificação final de que nenhuma
--     linha de nenhuma FK aponta para eles.
--   * Perda de informação: tag e campo personalizado repetidos são descartados
--     (o contato mantido prevalece). Notas, conversas, negócios e logs são
--     todos repontados, nada é apagado.
--
-- Depois de aplicar, o webhook já encontra o contato mantido pelos 8 últimos
-- dígitos (findExistingContact), então a duplicata não volta.
-- ============================================================================

DO $merge$
DECLARE
  apply boolean := false;   -- DRY RUN por padrão. Mude para true só após revisar o dry-run.

  -- Toda FK para contacts(id) conhecida. Qualquer outra aborta o script.
  handled text[] := ARRAY[
    'public.conversations.contact_id',
    'public.contact_notes.contact_id',
    'public.deals.contact_id',
    'public.broadcast_recipients.contact_id',
    'public.automation_logs.contact_id',
    'public.automation_pending_executions.contact_id',
    'public.notifications.contact_id',
    'public.flow_runs.contact_id',
    'public.order_drafts.contact_id',
    'public.contact_tags.contact_id',
    'public.contact_custom_values.contact_id'
  ];

  pairs integer;
  conflicts integer;
  unhandled text;
  leftover integer;
  cnt integer;
  ref record;
BEGIN
  CREATE TEMP TABLE contact_merge_map (
    dup_id uuid PRIMARY KEY,
    keep_id uuid NOT NULL,
    account_id uuid NOT NULL
  ) ON COMMIT DROP;

  -- ------------------------------------------------------------- candidatos
  WITH cand AS (
    SELECT c.id, c.account_id, c.created_at,
           regexp_replace(c.phone, '\D', '', 'g') AS d
    FROM public.contacts c
    WHERE length(regexp_replace(c.phone, '\D', '', 'g')) BETWEEN 12 AND 13
  ),
  ranked AS (
    SELECT cand.id, cand.account_id,
           first_value(cand.id) OVER w AS keep_id,
           row_number() OVER w         AS rn,
           count(*) OVER (PARTITION BY cand.account_id,
                                       left(cand.d, 4),
                                       right(cand.d, 8)) AS grp
    FROM cand
    WINDOW w AS (
      PARTITION BY cand.account_id, left(cand.d, 4), right(cand.d, 8)
      ORDER BY length(cand.d) DESC, cand.created_at, cand.id
    )
  )
  INSERT INTO contact_merge_map (dup_id, keep_id, account_id)
  SELECT r.id, r.keep_id, r.account_id
  FROM ranked r
  WHERE r.grp > 1 AND r.rn > 1;

  SELECT count(*) INTO pairs FROM contact_merge_map;
  IF pairs = 0 THEN
    RAISE NOTICE 'Nenhum contato duplicado por variação de dígitos. Nada a fazer.';
    RETURN;
  END IF;

  FOR ref IN
    SELECT m.keep_id, k.phone AS keep_phone, m.dup_id, d.phone AS dup_phone
    FROM contact_merge_map m
    JOIN public.contacts k ON k.id = m.keep_id
    JOIN public.contacts d ON d.id = m.dup_id
    ORDER BY k.phone, d.phone
  LOOP
    RAISE NOTICE 'MANTER % (%)  <-  ABSORVER % (%)',
      ref.keep_id, ref.keep_phone, ref.dup_id, ref.dup_phone;
  END LOOP;

  -- ------------------------------------------------------------- preflight
  SELECT string_agg(fk.k, ', ') INTO unhandled
  FROM (
    SELECT n.nspname || '.' || cl.relname || '.' || a.attname AS k
    FROM pg_constraint c
    JOIN pg_class cl     ON cl.oid = c.conrelid
    JOIN pg_namespace n  ON n.oid = cl.relnamespace
    JOIN pg_attribute a  ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.contype = 'f' AND c.confrelid = 'public.contacts'::regclass
  ) fk
  WHERE NOT (fk.k = ANY (handled));
  IF unhandled IS NOT NULL THEN
    RAISE EXCEPTION 'ABORT: tabela(s) com FK para contacts sem tratamento neste script: %', unhandled;
  END IF;

  SELECT count(*) INTO conflicts
  FROM contact_merge_map m
  JOIN public.flow_runs dr ON dr.contact_id = m.dup_id AND dr.status = 'active'
  JOIN public.flow_runs kr ON kr.contact_id = m.keep_id AND kr.status = 'active';
  IF conflicts > 0 THEN
    RAISE EXCEPTION 'ABORT: % par(es) com fluxo ativo nos dois contatos; decidir manualmente', conflicts;
  END IF;

  SELECT count(*) INTO conflicts FROM (
    SELECT m.keep_id
    FROM contact_merge_map m
    JOIN public.flow_runs dr ON dr.contact_id = m.dup_id AND dr.status = 'active'
    GROUP BY m.keep_id
    HAVING count(*) > 1
  ) multi;
  IF conflicts > 0 THEN
    RAISE EXCEPTION 'ABORT: % contato(s) mantido(s) receberiam mais de um fluxo ativo', conflicts;
  END IF;

  SELECT count(*) INTO conflicts
  FROM public.order_drafts d
  JOIN contact_merge_map m ON d.contact_id = m.dup_id
  WHERE d.processing_message_id IS NOT NULL;
  IF conflicts > 0 THEN
    RAISE EXCEPTION 'ABORT: % rascunho(s) com claim ativo; esperar ou reconciliar', conflicts;
  END IF;

  SELECT count(*) INTO conflicts
  FROM public.order_message_outbox o
  JOIN public.conversations v ON v.id = o.conversation_id
  JOIN contact_merge_map m ON v.contact_id = m.dup_id
  WHERE o.status IN ('sending', 'uncertain');
  IF conflicts > 0 THEN
    RAISE EXCEPTION 'ABORT: % efeito(s) de saída em dúvida (sending/uncertain); reconciliar antes', conflicts;
  END IF;

  RAISE NOTICE 'preflight OK (% par(es)).', pairs;

  -- ------------------------------------------------------------- repoint
  -- Tabelas sem UNIQUE envolvendo contact_id: repontagem simples.
  UPDATE public.conversations t             SET contact_id = m.keep_id FROM contact_merge_map m WHERE t.contact_id = m.dup_id;
  UPDATE public.contact_notes t             SET contact_id = m.keep_id FROM contact_merge_map m WHERE t.contact_id = m.dup_id;
  UPDATE public.deals t                     SET contact_id = m.keep_id FROM contact_merge_map m WHERE t.contact_id = m.dup_id;
  UPDATE public.broadcast_recipients t      SET contact_id = m.keep_id FROM contact_merge_map m WHERE t.contact_id = m.dup_id;
  UPDATE public.automation_logs t           SET contact_id = m.keep_id FROM contact_merge_map m WHERE t.contact_id = m.dup_id;
  UPDATE public.automation_pending_executions t SET contact_id = m.keep_id FROM contact_merge_map m WHERE t.contact_id = m.dup_id;
  UPDATE public.notifications t             SET contact_id = m.keep_id FROM contact_merge_map m WHERE t.contact_id = m.dup_id;
  UPDATE public.order_drafts t              SET contact_id = m.keep_id FROM contact_merge_map m WHERE t.contact_id = m.dup_id;
  -- flow_runs: a unique index allows one ACTIVE run per contact; the preflight
  -- above guarantees the keeper has none when a loser has one.
  UPDATE public.flow_runs t                 SET contact_id = m.keep_id FROM contact_merge_map m WHERE t.contact_id = m.dup_id;

  -- UNIQUE(contact_id, tag_id): uma linha por (mantido, tag). Apaga as que
  -- o mantido já tem ou que outro perdedor (de id menor) já vai levar.
  DELETE FROM public.contact_tags t
  USING contact_merge_map m
  WHERE t.contact_id = m.dup_id
    AND (
      EXISTS (SELECT 1 FROM public.contact_tags s
              WHERE s.contact_id = m.keep_id AND s.tag_id = t.tag_id)
      OR EXISTS (SELECT 1 FROM public.contact_tags s
                 JOIN contact_merge_map m2 ON s.contact_id = m2.dup_id
                 WHERE m2.keep_id = m.keep_id AND s.tag_id = t.tag_id
                   AND m2.dup_id < m.dup_id)
    );
  UPDATE public.contact_tags t SET contact_id = m.keep_id FROM contact_merge_map m WHERE t.contact_id = m.dup_id;

  -- UNIQUE(contact_id, custom_field_id): mesma regra; o valor do mantido prevalece.
  DELETE FROM public.contact_custom_values t
  USING contact_merge_map m
  WHERE t.contact_id = m.dup_id
    AND (
      EXISTS (SELECT 1 FROM public.contact_custom_values s
              WHERE s.contact_id = m.keep_id AND s.custom_field_id = t.custom_field_id)
      OR EXISTS (SELECT 1 FROM public.contact_custom_values s
                 JOIN contact_merge_map m2 ON s.contact_id = m2.dup_id
                 WHERE m2.keep_id = m.keep_id AND s.custom_field_id = t.custom_field_id
                   AND m2.dup_id < m.dup_id)
    );
  UPDATE public.contact_custom_values t SET contact_id = m.keep_id FROM contact_merge_map m WHERE t.contact_id = m.dup_id;

  -- ------------------------------------------------- verificação final
  leftover := 0;
  FOR ref IN
    SELECT n.nspname AS sch, cl.relname AS tbl, a.attname AS col
    FROM pg_constraint c
    JOIN pg_class cl     ON cl.oid = c.conrelid
    JOIN pg_namespace n  ON n.oid = cl.relnamespace
    JOIN pg_attribute a  ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.contype = 'f' AND c.confrelid = 'public.contacts'::regclass
  LOOP
    EXECUTE format(
      'SELECT count(*) FROM %I.%I t JOIN contact_merge_map m ON t.%I = m.dup_id',
      ref.sch, ref.tbl, ref.col
    ) INTO cnt;
    leftover := leftover + cnt;
  END LOOP;
  IF leftover > 0 THEN
    RAISE EXCEPTION 'ABORT: % referência(s) a contatos perdedores ainda existem', leftover;
  END IF;

  DELETE FROM public.contacts c USING contact_merge_map m WHERE c.id = m.dup_id;

  -- Informativo: pares de conversa que surgiram após a fusão (tratados pelo
  -- script de conversas, não aqui).
  SELECT count(*) INTO cnt FROM (
    SELECT account_id, contact_id FROM public.conversations
    GROUP BY account_id, contact_id HAVING count(*) > 1
  ) still;
  RAISE NOTICE 'Pares (conta, contato) com mais de uma conversa após a fusão: %. Rodar merge_duplicate_conversations.sql.', cnt;

  IF apply THEN
    RAISE NOTICE 'Fundidos % contato(s) duplicado(s); confirmando.', pairs;
  ELSE
    RAISE EXCEPTION 'DRY RUN OK (% contato(s) seriam fundidos). Nada foi mantido. Mude apply := true para confirmar.', pairs;
  END IF;
END
$merge$;
