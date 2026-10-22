---
name: delivery-core
description: Regras de delivery e pedidos da La Empanadas.
version: 0.1.0
author: La Empanadas, Hermes Agent
license: MIT
platforms: [linux, macos, windows]
---

# Delivery Core — La Empanadas

## Leitura obrigatória

Qualquer agente deve ler este arquivo antes de qualquer alteração no projeto, conforme `AGENTS.md`. Este documento é versionado no repositório; não depende de uma skill instalada no perfil pessoal. Use `read_file` para carregá-lo explicitamente. Preserve também as instruções e os guias da versão instalada do Next.js.

## Tabela Oficial de Preços

Fonte versionada: `assets/js/cardapio.json`. Não invente preços, renomeie IDs nem confunda produtos. Os IDs abaixo são identificadores do site; os UUIDs de `menu_items` pertencem à conta e não podem ser substituídos por estes IDs. No checkout, valide disponibilidade, conta, identidade e preço no catálogo autenticado. Catálogo vazio, indisponível ou ambíguo exige esclarecimento/revisão, nunca fallback silencioso para uma cobrança.

| ID oficial | Produto | Preço unitário |
| --- | --- | --- |
| emp_romeu | Empanada Romeu e Julieta | R$ 14,50 |
| emp_queijo_tomate | Empanada de Queijo, Tomate, Manjericão e Orégano | R$ 14,00 |
| emp_queijo_cebola | Empanada de Queijo com Cebola Caramelizada | R$ 14,00 |
| emp_palmito | Empanada de Palmito | R$ 14,00 |
| emp_hamburguer | Empanada de Carne com Ovos | R$ 14,00 |
| emp_ Frango com Espinafre e Cheddar | Empanada de Frango com Espinafre e Cheddar | R$ 14,00 |
| emp_Espinafre com Ricota e Tomate Seco | Empanada de Espinafre com Ricota e Tomate Seco | R$ 14,00 |
| emp_Escarola com Queijo | Empanada de Escarola com Queijo | R$ 14,00 |
| emp_Bacon Cheeseburger | Empanada Bacon Cheeseburger | R$ 14,00 |
| empcalabresa | Empanada de Calabresa com Cream Cheese | R$ 14,00 |
| empchocolate | Empanada de Chocolate ao Leite com Morango | R$ 16,90 |
| emp_Atum | Empanada de Atum com Queijo | R$ 14,00 |
| combo_coca | Combo Coca-Cola | R$ 62,90 |
| combo_familia | Combo Família (8 Empanadas Assadas) | R$ 102,00 |
| combo_quatro | Combo 4 Empanadas | R$ 52,90 |
| combo_quatro_ovomaltine | Combo 4 Empanadas + Tortinha de Ovomaltine | R$ 69,00 |
| combo_quatro_cheesecake | Combo 4 Empanadas + Cheesecake de Frutas Vermelhas | R$ 69,00 |
| beb_coca_original_350 | Coca-Cola Original 350ml | R$ 8,50 |
| beb_coca_zero_350 | Coca-Cola sem Açúcar 350ml | R$ 8,50 |
| beb_coca_600 | Coca-Cola Original 600ml | R$ 15,00 |
| beb_coca_zero_600 | Coca-Cola Zero 600ml | R$ 15,00 |
| beb_coca_2l | Coca-Cola 2L | R$ 25,00 |
| beb_coca_zero_2l | Coca-Cola zero 2L | R$ 25,00 |
| vin_la_plata | Vinho La Plata Branco Argentino 750ml | R$ 55,90 |
| vin_san_telmo | Vinho Tinto Argentino San Telmo Malbec 750ml | R$ 79,90 |
| vin_cavic | Vinho Tinto Seco Argentino Cavic 750ml | R$ 40,00 |

## Frete Grátis = R$ 0,00

Regra absoluta em todos os pedidos, nos três canais, sem valor mínimo. O total cobrado é a soma dos itens em centavos, sem taxa de entrega. Não anuncie frete grátis apenas acima de R$ 100 ou qualquer outro mínimo. O gateway deve receber custo de envio explicitamente zero. Não transforme texto livre de taxa/frete em produto cobrado.

## Fluxo dos três canais

