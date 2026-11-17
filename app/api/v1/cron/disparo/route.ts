/**
 * GET/POST /api/v1/cron/disparo — uma volta do motor de disparo (Fase 5).
 *
 * Planeja e consome a fila `disparo_envios` de cada organização com
 * `disparo_config.ligado = true`, um envio por chip por volta, no ritmo do
 * `lib/disparo/ritmo.ts`. Em modo simulado (o default, e o ÚNICO possível
 * enquanto `DISPARO_REAL_LIBERADO` não for `sim` no servidor) o envio só ganha
 * o estado `simulado`: nenhum canal é chamado. Ver `lib/disparo/trava.ts`.
 *
 * Auth: mesmo contrato dos demais crons (Bearer INTERNAL_CRON_SECRET |
 * INTERNAL_SECRET, ou X-Cron-Secret), fail-closed. Volta sem efeito não
 * audita; volta que mexeu na fila audita uma linha agregada.
 *
 * Relógio de ensaio: `X-Disparo-Agora: <ISO-8601>` faz a volta rodar como se
 * fosse aquele instante (para ensaiar janela, rampa e pausas sem esperar dias).
 * Só é aceito com o envio real TRAVADO no servidor (`DISPARO_REAL_LIBERADO`
 * diferente de `sim`); com a trava aberta o header é recusado com 400 — o
 * relógio do envio real é sempre o do servidor.
 *
 * Sequência do operador (`/funil-valores`): a volta SEGUE as partes seguintes da sequência que acabou de mandar uma
 * parte, no horário de cada uma (3 s depois de texto/imagem, 29-34 s depois de áudio), por até
 * `ORCAMENTO_DA_SEQUENCIA_MS` (110 s). Por isso esta volta pode durar mais que o `-m45` do `curl` do scheduler: o curl
 * desiste (a resposta ia para /dev/null) e esta rota não escuta `req.signal`, então segue até o fim. A volta seguinte,
 * um minuto depois, não manda a mesma parte duas vezes (reserva atômica) nem fora de ordem.
 *
 * Voltas sobrepostas (auditoria 3, A5): cada chip tem trava com dono e prazo (`disparo_travas`, `chip:<id>`); a volta
 * que acha o chip trancado o deixa para a outra. Toda volta, com ou sem efeito, grava duração e resultado por chip em
 * `disparo_voltas` (uma linha por organização) e uma linha de log; só a que teve efeito audita.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { criarEnvioDeAviso, criarEnvioReal } from "@/lib/disparo/envio-real";
import { ORCAMENTO_DA_SEQUENCIA_MS, rodarDisparo } from "@/lib/disparo/motor";
import { repositorioSupabase } from "@/lib/disparo/repositorio-supabase";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const provided = bearer || (req.headers.get("x-cron-secret")?.trim() ?? "");
  const accepted = [env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET].filter(Boolean);
  if (accepted.length === 0 || !provided || !accepted.includes(provided)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  const ambiente = { DISPARO_REAL_LIBERADO: env.DISPARO_REAL_LIBERADO, DISPARO_SO_PARA: env.DISPARO_SO_PARA };
  let agora = new Date();
  const relogio = req.headers.get("x-disparo-agora")?.trim();
  if (relogio) {
    if (ambiente.DISPARO_REAL_LIBERADO === "sim") {
      return fail("invalid_request", "X-Disparo-Agora só vale com o envio real travado.", 400, { requestId });
    }
    const t = Date.parse(relogio);
    if (!/^\d{4}-\d{2}-\d{2}T/.test(relogio) || Number.isNaN(t)) {
      return fail("invalid_request", "X-Disparo-Agora precisa ser ISO-8601.", 400, { requestId });
    }
    agora = new Date(t);
  }

  // Relógio da volta: parte de `agora` (o do servidor, ou o de ensaio do header) e anda com o relógio de verdade. É o que
  // permite ao motor seguir uma sequência do operador DENTRO da volta, na cadência de 3 s / 29-34 s.
  const inicio = Date.now();
  const relogioDaVolta = () => new Date(agora.getTime() + (Date.now() - inicio));

  const admin = createAdminClient();
  let resumo;
  try {
    resumo = await rodarDisparo({
      repo: repositorioSupabase(admin),
      agora,
      ambiente,
      sortear: Math.random,
      enviarReal: criarEnvioReal(admin, ambiente),
      enviarAviso: criarEnvioDeAviso(admin, ambiente),
      sequencia: {
        relogio: relogioDaVolta,
        dormir: (ms) => new Promise((r) => setTimeout(r, ms)),
        orcamentoMs: ORCAMENTO_DA_SEQUENCIA_MS,
      },
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("[disparo.cron] rodarDisparo threw", { error: detail, requestId });
    return fail("internal_error", detail, 500, { requestId });
  }

  const duracaoMs = Date.now() - inicio;
  logger.info("[disparo.cron] volta", {
    requestId,
    duracao_ms: duracaoMs,
    efeito: resumo.efeito,
    organizacoes: resumo.organizacoes.map((o) => ({
      organization_id: o.organizationId,
      enviados: o.enviados,
      simulados: o.simulados,
      cancelados: o.cancelados,
      falhas: o.falhas,
      avisos: o.avisos,
      erro: o.erro ?? null,
      chips: o.chips.map((c) => `${c.chipId.slice(0, 8)}: ${c.resultado.slice(0, 120)}`),
    })),
  });

  if (resumo.efeito) {
    for (const o of resumo.organizacoes) {
      if (o.saidos + o.cancelados + o.falhas + o.lembretes + o.avisos > 0) {
        void audit({
          action: "disparo.volta",
          organizationId: o.organizationId,
          bypassedRls: true,
          metadata: {
            modo: o.modo,
            simulados: o.simulados,
            enviados: o.enviados,
            cancelados: o.cancelados,
            falhas: o.falhas,
            lembretes: o.lembretes,
            avisos: o.avisos,
            duracao_ms: duracaoMs,
            erro: o.erro ?? null,
          },
          requestId,
        });
      }
    }
  }

  return ok(resumo, { requestId });
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
