import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET/PUT /api/v1/ai/providers — a configuração de IA de cada ponto do sistema.
 *
 * GET devolve, para a organização ativa: os pontos (de `lib/ai/pontos/registro`),
 * o que está valendo em cada um HOJE e POR QUÊ (a origem da escolha), as
 * credenciais cadastradas e os modelos que a organização consegue de fato usar.
 *
 * PUT grava a escolha de um ponto — e RECUSA a incompatível. A recusa acontece
 * aqui, na escrita, e não na hora da chamada: aqui existe alguém olhando a tela
 * para ler o motivo e corrigir; lá existe um cliente esperando resposta, e
 * recusar naquele instante trocaria uma configuração ruim por um atendimento
 * perdido.
 */
import { enxergaImagem } from "@/lib/ai/pontos/capacidade-em-vigor";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { roleAtLeast } from "@/lib/auth/types";
import {
  decidirBinding,
  EXPLICACAO_DA_ORIGEM,
  PONTOS_DO_AGENTE_PUBLICADO,
  PONTOS_QUE_HERDAM_DO_AGENTE,
  type LinhaDeBinding,
} from "@/lib/ai/pontos/resolver";
import { PAPEIS, PONTOS_DE_IA } from "@/lib/ai/pontos/registro";
import { PROVEDORES } from "@/lib/ai/pontos/provedores";
import { estadoDosProvedores, modelosVivos, pontoConectado } from "@/lib/ai/pontos/modelos-vivos";
import { listaDaInstalacao } from "@/lib/ai/provedores/lista-da-instalacao";
import {
  corpoDoPonto,
  definirModeloDoPonto,
  lerCredenciaisSeguras,
} from "@/lib/ai/provedores/operacoes";
import { lerAmbiente } from "@/lib/instalacao/ambiente";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

interface ModeloDoCatalogo {
  provider: string;
  model_id: string;
  display_name: string;
  supports_tools: boolean;
  supports_vision: boolean;
  input_price_per_million_cents: number | null;
  output_price_per_million_cents: number | null;
  context_window: number | null;
}

