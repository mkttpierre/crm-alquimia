import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * /api/v1/team/agentes — os agentes externos da equipe: OpenBot, Claude Code, Codex, outro.
 *
 *   GET   (agent+) os agentes ativos com a presença (online < 5 min e a última ação). O admin recebe também os
 *         revogados, o endereço do app (para montar o bloco de conexão) e o N do aviso `conversa.esperando`.
 *   POST  (admin) cria o agente E o token dele (`api_tokens`, escopos `actor:ai_agent`, `role:<papel>`, `mcp:read`,
 *         `mcp:write`). O token em texto puro volta UMA vez, nesta resposta; no banco só fica o hash.
 *   PATCH (admin) `{ minutos_conversa_esperando }`: o N do evento `conversa.esperando` (1 a 1440, padrão 15), em
 *         `organizations.settings.agentes_externos`.
 *
 * A organização vem da sessão (`requireRole`), nunca do corpo. Escritas em `external_agents` e `api_tokens` pela
 * sessão (a RLS de admin vale); `organizations.settings` pelo admin client com o id da sessão.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { MINUTOS_DE_ESPERA_PADRAO, minutosDeEspera } from "@/lib/agentes-externos/esperando";
import {
  COLUNAS_DO_AGENTE,
  criacaoDoAgenteSchema,
  escoposDoAgente,
  estaOnline,
  type AgenteExterno,
} from "@/lib/agentes-externos/modelo";
import { gerarTokenDeApi } from "@/lib/agentes-externos/token";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { roleAtLeast } from "@/lib/auth/types";
import { env } from "@/lib/env";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** O endereço que o agente usa para chegar ao `/api/mcp`: o configurado, senão o da própria requisição. */
function enderecoDoApp(req: NextRequest): string {
  return env.NEXT_PUBLIC_APP_URL || new URL(req.url).origin;
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "external_agents" });
  if (!authz.ok) return authz.response;
  const { org, user } = authz;
  const t = (texto: string) => traduzir(texto, user.idioma);
  const ehAdmin = roleAtLeast(org.role, "admin");

  const supabase = await createClient();
  let consulta = supabase
    .from("external_agents")
    .select(COLUNAS_DO_AGENTE)
    .eq("organization_id", org.orgId)
    .order("created_at", { ascending: true });
  if (!ehAdmin) consulta = consulta.is("revogado_em", null);
  const { data, error } = await consulta;
  if (error) return fail("internal_error", t("Não foi possível ler os agentes."), 500, { requestId });

  const agora = new Date();
  const agentes = ((data ?? []) as AgenteExterno[]).map((a) => ({
    ...a,
    online: !a.revogado_em && estaOnline(a.ultimo_uso_em, agora),
  }));
  if (!ehAdmin) return ok({ agentes }, { requestId });

  const { data: organizacao } = await supabase.from("organizations").select("settings").eq("id", org.orgId).maybeSingle();
  return ok(
    {
      agentes,
      app_url: enderecoDoApp(req),
      // Sem NEXT_PUBLIC_APP_URL o bloco sai com o endereço desta requisição — atrás de proxy, pode ser um host interno.
      app_url_configurado: Boolean(env.NEXT_PUBLIC_APP_URL),
      minutos_conversa_esperando: minutosDeEspera((organizacao as { settings?: unknown } | null)?.settings),
    },
    { requestId },
  );
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "external_agents" });
  if (!authz.ok) return authz.response;
  const { org, user } = authz;
  const t = (texto: string) => traduzir(texto, user.idioma);

  const parsed = criacaoDoAgenteSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  const entrada = parsed.data;
  const supabase = await createClient();

  // Nome repetido antes de criar o token: um token sem agente seria uma chave solta.
  const { data: mesmoNome, error: erroNome } = await supabase
    .from("external_agents")
    .select("id")
    .eq("organization_id", org.orgId)
    .eq("nome", entrada.nome)
    .maybeSingle();
  if (erroNome) return fail("internal_error", t("Não foi possível criar o agente."), 500, { requestId });
  if (mesmoNome) return fail("state_conflict", t("Já existe um agente com esse nome."), 409, { requestId });

  const token = gerarTokenDeApi();
  const { data: tokenCriado, error: erroToken } = await supabase
    .from("api_tokens")
    .insert({
      organization_id: org.orgId,
      created_by: user.id,
      name: `Agente: ${entrada.nome}`.slice(0, 120),
      prefix: token.prefixo,
      token_hash: token.hashLiteral,
      scopes: escoposDoAgente(entrada.papel),
      expires_at: null,
    })
    .select("id")
    .single();
  if (erroToken || !tokenCriado) return fail("internal_error", t("Não foi possível criar o agente."), 500, { requestId });

  const { data: agente, error: erroAgente } = await supabase
    .from("external_agents")
    .insert({
      organization_id: org.orgId,
      nome: entrada.nome,
      tipo: entrada.tipo,
      avatar_url: entrada.avatar_url ?? null,
      papel: entrada.papel,
      pode_motor: entrada.pode_motor,
      api_token_id: (tokenCriado as { id: string }).id,
      created_by: user.id,
    })
    .select(COLUNAS_DO_AGENTE)
    .single();
  if (erroAgente || !agente) {
    // O token já existe e não tem dono: revoga na hora, para não sobrar uma chave válida sem agente.
    await supabase
      .from("api_tokens")
      .update({ revoked_at: new Date().toISOString(), revoked_by: user.id })
      .eq("id", (tokenCriado as { id: string }).id)
      .eq("organization_id", org.orgId);
    if ((erroAgente as { code?: string } | null)?.code === "23505") {
      return fail("state_conflict", t("Já existe um agente com esse nome."), 409, { requestId });
    }
    return fail("internal_error", t("Não foi possível criar o agente."), 500, { requestId });
  }
  const criado = agente as AgenteExterno;

  await audit({
    action: "agente_externo.criado",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "external_agents",
    resourceId: criado.id,
    requestId,
    // Nunca o token: só o prefixo, que identifica sem autenticar.
    metadata: { nome: criado.nome, tipo: criado.tipo, papel: criado.papel, pode_motor: criado.pode_motor, prefixo: token.prefixo },
  });

  return ok(
    {
      agente: { ...criado, online: false },
      token: token.textoPuro,
      app_url: enderecoDoApp(req),
      _aviso: t("Copie agora: o token não será mostrado de novo."),
    },
    { requestId, status: 201 },
  );
}

