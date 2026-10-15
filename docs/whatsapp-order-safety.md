# Correção de pedidos WhatsApp — validação local

## Estado

Trabalho retomado para revisão e commit local em 2026-10-15. Nenhum push/deploy, migration de produção, mensagem a cliente ou cobrança real executados. Este documento não constitui aprovação para implantação.

A revisão independente inicial reprovou o conjunto apesar dos testes verdes: botão de resumo antigo podia confirmar outro snapshot, cláusulas de cozinha/itens podiam virar endereço, linhas repetidas de correção podiam ser sobrescritas e a API avulsa podia vincular outro pedido ao deal de checkout existente. As quatro correções têm testes de regressão; uma nova revisão independente foi solicitada antes do commit. As evidências abaixo não constituem homologação de produção.

## Causas e correções

- Extração/estado antigos agrupavam produtos sem preservar personalizações e omitiam trechos desconhecidos. O parser mantém linhas e observações; o draft persistente exige revisão humana para itens/alterações não resolvidos. Não há fallback comercial para preços mockados.
- Observações em turnos posteriores sem quantidade não são ignoradas. Endereços seguidos por itens são delimitados, preservando correções e desconhecidos. Endereços incompletos não habilitam checkout.
- Resumo completo e confirmação explícita precedem cobrança. Texto negativo não conta como confirmação. Mudanças do catálogo invalidam a autorização anterior; catálogo indisponível ou item esgotado bloqueia cobrança.
- Webhook reserva o ID Meta, drafts serializam turnos, checkout usa claim durável por conta/referência e outbound usa outbox. Operações ambíguas não são reenviadas automaticamente.
- Checkouts distintos usam deals exclusivos. Testes exercitam o orchestrator e o criador de deal reais, simulando somente DB/gateway, inclusive concorrência e falhas.
- Sender compartilhado envia CTA URL real, sem URL duplicada no corpo ou marcador textual de botão. CRM renderiza o payload interativo. Fallback de texto só ocorre após rejeição definitiva elegível, nunca após aceitação incerta.

## Verificação executada

- `npm run test`: 86 arquivos, 894 testes passando.
- `npm run typecheck`: passou.
- ESLint dos 28 arquivos TypeScript/TSX alterados/novos: zero erros; um warning preexistente de `<img>` em message-bubble.tsx.
- Prettier dos mesmos arquivos: passou. `git diff --check`: passou.
- `npm run build` sem configuração Supabase: compilou e verificou tipos, mas falhou ao pré-renderizar `/forgot-password` por ausência de URL/chave pública.
- Build completo passou com valores fictícios locais somente no processo: `NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 NEXT_PUBLIC_SUPABASE_ANON_KEY=build-only-not-a-real-key npm run build`. Isso valida compilação/pré-renderização, não autenticação ou integração de produção. Não usar esse artefato/configuração fictícia para deploy.
- Migrations 036/037 executadas no PostgreSQL 17 em container isolado sem portas publicadas. Testes de draft/checkout, duplicidade, snapshot imutável, resultados completos, isolamento/RLS e reruns passaram. Migration 037 preservou dados, índice e política de orders preexistentes na fixture. Container encerrado após os testes.
- Lint global foi executado e encontrou 43 erros em arquivos fora deste escopo; não foram feitas correções gerais não relacionadas.

## Implantação pendente (não executada)

1. Revisar/aplicar `036_lossless_order_drafts.sql`, `037_order_checkouts.sql` e `038_flow_checkout_consent.sql` no ambiente autorizado. A migration 037 falha intencionalmente diante de referências duplicadas existentes: reconciliar sem apagar dados automaticamente. O protocolo de consentimento do engine depende da migration 038; não implantar apenas o código.
2. Revisar definições antigas já persistidas em `flow_nodes`: não foram regravadas. Runs/caminhos sem grounding ou confirmação ficam bloqueados para atendimento; atualizar o fluxo autorizado para o template revisado.
3. Configurar ambiente Supabase real por canal seguro e executar homologação. Nenhuma credencial foi lida ou alterada nesta tarefa.
4. Fora da janela de atendimento, a integração bloqueia o envio quando não há template aprovado/compatível fornecido por lookup confiável; não faz envio livre ilegal nem seleciona template arbitrário.
5. Claims processing/failed/uncertain exigem reconciliação humana. A proteção privilegia não duplicar efeitos; não há recuperação automática de operações incertas.

A validação de endereço é estrutural; não confirma existência geográfica nem área de entrega. Personalizações que dependem da cozinha são preservadas e encaminhadas para revisão, não aprovadas automaticamente.

## Verificação da retomada

- Suite completa: 93 arquivos, 1036 testes passando. Typecheck e `git diff --check` passaram.
- ESLint do escopo TypeScript: zero erros e um warning de imagem. O lint global ainda falha com 40 erros em arquivos não alterados neste trabalho; não é um gate global aprovado.
- Prettier dos arquivos TypeScript/Markdown do escopo passou após ajustes de formatação. SQL não é suportado pelo parser instalado e não integra essa afirmação.
- Build completo passou com a configuração Supabase fictícia descrita acima; não valida integrações reais nem autoriza deploy.
- Migration 038 aplicada e reaplicada em PostgreSQL 17 isolado, com fixture mínima explícita. As asserções de `supabase/tests/flow_checkout_consent.sql` passaram: revisões/snapshots, confirmação após resumo, replay, correção, finalização, evidências imutáveis e privilégios. Essa execução é sequencial, não prova concorrência real ou compatibilidade com todo o schema de produção. Container removido.
- As evidências anteriores de 036/037 estão registradas acima; não foram reaplicadas em produção.

