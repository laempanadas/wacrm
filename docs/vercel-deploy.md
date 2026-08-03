# Deploy na Vercel — variáveis de ambiente

Este guia mostra como configurar as variáveis de ambiente do CRM do
**La Empanadas** na Vercel, com foco na integração segura do
**Mercado Pago**.

> ⚠️ **Segurança primeiro:** o `MP_ACCESS_TOKEN` é um **segredo de
> servidor**. Ele **nunca** deve aparecer no código, no repositório, nem
> com o prefixo `NEXT_PUBLIC_`. Só o backend (API routes) lê essa chave.

---

## 1. Onde configurar

No painel da Vercel:

1. Abra o projeto do CRM.
2. Vá em **Settings → Environment Variables**.
3. Adicione cada variável abaixo (marque os ambientes **Production**,
   **Preview** e **Development** conforme a necessidade).
4. Após adicionar/alterar variáveis, faça um **Redeploy** para que elas
   entrem em vigor.

---

## 2. Variáveis do Mercado Pago

| Variável           | Onde usar        | Obrigatória | Descrição                                                                 |
| ------------------ | ---------------- | ----------- | ------------------------------------------------------------------------- |
| `MP_ACCESS_TOKEN`  | **Servidor**     | Sim¹        | Access Token da sua conta Mercado Pago (Checkout Pro). **Segredo.**       |
| `MP_PUBLIC_KEY`    | Cliente/servidor | Opcional    | Public Key (usada apenas se houver checkout no frontend).                 |

¹ A integração é **opcional**: enquanto `MP_ACCESS_TOKEN` não estiver
definido, o CRM funciona normalmente e a interface mostra um aviso
amigável em vez de quebrar. Assim que a chave é adicionada (e um redeploy
é feito), a geração de link de pagamento passa a funcionar.

### Como obter o `MP_ACCESS_TOKEN`

1. Acesse o [Painel de desenvolvedores do Mercado Pago](https://www.mercadopago.com.br/developers/panel).
2. Crie (ou selecione) uma aplicação.
3. Em **Credenciais**, copie o **Access Token**:
   - **Produção** (`APP_USR-...`) para cobranças reais.
   - **Teste** para o ambiente de sandbox.
4. Cole o valor em `MP_ACCESS_TOKEN` na Vercel.

Veja também: [`docs/mercado-pago-setup.md`](./mercado-pago-setup.md).

---

## 3. Demais variáveis do projeto

Estas já são necessárias para o CRM funcionar (Supabase e criptografia):

| Variável                        | Onde usar    | Descrição                                             |
| ------------------------------- | ------------ | ----------------------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`      | Cliente      | URL do projeto Supabase.                              |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Cliente      | Chave pública (anon) do Supabase.                     |
| `SUPABASE_SERVICE_ROLE_KEY`     | **Servidor** | Chave service-role do Supabase. **Segredo.**          |
| `ENCRYPTION_KEY`                | **Servidor** | Chave de criptografia (hex de 64 caracteres). Segredo.|

> Consulte `.env.example` / `.env.local.example` para a lista completa e
> valores de exemplo.

---

## 4. Checklist de segurança

- [ ] `MP_ACCESS_TOKEN` está **apenas** nas Environment Variables da
      Vercel (e em `.env.local` no desenvolvimento local).
- [ ] Nenhuma chave real foi commitada no repositório
      (`.env*` está no `.gitignore`).
- [ ] Nenhum segredo usa o prefixo `NEXT_PUBLIC_`.
- [ ] Um **Redeploy** foi feito após adicionar/alterar variáveis.

---

## 5. Testando após o deploy

1. Faça login no CRM.
2. Em um pedido, clique em **Gerar link de pagamento**.
   - Se `MP_ACCESS_TOKEN` estiver ausente, aparece o aviso amigável.
   - Se estiver configurado, o link do Checkout Pro é gerado.
3. Use **Verificar pagamento** para consultar o status do pedido.
