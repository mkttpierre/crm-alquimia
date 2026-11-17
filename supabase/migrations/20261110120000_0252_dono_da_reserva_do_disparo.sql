-- 0252 — dono da reserva do motor de disparo (E5, varredura de 10/11/2026).
--
-- A reserva `pendente` → `enviando` não tinha dono: a marca de "canal chamado" e o fechamento só conferiam
-- `estado = 'enviando'`. Se uma volta travava mais que `enviandoPresoMin` entre reservar e chamar o canal, a varredura
-- de outra volta devolvia a linha à fila, essa outra volta a reservava e mandava — e a primeira, ao acordar, passava
-- na mesma conferência e mandava de novo (reproduzido em `lib/disparo/motor-travas.test.ts`, bloco E5).
--
-- Agora a reserva grava quem reservou (o id da volta); a marca de canal e o desfecho dados pela volta só valem se a
-- reserva ainda for dela. Coluna NULLABLE, sem default e sem backfill: linhas antigas ficam com null e nada muda
-- para elas (a varredura de presos não usa a coluna).
--
-- ORDEM NA SUBIDA: aplicar ANTES do código novo. O código novo grava a coluna na reserva; sem ela, a reserva falha,
-- nada sai (falha segura) e o aviso de parada silenciosa aparece.

alter table public.disparo_envios add column if not exists reservado_por text;

comment on column public.disparo_envios.reservado_por is
  'Volta do motor que reservou a linha (pendente → enviando). A marca de canal e o desfecho só valem para ela (0252).';

notify pgrst, 'reload schema';
