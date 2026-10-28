# Aplicação manual da 042, em duas etapas

## Limites deste pacote

Estes arquivos foram preparados e conferidos por leitura/comparação textual. **Nenhum deles foi executado no banco.** Não comprovam o estado atual da produção.

Ficam em `docs/deploy-042/`, não em `supabase/migrations`. A migration original `042_order_intent_priority.sql` permanece intacta. Nada aqui faz push, deploy ou registra uma migration no histórico do Supabase.

Cada operação futura precisa de autorização explícita e de um operador com permissão no banco/projeto correto. Não use a chave do cliente nem exponha credenciais nos registros da operação.

Arquivos:

- `00_verificar.sql`: apenas consultas de leitura a metadados; não chama a RPC.
- `01_coluna.sql`: somente adiciona a coluna nullable `bot_order_resumed_at timestamptz`, se ela ainda não existir.
- `02_funcao.sql`: substitui `handle_conversation_handoff` pela versão da 042 e reaplica as permissões. Não executa o corpo da função.
- `../rollback-042.sql`: restaura a função da 039, mantendo a coluna e seus dados. Só usar se houver autorização específica de rollback.

## Ordem resumida

1. Verificar o estado real com `00_verificar.sql`.
2. Aplicar somente `01_coluna.sql`, mantendo a função da 039 e o código antigo.
3. Verificar novamente a coluna e a função; então publicar/ativar o código novo em etapa separadamente autorizada.
4. Confirmar que todas as instâncias e efeitos em voo usam o código novo.
5. Aplicar `02_funcao.sql`; verificar função, permissões e comportamento.

**Não aplicar a função da 042 enquanto o código 2966071 ainda estiver processando mensagens. Não publicar o código novo antes de disponibilizar a coluna.** Um push pode iniciar deploy automático: o passo 01 precisa estar verificado antes desse push.

## Etapa 0 — Preparar e verificar

Antes de executar qualquer arquivo:

- Confirmar projeto/banco e versões realmente publicadas. `main` local, `origin/main` e um SHA do Git não comprovam o deploy ou o schema implantado.
- Confirmar que os objetos das migrations anteriores até a 041 estão presentes. Este pacote não instala migrations anteriores.
- Guardar a definição e as permissões atuais da função para auditoria/recuperação, junto do SHA publicado e dos resultados das verificações. Não incluir tokens ou dados de clientes.
- Ensaiar a sequência em homologação. A suíte local com mocks/banco em memória não certifica um rollout de produção.

Executar manualmente `00_verificar.sql` e interpretar:

- `coluna_existe=false`: antes do passo 01, pode ser o estado esperado. Também pode indicar falta de visibilidade para o executor; verificar permissões e projeto antes de concluir que falta a coluna.
- Depois do passo 01, `coluna_existe=true` e `coluna_compativel_com_042=true` são obrigatórios. O tipo deve ser `timestamp with time zone` / `pg_catalog.timestamptz`, nullable e sem default.
- `versao_corpo=039_CORPO_EXATO`: corpo igual ao arquivo versionado da 039.
- `versao_corpo=042_CORPO_EXATO`: corpo igual ao arquivo versionado da 042.
- `FUNCAO_AUSENTE`: parar. Não tentar compensar instalando só a 042 sem revisar os pré-requisitos.
- `OUTRA_DEFINICAO_REVISAR`: parar e comparar `definicao_completa` com o arquivo esperado. Os hashes são do corpo em UTF-8/LF; mudar apenas whitespace/comentários também altera o hash. Não substituir uma função customizada sem revisão.
- `marcador_042_presente` procura `bot_order_resumed_at` na definição. É um indício, não prova de que a função seja exatamente a 042.
- Em ambas as versões: `security_definer=true`; `configuracao_funcao` deve manter `search_path` em `pg_catalog, public`.
- Nas permissões: `service_role_pode_executar=true`; `anon_pode_executar=false`, `authenticated_pode_executar=false` e `public_pode_executar=false`. Função presente sem linha de permissões/consulta com erro exige investigação.

