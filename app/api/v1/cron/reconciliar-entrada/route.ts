/**
 * GET/POST /api/v1/cron/reconciliar-entrada — RECONCILIAÇÃO DE ENTRADA dos canais por QR.
 *
 * Mensagem que o lead mandou e o webhook nunca entregou (reconexão do chip com sincronização,
 * app fora do ar até o provedor desistir de reentregar) fica gravada no servidor do canal e
 * ausente do CRM. A cada 5 min esta rota lê as mensagens recentes de cada sessão conectada,
 * acha as de ENTRADA que faltam em `messages` e as grava pelo mesmo caminho do webhook, com a
 * marca `recuperada` — que impede o sistema de responder sozinho (IA, follow-up, automação,
 * atendimento do motor). Quando recupera, abre ou soma um aviso na Central. O desenho inteiro
 * está em `lib/channels/evolution/reconciliacao.ts`.
 *
 * Query: `dry_run=1` (não grava nada; devolve por sessão lidas, já presentes, ausentes e
 * ignoradas) e `horas=<1..168>` (janela; padrão 24). Nada vem do corpo: a organização de cada
 * mensagem é a da sessão.
 *
 * Auth: Bearer INTERNAL_CRON_SECRET|INTERNAL_SECRET (fail-closed), como os demais crons.
 * Agendamento: `docker/scheduler/entrypoint.sh` (a cada 5 min).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { HORAS_MAXIMO, reconciliarEntrada } from "@/lib/channels/evolution/reconciliacao";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  dry_run: z.enum(["0", "1", "true", "false"]).optional(),
  horas: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(HORAS_MAXIMO))
    .optional(),
});

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const auth = req.headers.get("authorization") ?? "";
  const provided = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const accepted = [env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET].filter(Boolean);
  if (accepted.length === 0 || !provided || !accepted.includes(provided)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  const params = req.nextUrl.searchParams;
  const lido = querySchema.safeParse({
    dry_run: params.get("dry_run") ?? undefined,
    horas: params.get("horas") ?? undefined,
  });
  if (!lido.success) {
    return fail("invalid_request", `Use dry_run=1 e horas entre 1 e ${HORAS_MAXIMO}.`, 400, { requestId });
  }
  const dryRun = lido.data.dry_run === "1" || lido.data.dry_run === "true";

  let resultado: Awaited<ReturnType<typeof reconciliarEntrada>>;
  try {
    resultado = await reconciliarEntrada(createAdminClient(), { dryRun, horas: lido.data.horas, requestId });
  } catch (err) {
    logger.error("[reconciliar-entrada] falhou", {
      error: err instanceof Error ? err.message.slice(0, 160) : "erro",
      requestId,
    });
    return fail("internal_error", "Failed to reconcile inbound messages.", 500, { requestId });
  }

  // Rodada que não gravou nada (inclusive dry_run) não é mutação e não audita.
  if (!resultado.dry_run && resultado.total_recuperadas > 0) {
    void audit({
      action: "message.reconcile_run",
      organizationId: null,
      bypassedRls: true,
      metadata: {
        horas: resultado.horas,
        total_lidas: resultado.total_lidas,
        total_ausentes: resultado.total_ausentes,
        total_recuperadas: resultado.total_recuperadas,
        sessoes: resultado.sessoes
          .filter((s) => s.recuperadas > 0)
          .map((s) => ({ channel_session_id: s.channel_session_id, organization_id: s.organization_id, recuperadas: s.recuperadas })),
      },
      requestId,
    });
  }

  return ok(resultado, { requestId });
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
