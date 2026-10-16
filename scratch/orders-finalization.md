# Orders finalization — RED/GREEN

## Resultado
- `createOrderDeal` não reutiliza deals abertos em nenhuma chamada nova (ledger, legado com referência ou sem referência). Só reutiliza vínculo de pedido canônico validado. Isso elimina adoção bidirecional antes do linkage, durante gateway in-flight/uncertain e após completed sem lookup-race nem coluna nova.
- Pickup persiste snapshot congelado de `items` (id/title/name/quantity/unitPrice/description), `total` e `total_amount`; deal mantém valor/moeda BRL e notas com itens, observações e total. Texto e linhas legadas sem preço continuam aceitos, sem preços inventados.
- Valores inválidos, centavos fracionários, quantidades inválidas e divergência entre total e linhas integralmente precificadas falham antes de efeitos no DB.
- Replay valida identidade do pedido e vínculo do deal por account/contact, retornando pipeline/stage reais do deal.
- `createDealForOrder` verifica pedido/account/contact antes de criar/taggear; preserva vínculo existente e faz CAS `deal_id IS NULL`, lendo o vencedor quando perde concorrência.

## Evidência TDD
- Ownership real creator + mock DB/gateway: 4 regressões RED (deal legado adotava exatamente o ID do checkout), depois GREEN.
- Snapshot pickup/texto: 2 regressões RED (items e total ausentes), depois GREEN.
- Valores/linhas: 11 regressões RED (promessas resolviam entradas inválidas), depois GREEN.
- Preflight/replay/linkage: 8 regressões RED (efeitos em pedido estrangeiro, overwrite de vínculo, identidades inválidas), depois GREEN.
- Precisão de centavos pequenos: 2 regressões RED, depois GREEN com tolerância somente ao ruído binário.
- Cobertura adicional: mutação do draft durante await, linhas sem preço, ruído IEEE754 legítimo, account/contact de deal estrangeiro, preflight indisponível e conflito com outro contato.

## Verificação final
- `npx vitest run src/lib/orders/create-order.test.ts src/lib/orders/create-order-persistence.test.ts src/lib/orders/checkout-deal-ownership.test.ts`: 3 arquivos / 86 testes PASS.
- `npx vitest run src/lib/orders`: 15 arquivos / 209 testes PASS (inclui alterações concorrentes de outros owners).
- `npm run typecheck`: PASS.
- `npx eslint src/lib/orders/create-order.ts src/lib/orders/create-order.test.ts src/lib/orders/create-order-persistence.test.ts src/lib/orders/create-order-db-test-helper.ts src/lib/orders/checkout-deal-ownership.test.ts`: PASS.
- `git diff --check`: PASS.

## Arquivos / contrato para parent
Alterados nesta tarefa: `src/lib/orders/create-order.ts`, `create-order.test.ts`, `create-order-persistence.test.ts`, `checkout-deal-ownership.test.ts`, `create-order-db-test-helper.ts` (5 arquivos), além deste relatório. Mudanças preexistentes foram preservadas.

Tradeoff explícito: auto-deals de conversa com valor zero ficam separados. `skipOrderRecord` sem pedido canônico/ledger NÃO garante idempotência; nova chamada cria deal novo. Corridas de persistência/linkage podem deixar deal provisório separado, mas nunca sobrescrevem deal/pedido vencedor. Não há limpeza automática desses deals.

Schema: não foi alterado 037 nem outra migration. Depende dos campos orders.items/total/total_amount já previstos em 037. BRL é explícito no deal/notas; a migration atual não fornece orders.currency. Linhas totalmente precificadas devem somar o total fornecido; taxas extras exigiriam contrato de campo específico, não são inferidas.

Limitações: testes simulam somente DB/gateway; sem credenciais, serviços reais, mensagens/cobranças, SQL compartilhado ou deploy. Typecheck e ownership tiveram falhas transitórias durante edições concorrentes em payments/consent; reruns finais acima passaram. Nenhum commit/push realizado pelo filho.
