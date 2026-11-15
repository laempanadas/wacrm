# Resumo do diagnóstico — conversas duplicadas

Versão curta para ler no terminal. A versão completa está em
docs/diagnostico-conversas-duplicadas.md.

## O que aconteceu

- A mesma cliente ganhou várias conversas na Caixa de Entrada.
- Causa: o webhook buscava a conversa com .single(). Com duas linhas,
  o erro era tratado como "não existe" e outra conversa era criada.
- Os contatos estão certos: as consultas 1, 2 e 3 deram zero linhas.
- A Livia (5511982378636) tem um único contato com 17 conversas.
- Os payloads dela vieram com from = 5511982378636 e user_id = null.
  Ou seja, não é BSUID. O problema é só de conversas.

## O que já foi corrigido no código (não commitado)

- Helper único para achar ou criar conversa: pega a mais antiga e trata a corrida.
- Usado no webhook, no envio pelo painel e na API pública.
- Inbox ordena por última atividade também em tempo real.
- Detecção de remetente em BSUID (proteção preventiva, não resolve este caso).
- Testes: 121 arquivos, 1926 testes passando. tsc ok. Lint ok nos arquivos alterados.

## Pendências do relatório

1. Sabores após carrinho do catálogo: mantido em revisão humana.
2. Carrinho sem fluxo: já existe handoff com aviso ao cliente, IA pausada,
   tag e notificação, sem cobrança. Lacuna: se der exceção, o cliente pode
   ficar sem resposta. Não alterado.
3. ai_autoreply_disabled: mantido como está.

## Merge das conversas (SQL, ainda não executado)

Arquivo: supabase/manual/merge_duplicate_conversations.sql

- Começa em dry-run (apply := false). Sempre termina com
  "ERROR: DRY RUN OK". Isso é esperado e não altera nada.
- Confira nas NOTICEs:
  - "duplicate conversations to merge: 33"
    (38 conversas em 5 contatos, uma mantida por contato)
  - "preflight passed"
  - uma linha "repointed ..." por tabela
- Se aparecer "ABORT: ...", nada foi alterado. Não force. Me envie a mensagem.
- Para aplicar: troque apply := false por apply := true e rode de novo.
  Refaça o dry-run logo antes, pois o webhook segue recebendo mensagens.
- Depois: a consulta 6 do diagnóstico deve retornar 0 linhas.

## Ordem sugerida (depende da sua autorização)

1. Commit e push do código (sem scratch/upgrade-467b7ea/).
2. Deploy. Deploy não aplica migration.
3. Dry-run do merge, conferir NOTICEs.
4. Apply do merge, conferir consulta 6 com 0 linhas.
5. Aplicar migration 043 (supabase/migrations/043_conversations_account_contact_unique.sql).
6. Conferir na Inbox: Livia aparece uma vez, ordenada por última mensagem.

Nada disso foi executado ainda. Commit, push, deploy e SQL precisam da sua autorização.

## Como ler no terminal

  less docs/diagnostico-resumo.md

Ou abra o arquivo no explorador do VS Code.
