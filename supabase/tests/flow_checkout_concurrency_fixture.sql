-- Protocol dependency fixture ONLY, for a new disposable PostgreSQL cluster.
-- This is not an application migration or a full Supabase schema validation.
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
GRANT USAGE ON SCHEMA public TO service_role;
-- Exercise the migration against Supabase-style permissive default grants.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE SCHEMA auth;
CREATE TABLE auth.users(id uuid PRIMARY KEY);
CREATE TABLE public.accounts(id uuid PRIMARY KEY);
CREATE TABLE public.contacts(id uuid PRIMARY KEY);
CREATE TABLE public.messages(id uuid PRIMARY KEY);
CREATE TABLE public.flows(id uuid PRIMARY KEY);
CREATE TABLE public.conversations(
 id uuid PRIMARY KEY, account_id uuid REFERENCES accounts(id),
 status text, updated_at timestamptz, assigned_agent_id uuid
);
-- flow_nodes and flow_runs are loaded verbatim from migration 010 by the runner.
