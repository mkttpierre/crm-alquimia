import { redirect } from "next/navigation";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { roleAtLeast } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";
import { carregarLeads, carregarPaginaDeLeads, LEADS_POR_PAGINA } from "@/lib/negocio/repositorio-leads";
import { selecionarLeads, type OrdemLead } from "@/lib/negocio/selecionar-leads";
import { TabelaLeads, type Paginacao } from "./tabela-leads";

export const dynamic = "force-dynamic";
const colunas: OrdemLead[] = ["tipo", "nome", "tags", "total", "compras", "ciclo", "ultima"];
export default async function LeadsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireAuth();
  const org = await resolveActiveOrg(user);
  if (!org) redirect("/app");
  const params = await searchParams;
  const ler = (k: string) => typeof params[k] === "string" ? params[k] as string : "";
  const ordem = colunas.includes(ler("ordem") as OrdemLead) ? ler("ordem") as OrdemLead : "nome";
  const direcao = ler("direcao") === "desc" ? "desc" : "asc";
  const filtros = { busca: ler("busca"), tag: ler("tag"), pipeline: ler("pipeline") };
  // Exportar é de gerente para cima e fora do modo suporte (ato do dono da conta); a rota recusa os outros de qualquer jeito.
  const podeExportar = roleAtLeast(org.role, "manager") && !user.support;
  const db = await createClient();

  // Visão padrão (ordem por nome, sem intervalo de compra): página de 50 pelo cursor,
  // tudo no banco. Ordenar ou filtrar pelo que é CALCULADO das compras (total,
  // compras, ciclo, última compra, datas) ou por coluna derivada (tipo, tags) exige
  // conhecer todos os contatos: esse caminho segue lendo a base, já com busca, tag
  // e funil filtrados no banco.
  if (ordem === "nome" && !ler("de") && !ler("ate")) {
    const anteriores = ler("anteriores") ? ler("anteriores").split(",") : [];
    const pagina = await carregarPaginaDeLeads(db, org.orgId, { ...filtros, direcao, cursor: ler("cursor") || undefined });
    const paginacao: Paginacao = { tipo: "cursor", atual: ler("cursor"), anteriores, proximo: pagina.proximo };
    return <TabelaLeads org={org.orgId} resultado={{ linhas: pagina.linhas, total: pagina.total }} paginacao={paginacao} pipelines={pagina.pipelines} tags={pagina.tags} podeExportar={podeExportar} />;
  }

  const numero = Math.max(1, Math.min(100000, Number.parseInt(ler("pagina"), 10) || 1));
  const dados = await carregarLeads(db, org.orgId, filtros);
  // A busca já foi ao banco; repetir em memória com outra regra cortaria quem o banco achou.
  const resultado = selecionarLeads(dados.linhas, { tag: filtros.tag, pipeline: filtros.pipeline, de: ler("de"), ate: ler("ate"), ordem, direcao, pagina: numero, limite: LEADS_POR_PAGINA });
  return <TabelaLeads org={org.orgId} resultado={resultado} paginacao={{ tipo: "pagina", pagina: numero, porPagina: LEADS_POR_PAGINA }} pipelines={dados.pipelines} tags={dados.tags} podeExportar={podeExportar} />;
}
