/**
 * AS TRÊS OPERAÇÕES DE PROVEDOR DE IA, num lugar só: listar os provedores
 * conectados, listar os modelos ao vivo e definir o modelo de um ponto.
 *
 * Quem chama: a tela de Provedores (`app/api/v1/ai/providers`, sessão), a API
 * para agentes (`app/api/v1/ai/connected-providers`, `.../purpose-bindings`,
 * sessão OU bearer) e as ferramentas do MCP (`lib/mcp/tools/provedores.ts`).
 * Três superfícies com três cópias da regra seriam três respostas diferentes
 * para "este modelo pode ser salvo aqui?" — é como nasce a tela que mente.
 *
 * Regras que valem para todas:
 *  - **A chave nunca sai.** Só se lê a view `ai_provider_credentials_safe`,
 *    que não tem as colunas do segredo; da instalação sai só um booleano.
 *  - **Organização de fonte confiável.** `orgId` vem do chamador, que o
 *    resolveu do cookie ou do token — nunca do corpo. Com o admin client (MCP,
 *    bearer) a RLS não se aplica, e por isso TODA consulta aqui filtra
 *    `organization_id` explicitamente.
 *  - **Auditoria é do chamador**, que sabe quem é o ator (usuário ou token).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { enxergaImagem } from "@/lib/ai/pontos/capacidade-em-vigor";
import {
  conferirNaListaViva,
  estadoDosProvedores,
  modelosVivos,
  type CredencialSegura,
  type EstadoDoProvedor,
  type ModeloVivo,
} from "@/lib/ai/pontos/modelos-vivos";
import { IDS_DE_PROVEDOR, PROVEDOR_POR_ID, ehProvedorSuportado } from "@/lib/ai/pontos/provedores";
import { PONTO_POR_ID } from "@/lib/ai/pontos/registro";
import { validarBinding } from "@/lib/ai/pontos/validar-binding";

import { conferirEnderecoProprio, type ResolvedorSeguro } from "./endereco-proprio";

type Db = SupabaseClient;

/** O que a instalação tem — só booleanos, nunca o valor de uma variável. */
export interface AmbienteDeIa {
  chavesDeProvedor: Readonly<Record<string, boolean>>;
  gateway: boolean;
}

export type Falha = { ok: false; codigo: string; mensagem: string; status: number };

const COLUNAS_SEGURAS =
  "id, provider, label, api_key_last4, base_url, validated_at, validation_error, models_available, models_tools, is_active";

export async function lerCredenciaisSeguras(db: Db, orgId: string): Promise<CredencialSegura[]> {
  const { data } = await db
    .from("ai_provider_credentials_safe")
    .select(COLUNAS_SEGURAS)
    .eq("organization_id", orgId)
    .eq("is_active", true);
  return (data ?? []) as CredencialSegura[];
}

export async function provedoresConectados(
  db: Db,
  orgId: string,
  ambiente: AmbienteDeIa,
): Promise<{ provedores: EstadoDoProvedor[]; gatewayDaInstalacao: boolean }> {
  const credenciais = await lerCredenciaisSeguras(db, orgId);
  return {
    provedores: estadoDosProvedores({
      provedores: IDS_DE_PROVEDOR,
      credenciais,
      chavesDaInstalacao: ambiente.chavesDeProvedor,
    }),
    gatewayDaInstalacao: ambiente.gateway,
  };
}

/**
 * Completa a capacidade de ferramentas que o provedor não informou, com o
 * catálogo `ai_models` (o que o fabricante declara). Modelo que nem o provedor
 * nem o catálogo conhecem fica `null`: "não sabemos", e a escrita avisa.
 */
async function completarComCatalogo(
  db: Db,
  provider: string,
  modelos: ModeloVivo[],
): Promise<ModeloVivo[]> {
  const faltando = modelos.filter((m) => m.supports_tools === null).map((m) => m.model_id);
  if (faltando.length === 0) return modelos;
  const { data } = await db
    .from("ai_models")
    .select("model_id, supports_tools")
    .eq("provider", provider)
    .in("model_id", faltando)
    .is("deprecated_at", null);
  const doCatalogo = new Map(
    ((data ?? []) as { model_id: string; supports_tools: boolean }[]).map((m) => [
      m.model_id,
      m.supports_tools,
    ]),
  );
  return modelos.map((m) =>
    m.supports_tools === null && doCatalogo.has(m.model_id)
      ? { ...m, supports_tools: doCatalogo.get(m.model_id)! }
      : m,
  );
}