1. Site: use o cardápio oficial e frete zero. Ao receber o pedido pelo WhatsApp, trate texto/valor do navegador como intenção, não como autoridade de cobrança. Valide os produtos no catálogo da conta e obtenha endereço completo e confirmação antes do checkout.
2. Catálogo Meta: receba o carrinho nativo, resolva cada SKU no catálogo da conta, valide quantidades e use os preços confiáveis do servidor. Não confie no total/preço recebido da Meta nem crie linhas genéricas para itens desconhecidos. Preserve observações para revisão e o carrinho original.
3. Texto Livre 50+: aceite `+ 1 empanada frango`, `+ 1 empanada ricota e tomate seco`, `2 carne 2 calabresa`, `+ 2 carne` e `+ 1 frango, + 1 ricota`. O sinal `+` é um separador de adição, não uma pendência nem observação de cozinha. Preserve o `+` legítimo nos nomes de combos. Some ao carrinho aberto; correções alteram somente o item solicitado. Pergunte por itens/sabores ambíguos em vez de adivinhar.

## Regra de ouro do handoff

Intenção de pedido sempre tem prioridade sobre pausas de atendente.

Quantidade explícita e produto reconhecido no catálogo da conta autorizam a retomada do bot e a montagem do rascunho, mesmo em `pending`, pausa manual ou após mensagem humana recente. Registre a retomada sem apagar o histórico de mensagens do atendente. Endereço e confirmação seguintes pertencem ao pedido retomado; uma nova intervenção humana posterior pode pausar novamente.

Esta prioridade não libera uma cobrança incerta, não apaga um checkout existente e não autoriza substituir o carrinho congelado de outro fluxo. Preserve os pedidos/links anteriores e as reservas duráveis. Se for necessária reconciliação, registre a solicitação e responda ao cliente, sem nova cobrança automática.

`Oi`, `Alô`, `Pix feito`, `Já paguei` e perguntas de acompanhamento não são pedidos. `Falar com atendente` sem pedido continua acionando pausa, aviso curto ao cliente e notificação à equipe, sem botão de pagamento.

## Assistente IA e pagamento seguro

Respeite o provedor/modelo configurado em `/agents`, incluindo Claude Haiku. O marcador `[TOTAL:xxx.xx]` é um sinal de integração, não uma fonte confiável de valor ou autorização para cobrar. Extraia e valide centavos, remova o marcador do texto visível e só envie CTA de pagamento quando o total coincidir com um carrinho estruturado confirmado e um pagamento canônico validado. Sem itens/endereço/confirmação, com valores divergentes ou marcadores inválidos, peça esclarecimento e não crie um link a partir do texto do modelo.

Reutilize a referência e o link canônicos do mesmo cliente/carrinho aberto. A identidade inclui SKU, descrição, quantidades, preço, entrega, endereço e observações; normalize extremidades de títulos/endereço na função compartilhada. Pedidos legados só podem ser recuperados com ledger concluído e vínculos confiáveis. Claims `processing`, `failed` ou `uncertain` exigem reconciliação e nunca podem ser liberados por retomada do bot.

## Mídia e segurança

Carregue fotos e comprovantes somente com autorização da conta/conversa e token de `whatsapp_config` da mesma conta. Preserve criptografia e não aceite token de outra conta ou fallback global. Transmita MIME correto, evite cache público de mídia privada e nunca registre tokens/URLs autenticadas. Diferencie indisponibilidade da Meta, expiração e configuração inválida de erro interno.

## Procedimento e verificação

- Antes de editar, use `read_file`/`search_files` para rastrear os três canais, regras de preço, parser, handoff e checkout. Nunca leia `.env.local` ou outros segredos.
- Use TDD: reproduza o caso informado com teste falhando antes da correção, depois prove uma única chamada de gateway por pagamento aberto.
- Execute `terminal(command="npx vitest run")`, `terminal(command="npx tsc --noEmit")` e `terminal(command="npm run lint")` com Node compatível, `envDir: false` e mocks externos. Não carregue segredos locais nem serviços reais para testar.
- Aplique `supabase/migrations/042_order_intent_priority.sql` somente com autorização de banco e após as migrations anteriores. O commit/push não aplica SQL no Supabase.
- Revise o diff, não versione segredos e só faça commit/push/deploy quando autorizados. Confirme o SHA remoto após push; timeout não comprova publicação nem deploy bem-sucedido.
- Verifique a tabela com `src/lib/orders/delivery-core.test.ts` sempre que o cardápio oficial mudar. Não atualize só a documentação deixando checkout/preços divergentes.