Se a função já for 042 e ainda houver código 2966071 atendendo, **não seguir automaticamente**. Coordenar consumidores e revisar a situação antes de retomar o roteiro. Se a coluna existir com tipo errado, não a apagar: `IF NOT EXISTS` não corrige o tipo; parar para planejar a correção.

## Etapa 1 — Somente a coluna, com código antigo ainda ativo

Com a função da 039 confirmada, executar manualmente apenas `01_coluna.sql`.

Verificar depois com `00_verificar.sql`:

1. Coluna existente e compatível; nenhuma definição de função ou permissão deve ter mudado.
2. Função ainda `039_CORPO_EXATO`, se esse era o estado inicial aprovado.
3. Código publicado continua no SHA antigo durante essa etapa.
4. Em logs e em contato de teste autorizado, atendimento habitual continua sem erro de schema/RPC. Não criar cobrança real para testar este passo.

**Compatibilidade com 2966071:** adicionar essa coluna não exige mudança no aplicativo antigo. Ela é nullable, sem default e não renomeia/remove campos; a função da 039 é mantida. O código antigo não seleciona nem interpreta o novo timestamp:

- `2966071:src/lib/orders/text-order-flow.ts:94-105`: seleciona apenas flag de pausa, timestamp humano e status.
- `2966071:src/lib/ai/auto-reply.ts:93-107`: consulta os campos antigos, sem `bot_order_resumed_at`.
- `2966071:src/lib/whatsapp/handoff.ts:55-73`: chamada e retorno continuam sendo os da RPC com sete argumentos.
- `supabase/migrations/039_conversation_handoff.sql:60-116`: assinatura/corpo/permissões não são modificados pelo passo 01.

Se o ALTER falhar, não avançar para o deploy. Se houver dúvida sobre aplicação parcial, repetir primeiro a verificação de leitura. Manter o código antigo e a função antiga; não apagar a coluna para tentar resolver.

## Etapa intermediária — Código novo, coluna presente, função ainda da 039

Somente após o passo 01 verificado, obter autorização separada para publicar/ativar o código novo. Não aplicar o passo 02 enquanto houver instâncias antigas, workers antigos ou efeitos `after()` antigos em voo. Confirmar o SHA de cada consumidor efetivo, não apenas o resultado do push.

O código novo funciona tecnicamente com a coluna e a RPC antiga: os campos consultados existem, e os sete parâmetros/retorno JSON continuam compatíveis. **A prioridade nova de retomada ainda não estará completa.**

Evidências no código atual (782d6c6 + fase2):

- `src/lib/orders/text-order-flow.ts:106-114` e `src/lib/ai/auto-reply.ts:98-111`: selecionam a coluna explicitamente. Sem o passo 01, a consulta pode falhar e o bot pode ficar sem responder; não é apenas um encaminhamento mais conservador.
- `src/lib/orders/text-order-flow.ts:126-155`: valida a intenção pelo catálogo da conta antes de pedir prioridade.
- `src/lib/whatsapp/handoff.ts:56-74`: envia os mesmos sete parâmetros, usando `orderIntent === true` para `p_new_order`.
- `039_conversation_handoff.sql:71-86`: a função antiga ainda exige ausência de humano recente, certos motivos de pausa e draft/pedido elegível. Catálogo nativo sem draft textual elegível pode continuar bloqueado.
- `039_conversation_handoff.sql:91-111`: mantém o handoff/expiração antigos; ao criar episódio, pode encerrar um run ativo. Pausas manuais não expiram automaticamente.

O que o cliente pode perceber nesse intervalo:

- Conversa aberta, sem pausa/humano ativo: continua o fluxo normal, inclusive observações e FAQs conhecidas nos seus pontos de tratamento.
- Pedido válido durante pausa manual/humano recente: pode continuar aguardando atendente, em vez de retomar automaticamente.
- Pedidos sob outros motivos de pausa seguem as condições e o timeout da 039; não prometer retomada imediata.
- Não há obrigação de repetir “aguarde” a cada mensagem: avisos usam a chave de outbox por episódio/tipo (`handoff.ts:69-73`).

Verificar depois do deploy, antes do passo 02:

1. `00_verificar.sql` ainda mostra coluna correta + função 039 + permissões corretas.
2. Todos os consumidores executam o SHA novo; não há erro de coluna inexistente ou RPC.
3. Ensaios autorizados de carrinho/endereço chegam à confirmação sem gerar cobrança antecipada; pausas continuam conservadoras conforme acima. Preferir homologação; não usar cobrança real como smoke test.

Se falhar: não aplicar o passo 02 para tentar mascarar o erro. Interromper o avanço, investigar logs e comparar schema/versões. Reverter o aplicativo para 2966071 é compatível enquanto a função continuar na 039; manter a coluna. Se houver timestamp de retomada de uma aplicação anterior da 042, revisar esses casos: o TypeScript novo considera o timestamp (`handoff.ts:79-95`), a RPC antiga não. Esse estado não equivale a um primeiro rollout limpo.

## Etapa 2 — Ativar a função nova

Com coluna, código novo e ausência de consumidores antigos confirmados, executar manualmente o bloco completo de `02_funcao.sql`, incluindo REVOKE/GRANT. Usar execução transacional conforme a ferramenta do operador; não executar só metade do bloco.

Verificar depois com `00_verificar.sql`:

1. Coluna correta; `versao_corpo=042_CORPO_EXATO`, marcador presente, assinatura correta.
2. `SECURITY DEFINER`, `search_path` e permissões continuam corretos.
3. Em homologação/contato de teste autorizado, pedido com quantidade e produto válidos retoma uma pausa; “Oi”, “já paguei” e pedido de atendente não ganham prioridade por serem conversa.
4. Notas desconhecidas continuam em revisão; endereço/resumo exigem confirmação; claims incertos não são liberados; ausência de resposta não autoriza reprocessar cobrança.

Esses efeitos decorrem de `042_order_intent_priority.sql:19-28` e do chamador validado. No código 2966071, `handoff.ts:62` usava `hasFreshOrderIntent(text)` do parser estático, não validação do catálogo da conta. Por isso a função nova não deve conviver com esse chamador antigo.

Se o passo 02 falhar: verificar de novo a definição e as permissões; não presumir que nada mudou. Parar a progressão e, se necessário, coordenar pausa/drenagem dos consumidores. Com autorização específica, `docs/rollback-042.sql` restaura a função da 039 e suas permissões, preservando a coluna. Verificar novamente. Antes de voltar o aplicativo a 2966071, restaurar/verificar a função da 039 durante a coordenação; não deixar o chamador antigo atendendo com a função nova.

O rollback não reconstrói pausas/episódios já limpos nem desfaz timestamps gravados. Casos afetados precisam de revisão humana. Não apagar pedidos, receipts, outbox ou claims para “destravar”.

## Idempotência e histórico manual

Por leitura do SQL, a 042 inteira é idempotente quanto à estrutura/permissões, com os mesmos pré-requisitos e autorização:

- `ADD COLUMN IF NOT EXISTS` não tenta criar uma segunda coluna.
- `CREATE OR REPLACE FUNCTION` usa a mesma assinatura e retorno, substituindo o corpo existente.
- `REVOKE ALL` e `GRANT EXECUTE` podem ser repetidos.
- Os UPDATEs estão dentro do corpo da RPC; instalar/reinstalar a função não chama a RPC nem atualiza conversas/pedidos naquele momento.

Portanto reaplicar o arquivo não falha simplesmente porque já foi aplicado. Isso não corrige tipo errado, objetos anteriores ausentes, falta de permissão ou concorrência/locks. Também não torna o rollout neutro: aplicar a 042 depois de um rollback reativa a política nova.

**Não executar a 042 inteira na etapa 1**, pois isso também aplicaria a função antes do código validado. A repetição integral só é apropriada quando a etapa 2 já está autorizada e compatível.

Como estes scripts são manuais, eles não inserem registros em `supabase_migrations.schema_migrations`. Guardar resultados, SHA, operador e horário em registro operacional aprovado; não assumir aplicação pelo histórico do Git ou pela ausência/presença de uma entrada no histórico do Supabase. Uma ferramenta futura pode tentar aplicar a 042 novamente: conferir estado e consumidores antes de autorizar, sobretudo após rollback.

A validação destes arquivos foi estática. Não houve consulta ao banco, simulação SQL destes scripts ou aplicação manual durante sua preparação.