export interface ModelosDaCredencial {
  credential_id: string;
  label: string;
  api_key_last4: string | null;
  /** O endereço do servidor — só no Ollama; nunca é segredo. */
  base_url: string | null;
  conectada: boolean;
  /** De quando é a lista (o último teste bem-sucedido da chave). */
  lista_atualizada_em: string | null;
  modelos: ModeloVivo[];
}

/**
 * Os modelos ao vivo de um provedor, por credencial conectada.
 *
 * Com `purpose` de um ponto que exige ferramentas, só sobra quem as tem ou
 * quem ninguém sabe dizer (o aviso de "não verificado" sai na escrita) — o que
 * o provedor ou o catálogo AFIRMAM não ter ferramentas não aparece.
 */
export async function modelosAoVivo(
  db: Db,
  orgId: string,
  entrada: { provider: string; purpose?: string | null; credentialId?: string | null },
): Promise<{ ok: true; exigeFerramentas: boolean; credenciais: ModelosDaCredencial[] } | Falha> {
  if (!ehProvedorSuportado(entrada.provider)) {
    return { ok: false, codigo: "provedor_desconhecido", mensagem: "Provedor desconhecido.", status: 404 };
  }
  let exigeFerramentas = false;
  if (entrada.purpose) {
    const ponto = PONTO_POR_ID.get(entrada.purpose);
    if (!ponto) {
      return {
        ok: false,
        codigo: "ponto_desconhecido",
        mensagem: `"${entrada.purpose}" não é um ponto do sistema.`,
        status: 404,
      };
    }
    exigeFerramentas = ponto.exige.tools === true;
  }

  const todas = (await lerCredenciaisSeguras(db, orgId)).filter(
    (c) =>
      c.provider === entrada.provider &&
      (entrada.credentialId ? c.id === entrada.credentialId : true),
  );

  const credenciais: ModelosDaCredencial[] = [];
  for (const c of todas) {
    let modelos = await completarComCatalogo(db, c.provider, modelosVivos(c));
    if (exigeFerramentas) modelos = modelos.filter((m) => m.supports_tools !== false);
    credenciais.push({
      credential_id: c.id,
      label: c.label,
      api_key_last4: c.api_key_last4,
      base_url: c.base_url ?? null,
      conectada: c.validated_at !== null,
      lista_atualizada_em: c.validated_at,
      modelos,
    });
  }
  return { ok: true, exigeFerramentas, credenciais };
}

/** O corpo de "definir o modelo de um ponto" — o mesmo na tela, na API e no MCP. */
export const FORMA_DO_PONTO = {
  purpose: z.string().min(1).max(100),
  // A migration 0127 removeu os CHECKs do banco; quem recusa provedor
  // desconhecido na escrita é esta lista.
  provider: z
    .string()
    .min(1)
    .refine(ehProvedorSuportado, {
      message:
        "provedor não suportado por esta instalação — escolha um da lista em Agente de IA → Provedores",
    }),
  model_id: z.string().min(1).max(200),
  credential_id: z.string().uuid().nullable().optional(),
  base_url: z.string().url().nullable().optional(),
  is_enabled: z.boolean().optional(),
};
export const corpoDoPonto = z.object(FORMA_DO_PONTO);
export type CorpoDoPonto = z.infer<typeof corpoDoPonto>;

export interface BindingGravado {
  id: string;
  purpose: string;
  provider: string;
  model_id: string;
  credential_id: string | null;
  base_url: string | null;
  is_enabled: boolean;
}

/** Quem está gravando: a tela (sessão de admin) ou um agente (bearer, MCP). */
export interface OpcoesDaEscrita {
  origem: "sessao" | "agente";
  /** Resolução de DNS do endereço próprio; injetável para teste. */
  resolver?: ResolvedorSeguro;
}

