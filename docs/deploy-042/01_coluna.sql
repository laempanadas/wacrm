-- APLICACAO MANUAL; NAO EXECUTADO. Fora de supabase/migrations.
-- Passo aditivo: nao troca a funcao nem altera pausas existentes.
-- Confirme o tipo com 00_verificar.sql antes e depois; IF NOT EXISTS nao corrige tipo errado.
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS bot_order_resumed_at timestamptz;
