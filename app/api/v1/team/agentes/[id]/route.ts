import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * /api/v1/team/agentes/[id] — um agente externo da equipe (admin).
 *
 *   PATCH  edita nome, tipo, avatar, papel e a chave do motor. Mudar o PAPEL regrava os escopos do token
 *          (`role:<papel>`): é pelo token que o MCP decide. Agente revogado é 409.
 *   DELETE revoga: primeiro o token (`api_tokens.revoked_at` — a partir daqui o MCP responde 401), depois o agente
 *          (`revogado_em`, e o nome ganha o sufixo "(revogado …)" para liberar o original). A linha fica: a auditoria
 *          aponta para ela. Revogar de novo devolve 200 sem escrever.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import {
  COLUNAS_DO_AGENTE,
  edicaoDoAgenteSchema,
  escoposDoAgente,
  nomeDoRevogado,
  type AgenteExterno,
} from "@/lib/agentes-externos/modelo";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type LinhaDoAgente = AgenteExterno & { api_token_id: string | null };

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "external_agents" });
  if (!authz.ok) return authz.response;
  const { org, user } = authz;
  const t = (texto: string) => traduzir(texto, user.idioma);

  const { id } = await params;
  const parsed = edicaoDoAgenteSchema.safeParse(await req.json().catch(() => null));
  if (!z.uuid().safeParse(id).success || !parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      ...(parsed.success ? {} : { details: parsed.error.flatten().fieldErrors as Record<string, unknown> }),
    });
  }
  const edicao = parsed.data;

  const supabase = await createClient();
  const { data: atual, error } = await supabase
    .from("external_agents")
    .select(`${COLUNAS_DO_AGENTE}, api_token_id`)
    .eq("organization_id", org.orgId)
    .eq("id", id)
    .maybeSingle();
  if (error) return fail("internal_error", t("Não foi possível salvar o agente."), 500, { requestId });
  if (!atual) return fail("not_found", t("Agente não encontrado."), 404, { requestId });
  const agente = atual as LinhaDoAgente;
  if (agente.revogado_em) return fail("state_conflict", t("Este agente foi revogado. Crie um novo."), 409, { requestId });

  const mudou = (Object.keys(edicao) as (keyof typeof edicao)[]).filter((k) => edicao[k] !== agente[k]);
  if (mudou.length === 0) return ok({ agente, atualizado: [] }, { requestId });

  // O papel mora no TOKEN (o MCP decide por ele): regrava primeiro, para nunca haver um agente "agent" com token "admin".
  if (mudou.includes("papel") && edicao.papel && agente.api_token_id) {
    const { error: erroToken } = await supabase
      .from("api_tokens")
      .update({ scopes: escoposDoAgente(edicao.papel), updated_at: new Date().toISOString() })
      .eq("organization_id", org.orgId)
      .eq("id", agente.api_token_id);
    if (erroToken) return fail("internal_error", t("Não foi possível salvar o agente."), 500, { requestId });
  }

  const patch = Object.fromEntries(mudou.map((k) => [k, edicao[k]]));
  const { data: depois, error: erroGravar } = await supabase
    .from("external_agents")
    .update(patch)
    .eq("organization_id", org.orgId)
    .eq("id", id)
    .select(COLUNAS_DO_AGENTE)
    .single();
  if (erroGravar) {
    if ((erroGravar as { code?: string }).code === "23505") {
      return fail("state_conflict", t("Já existe um agente com esse nome."), 409, { requestId });
    }
    return fail("internal_error", t("Não foi possível salvar o agente."), 500, { requestId });
  }

  await audit({
    action: "agente_externo.atualizado",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "external_agents",
    resourceId: id,
    requestId,
    metadata: {
      campos: mudou,
      antes: Object.fromEntries(mudou.map((k) => [k, agente[k]])),
      depois: patch,
    },
  });
  return ok({ agente: depois, atualizado: mudou }, { requestId });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "external_agents" });
  if (!authz.ok) return authz.response;
  const { org, user } = authz;
  const t = (texto: string) => traduzir(texto, user.idioma);

  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return fail("validation_failed", t("Dados inválidos."), 422, { requestId });

  const supabase = await createClient();
  const { data: atual, error } = await supabase
    .from("external_agents")
    .select("id, nome, revogado_em, api_token_id")
    .eq("organization_id", org.orgId)
    .eq("id", id)
    .maybeSingle();
  if (error) return fail("internal_error", t("Não foi possível revogar o agente."), 500, { requestId });
  if (!atual) return fail("not_found", t("Agente não encontrado."), 404, { requestId });
  const agente = atual as { id: string; nome: string; revogado_em: string | null; api_token_id: string | null };
  if (agente.revogado_em) return ok({ id, ja_revogado: true }, { requestId });

  const agora = new Date().toISOString();
  // 1º o token: a partir desta linha o MCP responde 401 (lib/mcp/auth.ts), mesmo que o resto falhe.
  if (agente.api_token_id) {
    const { error: erroToken } = await supabase
      .from("api_tokens")
      .update({ revoked_at: agora, revoked_by: user.id, updated_at: agora })
      .eq("organization_id", org.orgId)
      .eq("id", agente.api_token_id)
      .is("revoked_at", null);
    if (erroToken) return fail("internal_error", t("Não foi possível revogar o agente."), 500, { requestId });
  }

  const { error: erroAgente } = await supabase
    .from("external_agents")
    .update({ revogado_em: agora, nome: nomeDoRevogado(agente.nome, agente.id) })
    .eq("organization_id", org.orgId)
    .eq("id", id);
  if (erroAgente) {
    // O token já caiu (o que importa para a segurança); o agente fica marcado na próxima tentativa.
    return fail("internal_error", t("O acesso foi cortado, mas o agente não foi marcado como revogado. Tente de novo."), 500, {
      requestId,
    });
  }

  await audit({
    action: "agente_externo.revogado",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "external_agents",
    resourceId: id,
    requestId,
    metadata: { nome: agente.nome, token_revogado: !!agente.api_token_id },
  });
  return ok({ id, revogado_em: agora }, { requestId });
}