/**
 * Valida e grava a escolha de um ponto. Recusa (422) o incompatível: ponto
 * fixo, modelo sem ferramentas onde elas são exigidas, chave de outro
 * provedor, chave que não passou no teste, modelo fora da lista viva da chave,
 * ponto sem chave nenhuma e endereço próprio fora da regra
 * (`./endereco-proprio.ts`).
 *
 * A conferência de modelo (catálogo e lista viva) só roda quando o PROVEDOR,
 * o MODELO ou a CHAVE mudam em relação ao que está gravado. Desligar,
 * religar ou salvar de novo o mesmo modelo nunca dá 422: a lista da chave
 * pode ter mudado depois de salvo, e recusar ali travaria quem só quer pausar
 * o ponto. Quem muda o modelo passa pela conferência inteira.
 */
export async function definirModeloDoPonto(
  db: Db,
  orgId: string,
  corpo: CorpoDoPonto,
  ambiente: AmbienteDeIa,
  opcoes: OpcoesDaEscrita,
): Promise<{ ok: true; binding: BindingGravado; avisos: string[] } | Falha> {
  const ponto = PONTO_POR_ID.get(corpo.purpose);
  if (!ponto) {
    return {
      ok: false,
      codigo: "ponto_desconhecido",
      mensagem: `"${corpo.purpose}" não é um ponto do sistema`,
      status: 404,
    };
  }

  // O que está gravado HOJE nesta organização (filtro explícito: com o admin
  // client a RLS não vale).
  const { data: atual } = await db
    .from("ai_purpose_bindings")
    .select("provider, model_id, credential_id, base_url, is_enabled")
    .eq("organization_id", orgId)
    .eq("purpose", corpo.purpose)
    .maybeSingle();
  const gravado = atual as
    | { provider: string; model_id: string; credential_id: string | null; base_url: string | null }
    | null;
  const mudou =
    gravado === null ||
    gravado.provider !== corpo.provider ||
    gravado.model_id !== corpo.model_id ||
    (gravado.credential_id ?? null) !== (corpo.credential_id ?? null);

  // ---- endereço próprio: é para onde a chave vai (ver ./endereco-proprio.ts) ----
  const pedido = corpo.base_url?.trim() ? corpo.base_url.trim() : null;
  let baseUrl: string | null;
  if (opcoes.origem === "agente") {
    if (pedido !== null) {
      return {
        ok: false,
        codigo: "endereco_proprio_so_pela_tela",
        mensagem:
          "O endereço próprio só pode ser definido na tela de Provedores, por uma pessoa com papel admin: é para ele " +
          "que a chave do provedor é enviada. Omita `base_url`.",
        status: 422,
      };
    }
    // Omitido: fica o que o admin gravou pela tela, se o provedor é o mesmo.
    baseUrl = gravado !== null && gravado.provider === corpo.provider ? gravado.base_url : null;
  } else {
    baseUrl = pedido;
  }
  if (baseUrl !== null) {
    if (PROVEDOR_POR_ID.get(corpo.provider)?.aceitaEndpointProprio !== true) {
      return {
        ok: false,
        codigo: "provedor_sem_endereco_proprio",
        mensagem:
          corpo.provider === "ollama"
            ? "O endereço do Ollama é da conexão (Credenciais), não do ponto. Deixe o campo em branco e escolha a conexão."
            : `${corpo.provider} não aceita endereço próprio. Deixe o campo em branco.`,
        status: 422,
      };
    }
    if (mudou || baseUrl !== (gravado?.base_url ?? null)) {
      const endereco = await conferirEnderecoProprio(baseUrl, opcoes.resolver);
      if (!endereco.ok) {
        return { ok: false, codigo: "endereco_proprio_inseguro", mensagem: endereco.mensagem, status: 422 };
      }
    }
  }

  // A credencial precisa ser DESTA organização (filtro explícito: com o admin
  // client a RLS não vale) e do MESMO provedor do ponto.
  let credencial: CredencialSegura | null = null;
  if (corpo.credential_id) {
    const { data } = await db
      .from("ai_provider_credentials_safe")
      .select(COLUNAS_SEGURAS)
      .eq("id", corpo.credential_id)
      .eq("organization_id", orgId)
      .maybeSingle();
    if (!data) {
      return {
        ok: false,
        codigo: "credencial_invalida",
        mensagem: "chave não encontrada nesta organização",
        status: 422,
      };
    }
    credencial = data as CredencialSegura;
    if (credencial.provider !== corpo.provider) {
      return {
        ok: false,
        codigo: "credencial_de_outro_provedor",
        mensagem:
          `a chave escolhida é de ${credencial.provider}, mas o ponto foi configurado para ${corpo.provider}. ` +
          `Modelo e chave precisam ser do mesmo provedor, senão a chamada é recusada pelo endpoint.`,
        status: 422,
      };
    }
    if (mudou && !credencial.is_active) {
      return {
        ok: false,
        codigo: "credencial_invalida",
        mensagem: "a chave escolhida está desativada",
        status: 422,
      };
    }
  }

  const avisos: string[] = [];
  if (mudou) {
    const conferencia = await conferirModelo(db, corpo, credencial, ponto.exige.tools === true, baseUrl, ambiente);
    if (!conferencia.ok) return conferencia;
    avisos.push(...conferencia.avisos);
    if (baseUrl !== null) {
      avisos.push(
        `Com endereço próprio, "${corpo.model_id}" não foi conferido na lista da chave: quem responde é o seu ` +
          `gateway. Teste a conexão antes de confiar.`,
      );
    }
  }

  const { data: salvo, error } = await db
    .from("ai_purpose_bindings")
    .upsert(
      {
        organization_id: orgId,
        purpose: corpo.purpose,
        provider: corpo.provider,
        model_id: corpo.model_id,
        credential_id: corpo.credential_id ?? null,
        base_url: baseUrl,
        is_enabled: corpo.is_enabled ?? true,
      },
      { onConflict: "organization_id,purpose" },
    )
    .select("id, purpose, provider, model_id, credential_id, base_url, is_enabled")
    .maybeSingle();

  if (error) return { ok: false, codigo: "save_failed", mensagem: error.message, status: 500 };
  if (!salvo) {
    // Upsert que casa zero linhas devolve sucesso no PostgREST — a tela diria
    // "salvo" sem nada ter sido gravado.
    return {
      ok: false,
      codigo: "save_failed",
      mensagem: "nada foi gravado — verifique as permissões da organização",
      status: 500,
    };
  }
  return { ok: true, binding: salvo as BindingGravado, avisos };
}

