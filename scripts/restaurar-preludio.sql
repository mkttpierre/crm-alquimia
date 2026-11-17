-- CRM ALQUIM(IA): preparação da restauração (scripts/restaurar.sh e restaurar.ps1).
-- Roda na MESMA transação do backup (psql --single-transaction): se qualquer comando falhar, nada muda.
-- Roda como `supabase_admin` (lib/backup.*): as tabelas e sequências de auth.* e storage.* são dele, e como
-- `postgres` o TRUNCATE ... RESTART IDENTITY abaixo falha com "must be owner of sequence
-- refresh_tokens_id_seq" (prova de instalação).
--
-- 1. `replica` desliga a checagem de chaves estrangeiras durante a carga (o backup carrega as tabelas
--    em qualquer ordem).
-- 2. Esvazia as tabelas de dados (public, auth e storage) para a carga não duplicar linhas. O que NÃO é
--    esvaziado: o controle de versão do próprio Supabase (auth.schema_migrations, storage.migrations).
-- O schema (tabelas, funções, políticas) não é tocado: ele vem do instalador. Restaure na MESMA versão do
-- CRM em que o backup foi feito (numa máquina nova: rode o instalador primeiro).
-- 0. Se algum serviço ainda segura uma tabela, desiste em 60 s (a transação inteira volta atrás) em vez de
--    ficar esperando para sempre.
SET lock_timeout = '60s';
SET session_replication_role = replica;

DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT format('%I.%I', schemaname, tablename)
    FROM pg_tables
    WHERE schemaname = 'public'
       OR (schemaname = 'auth' AND tablename <> 'schema_migrations')
       OR (schemaname = 'storage' AND tablename <> 'migrations')
  LOOP
    EXECUTE 'TRUNCATE TABLE ' || t || ' RESTART IDENTITY CASCADE';
  END LOOP;
END
$$;
