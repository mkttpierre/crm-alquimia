/**
 * GET /api/v1/revenue?desde=AAAA-MM-DD&ate=AAAA-MM-DD&granularidade=dia|semana|mes&currency=BRL — faturamento (manager+).
 *
 * Negócios ganhos + pedidos pagos da loja no período, por dia/semana/mês, por produto, funil e atendente, com ticket médio,
 * a tabela das vendas e o resumo do período anterior de mesmo tamanho (para os cartões compararem).
 * A organização é a da sessão; o período é em dias civis do fuso da organização (padrão: últimos 30 dias).
 * Faturamento é número da empresa inteira (não há recorte por atendente), por isso manager+ — mesmo grau do Meta Ads.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { moedaDaOrganizacao } from "@/lib/catalogo/moeda-da-org";
import { calcularPainel, consultaSchema, diaCivil, janelaDeBusca, periodoAnterior, periodoPadrao } from "@/lib/negocio/faturamento";
import { nomesDosAtendentes } from "@/lib/negocio/nomes-dos-atendentes";
import { repositorioFaturamentoSupabase } from "@/lib/negocio/repositorio-faturamento";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const FUSO_PADRAO = "America/Sao_Paulo";
const LIMITE_DE_DIAS = 731;

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "revenue" });
  if (!authz.ok) return authz.response;

  const sp = new URL(req.url).searchParams;
  const parsed = consultaSchema.safeParse({
    desde: sp.get("desde") ?? undefined,
    ate: sp.get("ate") ?? undefined,
    granularidade: sp.get("granularidade") ?? undefined,
    currency: sp.get("currency") ?? undefined,
  });
  if (!parsed.success) {
    return fail("validation_failed", "Período inválido.", 422, { requestId, details: parsed.error.flatten().fieldErrors as Record<string, unknown> });
  }

  try {
    const supabase = await createClient();
    const repo = repositorioFaturamentoSupabase(supabase);
    // Sem moeda na consulta, o painel é na moeda da ORGANIZAÇÃO (a mesma de `catalog_products.moeda`), nunca em BRL fixo.
    const moeda = parsed.data.currency ?? (await moedaDaOrganizacao(supabase, authz.org.orgId));
    const timezone = (await repo.fuso(authz.org.orgId)) ?? FUSO_PADRAO;
    const padrao = periodoPadrao(diaCivil(new Date(), timezone));
    const desde = parsed.data.desde ?? padrao.desde;
    const ate = parsed.data.ate ?? padrao.ate;
    // O schema só confere o intervalo quando as duas datas vêm na consulta; com uma só, a outra é o padrão.
    const dias = (new Date(`${ate}T00:00:00Z`).getTime() - new Date(`${desde}T00:00:00Z`).getTime()) / 86_400_000;
    if (dias < 0) return fail("validation_failed", "A data inicial vem depois da final.", 422, { requestId });
    if (dias > LIMITE_DE_DIAS) return fail("validation_failed", "O período passa de 2 anos.", 422, { requestId });

    // A janela cobre o período E o anterior de mesmo tamanho: os cartões comparam um com o outro.
    const dados = await repo.carregar(authz.org.orgId, janelaDeBusca(periodoAnterior(desde, ate).desde, ate));
    const nomes = await nomesDosAtendentes(
      authz.org.orgId,
      dados.negocios.flatMap((n) => (n.owner_user_id ? [n.owner_user_id] : [])),
    );
    const resultado = calcularPainel({
      negocios: dados.negocios,
      pedidos: dados.pedidos,
      pipelines: dados.pipelines,
      moeda,
      timezone,
      desde,
      ate,
      granularidade: parsed.data.granularidade,
      nomesDosAtendentes: nomes,
      // Organização com produto interno (valor de comissão): o total conta só negócios ganhos; pedidos ficam "fora do total".
      somenteNegocios: dados.temProdutoInterno,
    });
    return ok({ ...resultado, timezone, truncado: dados.truncado }, { requestId });
  } catch {
    return fail("internal_error", "Erro ao calcular o faturamento.", 500, { requestId });
  }
}
