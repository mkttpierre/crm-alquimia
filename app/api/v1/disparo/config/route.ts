/**
 * /api/v1/disparo/config — o motor de disparo da organização ativa, editável pela tela.
 *
 *   GET   (manager+) o que a tela edita: ritmo vigente (com os padrões), cadência, etapa de origem, mensagens,
 *         proibidos, modo, o perfil que o ritmo segue e o recomendado de cada campo (`RITMO_PADRAO`).
 *   POST  (manager+) cria o motor: ritmo vazio (= `RITMO_PADRAO` na leitura), modo simulado, desligado. Idempotente: 201 quando cria, 200
 *         quando já existe (inclusive quando outra requisição o criou no meio, `23505`).
 *   PATCH (manager+; `modo` só admin) edita qualquer parte: `ligado`, `teto_diario`, `ritmo` parcial, `perfil`,
 *         `cadencia`, `fonte_stage_id`, `modelos`, `proibidos`, `modo`. O corpo é `.strict()`
 *         (`lib/disparo-painel/esquemas.ts`): `organization_id` vira 422.
 *
 * O corpo do PATCH (validação com `details.campos`, etapa de origem, imagem da abertura, mescla profunda do ritmo,
 * gravação e auditoria) mora em `editarConfigDoMotor` (`lib/disparo-painel/operacoes.ts`): o MCP dos agentes externos
 * passa pelo MESMO caminho. A rota só acrescenta o `requireRole("admin")` quando há `modo`.
 *
 * Trocar `modo` para `real` NÃO libera o envio: ele segue exigindo `DISPARO_REAL_LIBERADO=sim` no servidor
 * (`lib/disparo/trava.ts`), e nenhuma rota toca nessa variável.
 *
 * `disparo_config` não dá INSERT/UPDATE a `authenticated` (migration 0234: ninguém troca o modo pelo PostgREST com o
 * próprio JWT). A escrita usa o admin client, com o `organization_id` vindo da sessão validada (`requireRole`), nunca
 * do corpo. Toda gravação audita `disparo.config_atualizada` com o antes e o depois SÓ do que mudou; pedido que não
 * muda nada não grava nem audita.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { CADENCIA_PADRAO } from "@/lib/disparo/cadencia";
import { lerRitmo, RITMO_PADRAO } from "@/lib/disparo/config";
import { perfilDoRitmo } from "@/lib/disparo/perfis";
import { edicaoDaConfigSchema, type EtapaDaTela, papelNecessario } from "@/lib/disparo-painel/esquemas";
import { editarConfigDoMotor } from "@/lib/disparo-painel/operacoes";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const COLUNAS = "ligado, modo, teto_diario, cadencia, fonte_stage_id, ritmo, modelos, proibidos";

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "disparo_config" });
  if (!authz.ok) return authz.response;
  const { org, user } = authz;
  const t = (texto: string) => traduzir(texto, user.idioma);

  const supabase = await createClient();
  const { data: config, error } = await supabase.from("disparo_config").select(COLUNAS).eq("organization_id", org.orgId).maybeSingle();
  if (error) return fail("internal_error", t("Não foi possível ler a configuração do motor."), 500, { requestId });
  if (!config) return ok({ existe: false, recomendado: RITMO_PADRAO }, { requestId });

  // As etapas ativas da organização (para escolher de onde vêm os leads) e quantos leads há na escolhida.
  const [{ data: funis, error: erroFunis }, { data: etapas, error: erroEtapas }, contagem] = await Promise.all([
    supabase.from("crm_pipelines").select("id, name, position").eq("organization_id", org.orgId).eq("is_archived", false),
    supabase
      .from("crm_stages")
      .select("id, name, pipeline_id, position")
      .eq("organization_id", org.orgId)
      .eq("is_archived", false)
      .order("position", { ascending: true }),
    config.fonte_stage_id
      ? supabase
          .from("crm_leads")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", org.orgId)
          .eq("stage_id", config.fonte_stage_id)
      : Promise.resolve({ count: null, error: null }),
  ]);
  if (erroFunis || erroEtapas || contagem.error) {
    return fail("internal_error", t("Não foi possível ler a configuração do motor."), 500, { requestId });
  }
  const nomeDoFunil = new Map((funis ?? []).map((f) => [f.id, { nome: f.name, posicao: f.position }]));
  const etapasDaTela: EtapaDaTela[] = (etapas ?? [])
    .filter((e) => nomeDoFunil.has(e.pipeline_id))
    .sort((a, b) => nomeDoFunil.get(a.pipeline_id)!.posicao - nomeDoFunil.get(b.pipeline_id)!.posicao || a.position - b.position)
    .map((e) => ({ id: e.id, nome: e.name, funil_id: e.pipeline_id, funil: nomeDoFunil.get(e.pipeline_id)!.nome }));

  // A etapa escolhida saiu da lista (arquivada ou funil arquivado): a tela a mostra desabilitada, com o nome.
  let etapaArquivada: { id: string; nome: string } | null = null;
  if (config.fonte_stage_id && !etapasDaTela.some((e) => e.id === config.fonte_stage_id)) {
    const { data: antiga } = await supabase
      .from("crm_stages")
      .select("id, name")
      .eq("id", config.fonte_stage_id)
      .eq("organization_id", org.orgId)
      .maybeSingle();
    if (antiga) etapaArquivada = { id: antiga.id, nome: antiga.name };
  }

  const ritmo = lerRitmo(config.ritmo);
  return ok(
    {
      existe: true,
      etapas: etapasDaTela,
      etapa_arquivada: etapaArquivada,
      leads_na_etapa: contagem.count ?? null,
      ligado: config.ligado,
      modo: config.modo === "real" ? "real" : "simulado",
      teto_diario: config.teto_diario,
      cadencia: config.cadencia,
      fonte_stage_id: config.fonte_stage_id,
      ritmo,
      perfil: perfilDoRitmo(ritmo),
      modelos: config.modelos,
      proibidos: config.proibidos,
      recomendado: RITMO_PADRAO,
    },
    { requestId },
  );
}

export async function POST(_req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "disparo_config" });
  if (!authz.ok) return authz.response;
  const { org, user } = authz;
  const t = (texto: string) => traduzir(texto, user.idioma);

  const supabase = await createClient();
  const { data: existente, error: erroLeitura } = await supabase
    .from("disparo_config")
    .select("organization_id")
    .eq("organization_id", org.orgId)
    .maybeSingle();
  if (erroLeitura) return fail("internal_error", t("Não foi possível criar o motor."), 500, { requestId });
  if (existente) return ok({ criada: false }, { requestId });

  // Nasce seguro: simulado (nada sai) e desligado. O ritmo nasce VAZIO: `lerRitmo` o lê como `RITMO_PADRAO`, e o
  // padrão de amanhã (feriados do ano que vem, um freio novo) chega sozinho. Gravar a cópia de hoje o congelaria.
  const nova = { organization_id: org.orgId, ligado: false, modo: "simulado", cadencia: CADENCIA_PADRAO, ritmo: {} };
  const { error } = await createAdminClient().from("disparo_config").insert(nova);
  if (error) {
    // Outra requisição criou no meio: o motor existe, que é o que foi pedido.
    if ((error as { code?: string }).code === "23505") return ok({ criada: false }, { requestId });
    return fail("internal_error", t("Não foi possível criar o motor."), 500, { requestId });
  }

  await audit({
    organizationId: org.orgId,
    actorUserId: user.id,
    action: "disparo.config_atualizada",
    resourceType: "disparo_config",
    resourceId: org.orgId,
    requestId,
    metadata: { operacao: "criar", antes: null, depois: { ligado: false, modo: "simulado", cadencia: CADENCIA_PADRAO, ritmo: "padrão" } },
  });
  return ok({ criada: true }, { requestId, status: 201 });
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "disparo_config" });
  if (!authz.ok) return authz.response;
  const { org, user } = authz;
  const corpo: unknown = await req.json().catch(() => null);

  // Trocar o modo é do admin, e na TELA quem diz isso é `requireRole` — que emite `authz.denied`, a mensagem padrão e o
  // portão de MFA. O 403 sai antes de qualquer leitura ou escrita. (Corpo inválido segue e é recusado lá dentro.)
  const edicao = edicaoDaConfigSchema.safeParse(corpo);
  if (edicao.success && papelNecessario(edicao.data) === "admin") {
    const doAdmin = await requireRole("admin", { requestId, resource: "disparo_config" });
    if (!doAdmin.ok) return doAdmin.response;
  }

  // O corpo (validação, gravação, auditoria) mora em `editarConfigDoMotor`: o MCP dos agentes externos aplica a MESMA
  // edição, com a MESMA recusa (lib/disparo-painel/operacoes.ts), e lá a checagem do modo vale para o papel do token.
  const r = await editarConfigDoMotor(
    { leitura: await createClient(), escrita: createAdminClient() },
    {
      orgId: org.orgId,
      papel: org.role,
      corpo,
      autor: { actorUserId: user.id },
      requestId,
      idioma: user.idioma,
    },
  );
  if (!r.ok) return fail(r.codigo, r.mensagem, r.status, { requestId, ...(r.detalhes ? { details: r.detalhes } : {}) });
  return ok(r.dados, { requestId });
}