/**
 * O modelo serve para o ponto? Catálogo (`validarBinding`) e lista viva da
 * chave (`conferirNaListaViva`). Com endereço próprio a lista oficial não vale
 * (o gateway do operador serve os modelos dele), mas só se chega aqui com
 * base_url depois de ele passar pela regra de `./endereco-proprio.ts`: sessão
 * de admin, provedor compatível, https público e chave conectada.
 */
async function conferirModelo(
  db: Db,
  corpo: CorpoDoPonto,
  credencial: CredencialSegura | null,
  exigeFerramentas: boolean,
  baseUrl: string | null,
  ambiente: AmbienteDeIa,
): Promise<{ ok: true; avisos: string[] } | Falha> {
  // Capacidade: o que o PROVEDOR informou para esta chave vale primeiro (é
  // dado da conta); senão, o catálogo `ai_models`. Nunca heurística sobre nome.
  const daChave =
    credencial?.models_tools != null
      ? new Set(credencial.models_tools).has(corpo.model_id)
      : null;
  const { data: modelo } = await db
    .from("ai_models")
    .select("model_id, supports_tools, supports_vision")
    .eq("provider", corpo.provider)
    .eq("model_id", corpo.model_id)
    .is("deprecated_at", null)
    .maybeSingle();
  const doCatalogo = modelo as
    | { model_id: string; supports_tools: boolean; supports_vision: boolean }
    | null;

  const validacao = validarBinding({
    pontoId: corpo.purpose,
    modelo: {
      model_id: corpo.model_id,
      supports_tools: daChave ?? doCatalogo?.supports_tools ?? false,
      supports_vision: enxergaImagem({
        provider: corpo.provider,
        modelId: corpo.model_id,
        doCatalogo: doCatalogo?.supports_vision ?? null,
      }),
      conhecido: daChave !== null || doCatalogo !== null,
    },
  });
  if (!validacao.ok) {
    return { ok: false, codigo: validacao.codigo, mensagem: validacao.mensagem, status: 422 };
  }

  const conferencia = conferirNaListaViva({
    provider: corpo.provider,
    modelId: corpo.model_id,
    exigeFerramentas,
    baseUrl,
    credencial,
    daInstalacao: ambiente.chavesDeProvedor[corpo.provider] === true,
  });
  if (!conferencia.ok) {
    return { ok: false, codigo: conferencia.codigo, mensagem: conferencia.mensagem, status: 422 };
  }

  return { ok: true, avisos: validacao.avisos };
}