## Riscos legados fora do escopo deste commit

- `src/app/api/cron/payment-reminders/route.ts`: fallback para configuração WhatsApp de outra conta, deduplicação global por telefone e atualização por telefone sem conta exigem revisão antes de ativar lembretes multi-tenant.
- `src/app/api/deals/[id]/mark-paid/route.ts`: validar ownership dos vínculos e escopo das mutações auxiliares antes de considerar todos os consumidores de pagamento isolados.
- `src/lib/orders/custom-fields.ts`: lookup de endereço salvo por contato sem conta explícita exige revisão dos callers e dos vínculos.
- Não declarar isolamento completo de todos os consumidores, homologação real ou implantação segura com base apenas neste commit. Operações incertas continuam exigindo reconciliação humana; notificações de pagamento após transição `paid` são best-effort.

## Validação das quatro correções finais

### Resultado da revisão independente seguinte

Revisão reprovada apesar de 1082 testes passando. Commit bloqueado até correção e nova verificação dos dois achados reproduzidos:

- P1: sufixos de endereço `- bem assadas`, `- sou alérgico a leite` e `; adicionar molho` ainda eram absorvidos pela localização, sem notes/unresolved ou revisão de cozinha; uma confirmação posterior habilitava checkout. A delimitação anterior não cobria cláusulas desconhecidas em geral.
- P2: o replay da API avulsa comparava itens por `JSON.stringify`, recusando com 409 o mesmo snapshot quando a persistência JSONB reordenava apenas as chaves dos objetos. Comparação deve ignorar ordem das chaves, mantendo ordem e multiplicidade das linhas.

Correções locais desses achados concluídas com regressões RED/GREEN e aprovadas na revisão independente final. As execuções registradas abaixo são evidências históricas. A revisão anterior confirmou as proteções de contexto do resumo, colisões de correções repetidas, rejeição de dealId, roteamento de catálogo novo e persistência de retirada. Homologação com concorrência real das migrations continua pendente.

### Verificação após correção dos dois achados

- Endereço: cláusulas separadas desconhecidas após a localidade deixam de ser absorvidas por padrão. Complementos reconhecidos são mantidos; demais textos ficam em notes/unresolved e bloqueiam checkout mesmo após confirmação. Os 79 testes de fronteira usam parser e draft reais. Detalhes separados não reconhecidos podem exigir revisão; texto livre sem delimitador continua semanticamente ambíguo com o nome da localidade.
- Replay: comparação estrutural por `isDeepStrictEqual` ignora ordem das chaves JSONB, preservando ordem/multiplicidade das linhas. Replay equivalente retorna 200 sem nova preferência ou escrita; mudanças reais permanecem 409. Guards dealId próprio 409/estrangeiro 404 preservados.
- Suite completa reexecutada: 94 arquivos, 1140 testes passando. Typecheck e diff-check passaram.
- Revisão independente final aprovada, sem achados bloqueantes: revisor executou 160 testes em cinco arquivos e 120 casos adicionais locais em memória, sem alterar arquivos. Parecer limitado às duas correções finais; os demais pontos foram cobertos pela revisão anterior.
- Build reexecutado após essas correções com configuração fictícia local: passou. Prettier do escopo passou; ESLint do escopo sem erros, com um warning de imagem. Lint global continua com os erros legados registrados acima.

### Evidências anteriores à segunda revisão

- Confirmação interativa exige o ID da mensagem do resumo atual, propagado do webhook até a RPC da migration 038. Botão antigo ou sem contexto não autoriza outro snapshot.
- Cláusulas de cozinha e produtos desconhecidos após endereço são preservados; colisões de linhas em correções exigem esclarecimento em vez de sobrescrever quantidades silenciosamente.
- A API de pagamento avulso rejeita `dealId` existente com 409 após validar ownership (vínculo estrangeiro continua 404). Não há suporte a vincular um deal informado pelo cliente nessa API, mesmo livre: evita corrida com checkout e alteração posterior do negócio por outro pagamento. Os callers de UI atuais não enviam esse campo. Pedidos sem `dealId` continuam com `deal_id: null`.
- Regressões do pagamento reproduziram quatro falhas antes da correção: requisições concorrentes eram aceitas com 200 usando o mesmo deal; após a correção, retornam 409 sem gateway ou mutações, inclusive em estados pending, processing e checkout_uncertain.
- `npm run test`: 94 arquivos, 1082 testes passando; `npm run typecheck` e `git diff --check` passaram.
- ESLint dos 44 arquivos TypeScript/TSX do escopo: zero erros e um warning de imagem. Lint global: 40 erros e 35 warnings; os erros estão fora do escopo alterado.
- Build completo passou com os valores fictícios locais descritos acima; não valida integrações reais.
- Migration 038 aplicada e reaplicada e suas asserções SQL aprovadas em PostgreSQL 17 isolado sem rede, com container removido ao final. Fixture mínima e sequencial, sem alegação de concorrência real ou compatibilidade com todo o schema de produção.
- Scan estático não encontrou credenciais literais nem execução dinâmica de código: os matches de `exec` são chamadas de expressão regular, não execução de comandos.
