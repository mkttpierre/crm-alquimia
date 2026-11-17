/**
 * MCP — provedores de IA: listar os conectados, listar os modelos ao vivo e
 * definir o modelo de um ponto, numa ferramenta só (`acao`). Por que uma e não
 * três: ver o cabeçalho de `lib/mcp/tools/catalogo/provedores.ts`.
 *
 * A regra é a MESMA da tela de Provedores e da API (`lib/ai/provedores/
 * operacoes.ts`). Papel admin: trocar o modelo de um ponto muda para onde vão
 * o dinheiro e os dados do cliente. O agente nativo não alcança; um agente
 * externo com token admin e `mcp:write` alcança, e a troca fica no audit log.
 * Endereço próprio (`base_url`) nunca por aqui: 422. A chave nunca volta na resposta (as
 * operações só leem a view segura) e, da instalação, sai só o booleano.
 *
 * `ctx.supabase` é o admin client: as operações filtram `organization_id` em
 * toda consulta, com a organização do TOKEN — nunca de um argumento.
 */
import { z } from "zod";

import { audit } from "@/lib/audit";
import { IDS_DE_PROVEDOR } from "@/lib/ai/pontos/provedores";
import {
  FORMA_DO_PONTO,
  corpoDoPonto,
  definirModeloDoPonto,
  modelosAoVivo,
  provedoresConectados,
  type AmbienteDeIa,
} from "@/lib/ai/provedores/operacoes";
import { lerAmbiente } from "@/lib/instalacao/ambiente";

import type { McpToolDefinition } from "../types";

/** Só os booleanos do ambiente — nunca o valor de uma variável. */
function lerAmbienteDeIa(): AmbienteDeIa {
  const a = lerAmbiente();
  return { chavesDeProvedor: a.chavesDeProvedor, gateway: a.gateway };
}

const ACOES = ["listar_provedores", "listar_modelos", "definir_modelo"] as const;

const provedoresShape = {
  acao: z.enum(ACOES),
  provider: z.enum(IDS_DE_PROVEDOR).optional(),
  purpose: FORMA_DO_PONTO.purpose.optional(),
  credential_id: FORMA_DO_PONTO.credential_id,
  model_id: FORMA_DO_PONTO.model_id.optional(),
  base_url: FORMA_DO_PONTO.base_url,
  is_enabled: FORMA_DO_PONTO.is_enabled,
};

export const crmAiProviders: McpToolDefinition<typeof provedoresShape> = {
  name: "crm_ai_providers",
  description:
    "Provedores de IA desta organização. Exige papel admin. Ações: " +
    "`listar_provedores` — cada provedor: conectado (chave ativa e testada), o motivo quando não está, se a instalação " +
    "tem chave própria dele (só sim/não) e de quando é a lista de modelos. " +
    "`listar_modelos` (exige `provider`; `purpose` e `credential_id` opcionais) — os modelos de conversa que cada chave " +
    "testada libera, sem embeddings/voz/imagem/moderação, e se suportam ferramentas; com `purpose` de ponto que exige " +
    "ferramentas, omite os que não as têm. " +
    "`definir_modelo` (exige `purpose`, `provider`, `model_id`; `credential_id` opcional — sem ele usa a chave da " +
    "instalação, se existir) — grava o modelo do ponto. Recusa ponto fixo, chave de outro provedor, chave não testada, " +
    "modelo fora da lista viva da chave, modelo sem ferramentas onde elas são exigidas e ponto sem chave nenhuma. " +
    "Não aceita `base_url`: endereço próprio só se define na tela, por uma pessoa admin. " +
    "Nunca devolve a chave.",
  inputSchema: provedoresShape,
  category: "write",
  requiresRole: "admin",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    if (input.acao === "listar_provedores") {
      return {
        ok: true,
        ...(await provedoresConectados(ctx.supabase, ctx.organizationId, lerAmbienteDeIa())),
      };
    }

    if (input.acao === "listar_modelos") {
      if (!input.provider) {
        return { ok: false, motivo: "provider_obrigatorio", mensagem: "Informe `provider`." };
      }
      const r = await modelosAoVivo(ctx.supabase, ctx.organizationId, {
        provider: input.provider,
        purpose: input.purpose ?? null,
        credentialId: input.credential_id ?? null,
      });
      if (!r.ok) return { ok: false, motivo: r.codigo, mensagem: r.mensagem };
      return { ok: true, exige_ferramentas: r.exigeFerramentas, credenciais: r.credenciais };
    }

    const parsed = corpoDoPonto.safeParse({
      purpose: input.purpose,
      provider: input.provider,
      model_id: input.model_id,
      credential_id: input.credential_id,
      base_url: input.base_url,
      is_enabled: input.is_enabled,
    });
    if (!parsed.success) {
      return {
        ok: false,
        motivo: "corpo_invalido",
        mensagem: "`definir_modelo` exige `purpose`, `provider` e `model_id` válidos.",
        detalhes: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      };
    }
    const corpo = parsed.data;
    const r = await definirModeloDoPonto(ctx.supabase, ctx.organizationId, corpo, lerAmbienteDeIa(), {
      origem: "agente",
    });
    if (!r.ok) return { ok: false, motivo: r.codigo, mensagem: r.mensagem };
    void audit({
      action: "ai.purpose_binding_updated",
      organizationId: ctx.organizationId,
      actorApiTokenId: ctx.apiTokenId,
      resourceType: "ai_purpose_binding",
      resourceId: r.binding.id,
      requestId: ctx.requestId,
      // Sem credencial no metadata (nem o id): o hábito é o que vaza a chave.
      metadata: {
        purpose: corpo.purpose,
        provider: corpo.provider,
        model_id: corpo.model_id,
        tem_endpoint_proprio: Boolean(corpo.base_url),
        via: "mcp",
        ...(ctx.agenteExterno ? { agente_externo: ctx.agenteExterno.nome } : {}),
      },
    });
    return { ok: true, binding: r.binding, avisos: r.avisos };
  },
};
