<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# La Empanadas — delivery e pagamentos

Todo agente deve ler `.hermes/skills/delivery-core.md` antes de qualquer alteração neste projeto. O arquivo contém a Tabela Oficial de Preços, frete grátis de R$ 0,00 sem mínimo, os canais Site/Catálogo Meta/Texto Livre 50+ e as regras de handoff, IA e pagamento seguro. Carregue-o explicitamente com a ferramenta de leitura de arquivos; não presuma que um arquivo Markdown de skill foi instalado no perfil do agente.

Intenção de pedido sempre tem prioridade sobre pausas de atendente: quantidade e produto reconhecidos no catálogo da conta retomam o pedido, sem liberar claims de pagamento incertos nem cobrar sem validação e confirmação.

Não leia `.env.local` ou outros segredos. Preserve isolamento por conta, disponibilidade e IDs reais do catálogo. Testes devem usar `envDir: false`, valores fictícios e mocks de serviços externos. Antes de finalizar código, execute Vitest, TypeScript e lint, e revise as mudanças. Commit/push/deploy e execução de migrations exigem autorização explícita; publicar código não aplica migrations no Supabase.
