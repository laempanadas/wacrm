-- SOMENTE LEITURA. NAO EXECUTADO na preparacao destes arquivos.
-- Rodar manualmente antes e depois de cada etapa, no banco/projeto correto.
-- Nao chama handle_conversation_handoff nem grava historico de migrations.

SELECT current_database() AS banco, current_user AS executor;

SELECT
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'conversations'
      AND column_name = 'bot_order_resumed_at'
  ) AS coluna_existe,
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'conversations'
      AND column_name = 'bot_order_resumed_at'
      AND udt_schema = 'pg_catalog' AND udt_name = 'timestamptz'
      AND is_nullable = 'YES' AND column_default IS NULL
  ) AS coluna_compativel_com_042;

-- A ausencia de linha aqui significa coluna ausente OU invisivel para o executor.
SELECT data_type, udt_schema, udt_name, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'conversations'
  AND column_name = 'bot_order_resumed_at';

-- Os MD5 comparam SOMENTE o corpo prosrc em UTF-8/LF com os arquivos versionados.
-- Whitespace/comentarios diferentes produzem OUTRA_DEFINICAO; nao adivinhar a versao.
-- O marcador isolado e diagnostico, nao prova igualdade com a 042.
WITH alvo AS (
  SELECT to_regprocedure(
    'public.handle_conversation_handoff(uuid,uuid,uuid,boolean,text,boolean,boolean)'
  ) AS oid
)
SELECT
  alvo.oid::text AS assinatura,
  CASE
    WHEN p.oid IS NULL THEN 'FUNCAO_AUSENTE'
    WHEN md5(p.prosrc) = '0664c2519669e753f54f1e2d09d6214f' THEN '039_CORPO_EXATO'
    WHEN md5(p.prosrc) = 'aae18840ea7fbbd7205fc40ff0de28e4' THEN '042_CORPO_EXATO'
    ELSE 'OUTRA_DEFINICAO_REVISAR'
  END AS versao_corpo,
  md5(p.prosrc) AS md5_corpo,
  CASE WHEN p.oid IS NULL THEN NULL
    ELSE strpos(pg_get_functiondef(p.oid), 'bot_order_resumed_at') > 0
  END AS marcador_042_presente,
  p.prosecdef AS security_definer,
  p.proconfig AS configuracao_funcao,
  CASE WHEN p.oid IS NULL THEN NULL
    ELSE pg_get_functiondef(p.oid)
  END AS definicao_completa
FROM alvo LEFT JOIN pg_catalog.pg_proc p ON p.oid = alvo.oid;

-- Ambas as versoes devem manter service_role com EXECUTE e negar os clientes.
-- Esta consulta espera os papeis padrao do Supabase. Se falhar, parar e revisar.
SELECT
  p.oid::regprocedure::text AS assinatura,
  has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role_pode_executar,
  has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_pode_executar,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_pode_executar,
  EXISTS (
    SELECT 1
    FROM pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
    WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
  ) AS public_pode_executar
FROM pg_catalog.pg_proc p
WHERE p.oid = to_regprocedure(
  'public.handle_conversation_handoff(uuid,uuid,uuid,boolean,text,boolean,boolean)'
);
