/**
 * Trava de não entregue.
 *
 * Mensagem do motor que ficou só com o 1 tique (`disparo_envios.ack = 1`, o SERVER_ACK) e nunca
 * ganhou o DELIVERY_ACK (`ack >= 2` / `entregue_em`) indica número que não recebe: insistir queima o
 * chip. Regras:
 *
 *   - 24 h (`horasMarcar`): o lead é marcado como não entregue e sai de qualquer envio novo. Reaproveita
 *     a marca que o motor, o atendimento, a IA e os scripts de campanha já respeitam
 *     (`crm_leads.custom_fields.nao_contatar = true`, motivo começando por "1 tique", o mesmo padrão
 *     dos 148 leads do CRM antigo) e cancela os envios pendentes do lead.
 *   - 48 h (`horasRemover`): ainda sem entrega, o lead sai por completo da fila do chip que mandou
 *     (cancela o que restar pendente para ele naquele chip e grava `nao_entregue_removido_em`).
 *   - Desfaz sozinha: se a entrega chegar depois (ack atrasado) ou a lead escrever, a marca da trava
 *     sai (só a marca que a própria trava pôs; `nao_contatar` de outro motivo nunca é tocado).
 *
 * `ack` NULL (nenhum aviso do WhatsApp, chip "zumbi") NÃO conta: é falta de dado, não 1 tique
 * (mesma regra de `saude.ts`). Não mexe em rampa, janela, intervalo nem tetos.
 *
 * Config opcional por org em `disparo_config.ritmo.naoEntregue` ({ ligado, horasMarcar, horasRemover,
 * janelaDias }, campo do `ritmoSchema`, editável na tela do motor); sem nada, valem os padrões abaixo. A variável
 * DISPARO_TRAVA_NAO_ENTREGUE=off no servidor vence o banco e desliga tudo (trava de emergência).
 * Roda no worker (`workers/agent-worker/main.ts`) a cada 5 min; tudo em SQL, sem lançar.
 */
import type pg from "pg";
import { setTimeout as sleep } from "node:timers/promises";

import type { Logger } from "@/lib/agent-engine/obs/logger";
import { NAO_ENTREGUE_PADRAO, normalizarNaoEntregue } from "@/lib/disparo/config";

export const MOTIVO_TRAVA_LEAD = "1 tique sem entrega 24h (trava automática)";
export const MOTIVO_CANCELADO_MARCAR = "não entregue: 1 tique sem entrega há 24 h (trava automática)";
export const MOTIVO_CANCELADO_REMOVER = "não entregue há 48 h: removido da fila do chip (trava automática)";
export const INTERVALO_DA_TRAVA_MS = 5 * 60 * 1000;
const LOTE = 500;

export type ConfigTravaNaoEntregue = {
  ligado: boolean;
  horasMarcar: number;
  horasRemover: number;
  janelaDias: number;
};

export const TRAVA_PADRAO: ConfigTravaNaoEntregue = { ...NAO_ENTREGUE_PADRAO };

/** Lê `ritmo.naoEntregue` com padrões e limites (valor estranho nunca desliga nem afrouxa demais). Mesma regra do `ritmoSchema`. */
export const lerConfigTrava = (bruto: unknown): ConfigTravaNaoEntregue => normalizarNaoEntregue(bruto);

export type ResultadoDaTrava = { desfeitos: number; marcados: number; canceladosMarcar: number; removidos: number; canceladosRemover: number };

