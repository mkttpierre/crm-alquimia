-- Extensões que o baseline.sql USA mas não cria (é um dump de schema). O Supabase local traz os
-- binários e não as habilita. Idempotente: o instalador aplica isto antes do baseline a cada execução.
create schema if not exists extensions;
create extension if not exists "uuid-ossp" with schema extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists vector with schema public;
create extension if not exists citext with schema public;
create extension if not exists pg_trgm with schema public;