export async function GET(): Promise<Response> {
  const authz = await requireRole("manager", { resource: "ai_providers" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org } = authz;

  const db = await createClient();

  const [bindingsRes, credenciaisSeguras, modelosRes, orgRes, agenteRes] = await Promise.all([
    db
      .from("ai_purpose_bindings")
      .select("purpose, provider, credential_id, model_id, base_url, is_enabled")
      .eq("organization_id", org.orgId),
    // Pela view segura: ela não tem as colunas do segredo.
    lerCredenciaisSeguras(db, org.orgId),
    db
      .from("ai_models")
      .select(
        "provider, model_id, display_name, supports_tools, supports_vision, input_price_per_million_cents, output_price_per_million_cents, context_window",
      )
      .is("deprecated_at", null)
      .order("provider")
      .order("display_name"),
    db.from("organizations").select("settings").eq("id", org.orgId).maybeSingle(),
    db
      .from("ai_agents")
      .select(
        "id, name, published_version_id, versao:ai_agent_versions!ai_agents_published_version_id_fkey(provider, model, credential_id)",
      )
      .eq("organization_id", org.orgId)
      .is("archived_at", null)
      .not("published_version_id", "is", null)
      .limit(1)
      .maybeSingle(),
  ]);

  const bindings = new Map<string, LinhaDeBinding>(
    ((bindingsRes.data ?? []) as LinhaDeBinding[]).map((b) => [b.purpose, b]),
  );

  const llm = ((orgRes.data?.settings as { llm?: Record<string, unknown> } | null)?.llm ??
    {}) as { provider?: string; default_model?: string | null };
  const padraoDaOrganizacao = {
    provider: typeof llm.provider === "string" ? llm.provider : "anthropic",
    defaultModel: typeof llm.default_model === "string" ? llm.default_model : null,
  };

  const versao = (agenteRes.data as { versao?: { provider: string; model: string; credential_id: string | null } } | null)
    ?.versao;
  const agentePublicado = versao
    ? { provider: versao.provider, credentialId: versao.credential_id, model: versao.model }
    : null;

  // ⚠️ A LISTA QUE A TELA DESENHA sai daqui, e `supports_vision` dela vinha da
  // coluna — a mesma que discordava do motor. Reconciliar aqui, uma vez, é o
  // que faz a lista, o aviso do binding e o motor darem a MESMA resposta.
  // Ver `lib/ai/pontos/capacidade-em-vigor.ts`.
  const modelos = ((modelosRes.data ?? []) as ModeloDoCatalogo[]).map((m) => ({
    ...m,
    supports_vision: enxergaImagem({
      provider: m.provider,
      modelId: m.model_id,
      doCatalogo: m.supports_vision,
    }),
  }));
  const capacidadePorModelo = new Map(modelos.map((m) => [`${m.provider}|${m.model_id}`, m]));

  // Da instalação sai SÓ o booleano de cada provedor, nunca o valor.
  const ambiente = lerAmbiente();

  const pontos = PONTOS_DE_IA.map((ponto) => {
    const decisao = decidirBinding({
      pontoId: ponto.id,
      binding: bindings.get(ponto.id) ?? null,
      // Só os pontos que de fato consomem o agente. Em runtime quem sinaliza a
      // herança é a PRESENÇA do `llmOverride`, e esta tela não tem esse sinal:
      // passar o agente para todo ponto faria a coluna "está usando" anunciar o
      // modelo do agente em ponto que nunca o herda — a mesma tela que mente,
      // virada do avesso.
      agentePublicado:
        PONTOS_DO_AGENTE_PUBLICADO.has(ponto.id) || PONTOS_QUE_HERDAM_DO_AGENTE.has(ponto.id)
          ? agentePublicado
          : null,
      // DÍVIDA, não impossibilidade. A justificativa aqui dizia "o servidor web
      // não enxerga o env do worker", e isso é falso: `docker-compose.yml`
      // dá o MESMO `env_file: .env` ao serviço `app` e ao `worker`. O que de
      // fato só existe do lado do worker são os knobs de NOME DE MODELO
      // (STAGE_CLASSIFIER_MODEL e irmãos), declarados apenas no schema Zod de
      // `lib/agent-engine/env.ts` — `process.env` os lê normalmente aqui, como
      // `lib/instalacao/ambiente.ts` já faz para as chaves.
      // Enquanto ficar `undefined`, a origem "veio da instalação" nunca aparece
      // nesta tela, mesmo quando é ela que vale em runtime.
      modeloDeAmbiente: undefined,
      padraoDaOrganizacao,
    });
    const chave = `${decisao.provider}|${decisao.modelId ?? ""}`;
    const capacidade = capacidadePorModelo.get(chave);
    return {
      id: ponto.id,
      rotulo: ponto.rotulo,
      oQueFaz: ponto.oQueFaz,
      papel: ponto.papel,
      exige: ponto.exige,
      sintomaDeFalha: ponto.sintomaDeFalha,
      fixo: ponto.fixo ?? null,
      /**
       * Escolha do agente publicado — a tela mostra como leitura, com link.
       *
       * Depende de EXISTIR versão publicada: é a mesma condição que o resolvedor
       * usa (`resolver.ts` exige `agentePublicado !== null`). Sem o `&&`, uma
       * instalação recém-feita — nenhum agente publicado ainda — abria o painel
       * com os DOIS pontos que respondem o cliente sem seletor, dizendo que são
       * governados por uma versão publicada que não existe e mandando
       * configurar num lugar vazio. É a primeira tela da feature; travá-la no
       * primeiro uso é o pior lugar para esse defeito estar.
       */
      mandadoPeloAgente: agentePublicado !== null && PONTOS_DO_AGENTE_PUBLICADO.has(ponto.id),
      efetivo: {
        provider: decisao.provider,
        modelId: decisao.modelId,
        credentialId: decisao.credentialId,
        baseUrl: decisao.baseUrl,
        origem: decisao.origem,
        porQue: EXPLICACAO_DA_ORIGEM[decisao.origem],
        /**
         * O provedor efetivo tem chave de verdade (credencial validada ou a
         * chave DELE no ambiente)? Sem isto a tela dizia "usando
         * claude-sonnet-5" para um provedor sem chave nenhuma — o modelo
         * fictício. Só exibição: o runtime e os dados não mudam.
         */
        conectado: pontoConectado({
          provider: decisao.provider,
          credentialId: decisao.credentialId,
          credenciais: credenciaisSeguras,
          chavesDaInstalacao: ambiente.chavesDeProvedor,
        }),
      },
      avisos: [
        ...decisao.avisos,
        // O aviso de capacidade é recalculado aqui porque só o servidor tem o
        // catálogo; o resolvedor puro não consulta banco.
        ...(capacidade && ponto.exige.tools === true && !capacidade.supports_tools
          ? [
              t(`O modelo em uso não sabe usar as ferramentas do CRM — o agente conversa, mas não registra nada no funil.`),
            ]
          : []),
      ],
    };
  });

  // A LISTA VIVA: o que cada chave testada libera, só modelos de conversa
  // (`lib/ai/pontos/modelos-vivos.ts`). Ferramentas: o que o provedor informou
  // para a chave; senão, o catálogo. A tela usa ESTA lista no seletor — o
  // catálogo `modelos` acima fica só para a chave da instalação.
  const credenciais = credenciaisSeguras.map((c) => ({
    id: c.id,
    provider: c.provider,
    label: c.label,
    api_key_last4: c.api_key_last4,
    // Só o Ollama (modelo local) tem endereço; nunca é segredo.
    base_url: c.base_url ?? null,
    validated_at: c.validated_at,
    validation_error: c.validation_error,
    conectada: c.validated_at !== null,
    modelos: modelosVivos(c).map((m) => ({
      model_id: m.model_id,
      supports_tools:
        m.supports_tools ?? capacidadePorModelo.get(`${c.provider}|${m.model_id}`)?.supports_tools ?? null,
    })),
  }));

  // A lista VIVA de quem tem chave no ambiente, perguntada ao provedor pelo
  // servidor (cache de 1 h). A chave fica aqui dentro; sai só a lista.
  const comChave = PROVEDORES.map((p) => p.id).filter((id) => ambiente.chavesDeProvedor[id] === true);
  const listasDaInstalacao = Object.fromEntries(
    await Promise.all(comChave.map(async (id) => [id, await listaDaInstalacao(id)] as const)),
  );

  return ok({
    papeis: PAPEIS,
    pontos,
    provedores: PROVEDORES,
    conexoes: estadoDosProvedores({
      provedores: PROVEDORES.map((p) => p.id),
      credenciais: credenciaisSeguras,
      chavesDaInstalacao: ambiente.chavesDeProvedor,
    }),
    gatewayDaInstalacao: ambiente.gateway,
    listasDaInstalacao,
    credenciais,
    modelos,
    podeEditar: roleAtLeast(org.role, "admin"),
  });
}

export async function PUT(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const authz = await requireRole("admin", { resource: "ai_providers" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org } = authz;

  // O corpo e a regra são os MESMOS da API para agentes e do MCP
  // (`lib/ai/provedores/operacoes.ts`): recusa provedor fora da lista, modelo
  // incompatível com o ponto, chave de outro provedor ou de outra organização,
  // e — desde a lista viva — modelo que a chave escolhida não libera (422).
  const parsed = corpoDoPonto.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("invalid_body", t("corpo inválido"), 422, { details: parsed.error.issues });
  }
  const corpo = parsed.data;

  const db = await createClient();
  const resultado = await definirModeloDoPonto(db, org.orgId, corpo, lerAmbiente(), {
    origem: "sessao",
  });
  if (!resultado.ok) return fail(resultado.codigo, t(resultado.mensagem), resultado.status);
  const gravado = resultado.binding;

  void audit({
    action: "ai.purpose_binding_updated",
    organizationId: org.orgId,
    actorUserId: user.id,
    resourceType: "ai_purpose_binding",
    // O ID DA LINHA, não o `purpose`. `api_audit_log.resource_id` é **uuid**, e
    // `purpose` é texto (`stage_classifier`): o INSERT falhava com 22P02
    // (`invalid input syntax for type uuid`) e — como o audit é
    // fire-and-forget — o erro ia só para o log do servidor. Resultado: NENHUMA
    // troca de modelo era auditada, num painel cujo efeito é justamente mudar
    // para onde o dinheiro e os dados do cliente vão. Achado dirigindo a tela;
    // nenhum gate via, porque nada assertava a linha de auditoria.
    resourceId: (gravado as { id?: string }).id ?? null,
    // O modelo entra no metadata, a credencial NÃO — só o id dela seria
    // inócuo, mas o hábito de mandar campo de credencial para o audit é o que
    // acaba vazando a chave quando alguém troca o campo de lugar.
    metadata: {
      purpose: corpo.purpose,
      provider: corpo.provider,
      model_id: corpo.model_id,
      tem_endpoint_proprio: Boolean(corpo.base_url),
    },
  });

  return ok({ binding: gravado, avisos: resultado.avisos });
}
