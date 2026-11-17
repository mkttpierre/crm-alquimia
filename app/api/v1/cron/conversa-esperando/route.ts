/**
 * GET/POST /api/v1/cron/conversa-esperando — emite `conversa.esperando`.
 *
 * A cada 5 min: para cada organização que ASSINA o evento (regra ativa com esse gatilho), as conversas em que o
 * cliente escreveu por último e ninguém respondeu há N minutos (padrão 15, `settings.agentes_externos`) viram um
 * evento cada — uma vez por conversa por espera. O consumidor é o motor de regras (`lib/automation/engine.ts`), que
 * entrega pelo `call_webhook` ao agente externo. Toda a regra mora em `lib/agentes-externos/esperando.ts`.
 *
 * Não envia nada ao cliente. Rodada que não avisou ninguém não audita; a que avisou, audita
 * (`conversa.esperando_avisada`), com a contagem.
 *
 * Auth: mesmo contrato dos demais crons (Bearer INTERNAL_CRON_SECRET|INTERNAL_SECRET, fail-closed). Agendado no
 * `scheduler` (`docker/scheduler/entrypoint.sh`).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { avisarConversasEsperando } from "@/lib/agentes-externos/esperando";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const auth = req.headers.get("authorization") ?? "";
  const provided = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const accepted = [env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET].filter(Boolean);
  if (accepted.length === 0 || !provided || !accepted.includes(provided)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  const r = await avisarConversasEsperando(createAdminClient());
  if (r.falhas.length > 0) {
    logger.warn("[conversa-esperando] falhas na rodada", { falhas: r.falhas.slice(0, 10).join(" | "), requestId });
  }

  if (r.avisadas > 0) {
    void audit({
      action: "conversa.esperando_avisada",
      organizationId: null,
      bypassedRls: true,
      metadata: { avisadas: r.avisadas, organizacoes: r.organizacoes, falhas: r.falhas.length },
      requestId,
    });
  }

  return ok({ avisadas: r.avisadas, organizacoes: r.organizacoes, falhas: r.falhas.length }, { requestId });
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
