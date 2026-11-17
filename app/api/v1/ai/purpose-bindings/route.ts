/**
 * PUT /api/v1/ai/purpose-bindings — define provedor, chave e modelo de um
 * ponto do sistema que usa IA. Para agentes (bearer) e para a tela (sessão).
 *
 * Mesmo corpo e mesma regra do `PUT /api/v1/ai/providers` da tela
 * (`lib/ai/provedores/operacoes.ts`): 422 claro para ponto fixo, chave de
 * outro provedor ou de outra organização, chave não testada, modelo fora da
 * lista viva da chave, modelo sem ferramentas onde elas são exigidas e ponto
 * sem chave nenhuma. Papel admin, sessão ou bearer `mcp:write`. Audita
 * `ai.purpose_binding_updated` com o ator certo (usuário ou token), sem
 * credencial no metadata.
 */
import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { autorizarGestaoDeIa } from "@/lib/ai/provedores/autorizar";
import { corpoDoPonto, definirModeloDoPonto } from "@/lib/ai/provedores/operacoes";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { traduzir } from "@/lib/i18n/dicionario";
import { lerAmbiente } from "@/lib/instalacao/ambiente";

export const dynamic = "force-dynamic";

export async function PUT(req: Request): Promise<Response> {
  const requestId = randomUUID();
  const authz = await autorizarGestaoDeIa(req, { escrita: true, requestId });
  if (!authz.ok) return authz.response;
  // Sessão de suporte (impersonação) só lê — a mesma trava da rota da tela.
  if (authz.actorUserId !== null) {
    const supportDenied = await requireSupportWrite();
    if (supportDenied) return supportDenied;
  }
  const t = (texto: string) => (authz.idioma ? traduzir(texto, authz.idioma) : texto);

  const parsed = corpoDoPonto.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("invalid_body", t("corpo inválido"), 422, {
      details: { issues: parsed.error.issues },
      requestId,
    });
  }
  const corpo = parsed.data;

  const ambiente = lerAmbiente();
  const r = await definirModeloDoPonto(authz.db, authz.orgId, corpo, {
    chavesDeProvedor: ambiente.chavesDeProvedor,
    gateway: ambiente.gateway,
  }, {
    // Bearer é agente: não define endereço próprio (para onde a chave vai).
    origem: authz.actorApiTokenId ? "agente" : "sessao",
  });
  if (!r.ok) return fail(r.codigo, t(r.mensagem), r.status, { requestId });

  void audit({
    action: "ai.purpose_binding_updated",
    organizationId: authz.orgId,
    actorUserId: authz.actorUserId,
    actorApiTokenId: authz.actorApiTokenId,
    resourceType: "ai_purpose_binding",
    resourceId: r.binding.id,
    requestId,
    metadata: {
      purpose: corpo.purpose,
      provider: corpo.provider,
      model_id: corpo.model_id,
      tem_endpoint_proprio: Boolean(corpo.base_url),
      via: authz.actorApiTokenId ? "api_bearer" : "api_sessao",
    },
  });

  return ok({ binding: r.binding, avisos: r.avisos }, { requestId });
}