const SQL_DESFAZER = `
with alvo as (
  select l.id
  from crm_leads l
  left join disparo_envios e on e.organization_id = l.organization_id and e.id::text = l.custom_fields->>'nao_entregue_envio_id'
  where l.organization_id = $1
    and l.custom_fields ? 'nao_entregue_em'
    and (
      coalesce(e.ack, 0) >= 2 or e.entregue_em is not null
      or exists (
        select 1 from disparo_envios d
        where d.organization_id = l.organization_id and d.lead_id = l.id
          and (d.entregue_em is not null or coalesce(d.ack, 0) >= 2)
          and d.enviado_em >= coalesce(e.enviado_em, (l.custom_fields->>'nao_entregue_em')::timestamptz)
      )
      or exists (
        select 1 from messages m
        where m.organization_id = l.organization_id and m.contact_id = l.contact_id and m.direction = 'inbound'
          and m.created_at > coalesce(e.enviado_em, (l.custom_fields->>'nao_entregue_em')::timestamptz)
      )
    )
  limit ${LOTE}
)
update crm_leads l
set custom_fields = (
    l.custom_fields - 'nao_entregue_em' - 'nao_entregue_envio_id' - 'nao_entregue_chip_id'
      - 'nao_entregue_removido_em' - 'nao_entregue_marcou_nao_contatar'
      - (case when l.custom_fields->>'nao_entregue_marcou_nao_contatar' = 'true' and l.custom_fields->>'nao_contatar_motivo' = $2
              then array['nao_contatar', 'nao_contatar_motivo'] else array[]::text[] end)
  ) || jsonb_build_object('nao_entregue_desfeito_em', now())
from alvo a
where l.id = a.id and l.organization_id = $1
returning l.id`;

const SQL_MARCAR = `
with cand as (
  select distinct on (e.lead_id) e.id as envio_id, e.lead_id, e.chip_id
  from disparo_envios e
  join crm_leads l on l.id = e.lead_id and l.organization_id = e.organization_id
  where e.organization_id = $1
    and e.estado = 'enviado' and e.ack = 1 and e.entregue_em is null
    and e.enviado_em <= now() - make_interval(hours => $2::int)
    and e.enviado_em >= now() - make_interval(days => $3::int)
    and not (coalesce(l.custom_fields, '{}'::jsonb) ? 'nao_entregue_em')
    and not exists (
      select 1 from disparo_envios d
      where d.organization_id = e.organization_id and d.lead_id = e.lead_id
        and (d.entregue_em is not null or coalesce(d.ack, 0) >= 2) and d.enviado_em >= e.enviado_em
    )
    and not exists (
      select 1 from messages m
      where m.organization_id = e.organization_id and m.contact_id = l.contact_id and m.direction = 'inbound'
        and m.created_at > e.enviado_em
    )
  order by e.lead_id, e.enviado_em
  limit ${LOTE}
), marcados as (
  update crm_leads l
  set custom_fields = coalesce(l.custom_fields, '{}'::jsonb)
    || jsonb_build_object('nao_entregue_em', now(), 'nao_entregue_envio_id', c.envio_id, 'nao_entregue_chip_id', c.chip_id)
    || (case when lower(trim(coalesce(l.custom_fields->>'nao_contatar', ''))) = 'true' then '{}'::jsonb
             else jsonb_build_object('nao_contatar', true, 'nao_contatar_motivo', $4::text, 'nao_entregue_marcou_nao_contatar', true) end)
  from cand c
  where l.id = c.lead_id and l.organization_id = $1
  returning l.id
), cancelados as (
  update disparo_envios p
  set estado = 'cancelado', motivo = $5::text
  where p.organization_id = $1 and p.estado = 'pendente' and p.lead_id in (select id from marcados)
  returning p.id
)
select (select count(*) from marcados)::int as marcados, (select count(*) from cancelados)::int as cancelados`;

const SQL_REMOVER = `
with alvo as (
  select l.id as lead_id, l.custom_fields->>'nao_entregue_chip_id' as chip_id
  from crm_leads l
  join disparo_envios e on e.organization_id = l.organization_id and e.id::text = l.custom_fields->>'nao_entregue_envio_id'
  where l.organization_id = $1
    and l.custom_fields ? 'nao_entregue_em'
    and not (l.custom_fields ? 'nao_entregue_removido_em')
    and e.entregue_em is null and coalesce(e.ack, 0) < 2
    and e.enviado_em <= now() - make_interval(hours => $2::int)
  limit ${LOTE}
), marcados as (
  update crm_leads l
  set custom_fields = l.custom_fields || jsonb_build_object('nao_entregue_removido_em', now())
  from alvo a
  where l.id = a.lead_id and l.organization_id = $1
  returning l.id
), cancelados as (
  update disparo_envios p
  set estado = 'cancelado', motivo = $3::text
  from alvo a
  where p.organization_id = $1 and p.lead_id = a.lead_id and p.estado = 'pendente'
    and (p.chip_id is null or p.chip_id::text = a.chip_id)
  returning p.id
)
select (select count(*) from marcados)::int as removidos, (select count(*) from cancelados)::int as cancelados`;