const configSchema = z.object({ minutos_conversa_esperando: z.number().int().min(1).max(1440) }).strict();

export async function PATCH(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "external_agents" });
  if (!authz.ok) return authz.response;
  const { org, user } = authz;
  const t = (texto: string) => traduzir(texto, user.idioma);

  const parsed = configSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", t("Dados inválidos."), 422, { requestId });

  const admin = createAdminClient();
  const { data: organizacao, error } = await admin.from("organizations").select("settings").eq("id", org.orgId).maybeSingle();
  if (error || !organizacao) return fail("internal_error", t("Não foi possível salvar o ajuste."), 500, { requestId });
  const settings = ((organizacao as { settings?: Record<string, unknown> | null }).settings ?? {}) as Record<string, unknown>;
  const antes = minutosDeEspera(settings);
  const bloco = (settings.agentes_externos && typeof settings.agentes_externos === "object" ? settings.agentes_externos : {}) as Record<
    string,
    unknown
  >;
  const novo = { ...settings, agentes_externos: { ...bloco, minutos_conversa_esperando: parsed.data.minutos_conversa_esperando } };
  const { error: erroGravar } = await admin.from("organizations").update({ settings: novo }).eq("id", org.orgId);
  if (erroGravar) return fail("internal_error", t("Não foi possível salvar o ajuste."), 500, { requestId });

  await audit({
    action: "agente_externo.atualizado",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "organization",
    resourceId: org.orgId,
    requestId,
    metadata: {
      campo: "agentes_externos.minutos_conversa_esperando",
      antes,
      depois: parsed.data.minutos_conversa_esperando,
      padrao: MINUTOS_DE_ESPERA_PADRAO,
    },
  });
  return ok({ minutos_conversa_esperando: parsed.data.minutos_conversa_esperando }, { requestId });
}
