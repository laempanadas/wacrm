# Configuração do Mercado Pago — La Empanadas CRM

Este guia mostra, passo a passo, como obter e configurar as credenciais do
Mercado Pago para gerar **links de pagamento** dos pedidos e enviá-los ao
cliente pelo WhatsApp.

> A integração é **opcional**. Enquanto as credenciais não estiverem
> configuradas, o CRM continua funcionando normalmente — apenas o botão de
> gerar link de pagamento exibirá um aviso pedindo a configuração.

---

## 1. Criar/entrar na conta Mercado Pago

1. Acesse [https://www.mercadopago.com.br](https://www.mercadopago.com.br) e faça login (ou crie uma conta para o seu negócio).
2. Recomendado: use a conta **empresarial** do La Empanadas para que os pagamentos caiam na conta certa.

## 2. Acessar o painel de desenvolvedores

1. Entre em [https://www.mercadopago.com.br/developers/panel](https://www.mercadopago.com.br/developers/panel).
2. No menu **Suas integrações**, crie uma aplicação (ex.: "La Empanadas CRM").
   - Tipo de solução: **Pagamentos online** → **Checkout Pro**.

## 3. Copiar as credenciais

Dentro da aplicação criada, vá em **Credenciais**. Você verá dois conjuntos:

| Ambiente | Uso |
| --- | --- |
| **Credenciais de teste** (sandbox) | Para testar sem cobrar de verdade |
| **Credenciais de produção** | Para cobrar clientes reais |

De cada ambiente, copie:

- **Access Token** → variável `MP_ACCESS_TOKEN`
- **Public Key** → variável `MP_PUBLIC_KEY`

> ⚠️ **Nunca** compartilhe o Access Token publicamente nem o coloque no
> código do front-end. Ele fica apenas nas variáveis de ambiente do
> servidor.

## 4. Configurar as variáveis de ambiente

### Localmente (`.env.local`)

Copie o modelo e preencha:

```bash
cp .env.local.example .env.local
```

Depois edite `.env.local` e defina:

```env
# Mercado Pago - Configure quando disponível
MP_ACCESS_TOKEN=APP_USR-xxxxxxxxxxxxxxxx-...
MP_PUBLIC_KEY=APP_USR-xxxxxxxxxxxxxxxx-...
```

### Na Vercel (produção)

O app está publicado em `wacrm-eta-ten.vercel.app`. Para configurar em produção:

1. Acesse o projeto na [Vercel](https://vercel.com/) → **Settings** → **Environment Variables**.
2. Adicione:
   - `MP_ACCESS_TOKEN` = seu Access Token de **produção**
   - `MP_PUBLIC_KEY` = sua Public Key de **produção**
3. Selecione o ambiente **Production** (e Preview, se quiser testar em branches).
4. Clique em **Save** e faça um **Redeploy** para as variáveis entrarem em vigor.

## 5. Testar a integração

1. Comece pelas **credenciais de teste** para não cobrar de verdade.
2. No CRM, gere um link de pagamento para um pedido.
3. Abra o link e conclua um pagamento usando os
   [cartões de teste do Mercado Pago](https://www.mercadopago.com.br/developers/pt/docs/checkout-pro/additional-content/your-integrations/test/cards).
4. Confirmado o fluxo, troque para as **credenciais de produção**.

## 6. Como o CRM usa as credenciais

- Endpoint interno: `POST /api/payments/mercado-pago`
  - Cria uma **preferência de pagamento** (Checkout Pro) com os itens do pedido.
  - Retorna a URL de pagamento (`init_point`) para enviar ao cliente.
- Endpoint de status: `GET /api/payments/mercado-pago`
  - Informa se a integração está configurada (a UI usa isso para exibir avisos).
- Toda a comunicação com o Mercado Pago acontece **no servidor**, usando o
  `MP_ACCESS_TOKEN`. A `MP_PUBLIC_KEY` fica reservada para eventuais recursos
  de checkout no front-end.

## 7. Fluxo de uso no dia a dia

1. O pedido avança no pipeline (**Novo Pedido → Confirmado → …**).
2. No pedido, clique em **Gerar link de pagamento**.
3. O CRM devolve a URL do Mercado Pago.
4. Copie/envie a URL ao cliente pelo WhatsApp.
5. O cliente paga por Pix, cartão ou boleto na página do Mercado Pago.

---

### Dúvidas frequentes

**O botão diz que o Mercado Pago não está configurado.**
Verifique se `MP_ACCESS_TOKEN` está definido no ambiente (local ou Vercel) e
faça um redeploy após adicionar a variável.

**Posso usar Pix?**
Sim. O Checkout Pro do Mercado Pago já oferece Pix, cartão e boleto na mesma
página de pagamento, conforme a configuração da sua conta.