/** Uma passada da trava numa org: desfaz o que foi entregue, marca 24 h, remove 48 h. */
export async function travaDaOrg(pool: pg.Pool, org: string, cfg: ConfigTravaNaoEntregue): Promise<ResultadoDaTrava> {
  const desfeitos = (await pool.query(SQL_DESFAZER, [org, MOTIVO_TRAVA_LEAD])).rowCount ?? 0;
  const m = await pool.query<{ marcados: number; cancelados: number }>(SQL_MARCAR, [
    org, cfg.horasMarcar, cfg.janelaDias, MOTIVO_TRAVA_LEAD, MOTIVO_CANCELADO_MARCAR,
  ]);
  const r = await pool.query<{ removidos: number; cancelados: number }>(SQL_REMOVER, [org, cfg.horasRemover, MOTIVO_CANCELADO_REMOVER]);
  return {
    desfeitos,
    marcados: m.rows[0]?.marcados ?? 0,
    canceladosMarcar: m.rows[0]?.cancelados ?? 0,
    removidos: r.rows[0]?.removidos ?? 0,
    canceladosRemover: r.rows[0]?.cancelados ?? 0,
  };
}

/** Passada em todas as orgs com `disparo_config`. Nunca lança: erro de uma org vira log e segue. */
export async function rodarTravaNaoEntregue(pool: pg.Pool, log: Logger): Promise<void> {
  if ((process.env.DISPARO_TRAVA_NAO_ENTREGUE ?? "").trim().toLowerCase() === "off") return;
  let orgs: { organization_id: string; cfg: unknown }[];
  try {
    orgs = (await pool.query<{ organization_id: string; cfg: unknown }>(
      "select organization_id, ritmo->'naoEntregue' as cfg from disparo_config",
    )).rows;
  } catch (err) {
    log.error("disparo.trava_nao_entregue: leitura das orgs falhou", { error: (err as Error).message.slice(0, 300) });
    return;
  }
  for (const o of orgs) {
    const cfg = lerConfigTrava(o.cfg);
    if (!cfg.ligado) continue;
    try {
      const r = await travaDaOrg(pool, o.organization_id, cfg);
      if (r.desfeitos + r.marcados + r.removidos + r.canceladosMarcar + r.canceladosRemover > 0) {
        log.info("disparo.trava_nao_entregue: passada", { organization_id: o.organization_id, ...r, horas_marcar: cfg.horasMarcar, horas_remover: cfg.horasRemover });
      }
    } catch (err) {
      log.error("disparo.trava_nao_entregue: passada falhou", { organization_id: o.organization_id, error: (err as Error).message.slice(0, 300) });
    }
  }
}

/** Laço do worker: uma passada logo no boot e depois a cada `intervalMs`. Para no abort. */
export async function runTravaNaoEntregueLoop(
  pool: pg.Pool,
  opts: { intervalMs?: number },
  log: Logger,
  signal: AbortSignal,
): Promise<void> {
  const intervalo = opts.intervalMs ?? INTERVALO_DA_TRAVA_MS;
  log.info("disparo.trava_nao_entregue: ligada", { intervalo_ms: intervalo, padrao: TRAVA_PADRAO });
  while (!signal.aborted) {
    await rodarTravaNaoEntregue(pool, log);
    try {
      await sleep(intervalo, undefined, { signal });
    } catch {
      return;
    }
  }
}
