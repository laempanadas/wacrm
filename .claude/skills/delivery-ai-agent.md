# Skill: Agente de Atendimento Delivery & Redução de Tokens

## Objetivo
Refatorar o motor de IA e Webhook do wacrm para operação de restaurante/delivery:
1. Reativar o bot automaticamente para clientes antigos após 2 horas de inatividade (Reset de Handoff).
2. Economizar 80% de tokens com Cache/Regras Determinísticas (Zero-Token Match para Cardápio, Horário e Pix).
3. Nunca deixar cliente sem resposta enquanto a cozinha estiver em pico.

## Regras de Implementação

### 1. Reset Automático de Handoff (Conversas Recorrentes)
- Localizar onde a flag de `ai_enabled` ou `handoff_status` é verificada no webhook de entrada.
- Se a última mensagem da conversa ocorreu há mais de **2 horas**, a conversa deve ser reiniciada com `ai_enabled = true` e o contador de mensagens zerado.
- Clientes cadastrados na base **DEVEM** receber atendimento da IA normalmente.

### 2. Camada Zero-Token (Fast Path Regex)
Antes de chamar a API da OpenAI/Anthropic, interceptar mensagens frequentes direto no código:
- "estão atendendo", "aberto", "horário", "boa noite", "olá" -> Responder status do restaurante imediatamente sem gastar token de LLM.
- "cardápio", "menu", "sabores" -> Enviar link do cardápio / lista de empanadas instantaneamente.
- "chave pix", "pagamento", "mercado pago" -> Enviar instruções de pagamento integradas.

### 3. Handoff Inteligente (Cozinha Ocupada)
- Se o cliente pedir algo fora do escopo ou solicitar "falar com atendente":
  - O bot responde: *"Nosso time está preparando os pedidos na cozinha! Já vamos te responder aqui, só um instante."*
  - Muda a tag da conversa para `Precisa de Atendente` e notifica o painel.

### 4. Arquivos Alvo no Repositório
- Inspecione rotas em:
  - `src/app/api/webhooks/whatsapp/...` ou `app/api/webhook/...`
  - `src/lib/ai/...` ou `lib/agents/...`
  - Tabelas Supabase de `conversations` e `messages`.
