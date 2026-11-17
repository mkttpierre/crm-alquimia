/**
 * O QUE A VENDA VAI USAR, ANTES DE CONFIRMAR.
 *
 * "Registrar venda" é incremental: se o contato já tem um negócio aberto com linhas de produto, a venda ENTRA nesse negócio
 * e o total final é o que já estava mais o que se está lançando. Sem ver o que já está lá, o operador confirmaria um total
 * menor que o gravado. Este módulo responde, para o quadro: qual negócio será usado (pela MESMA função do banco que a
 * operação usa, `fn_escolher_negocio_da_venda`, só sem travar a linha), o que já está nele, em que moeda tudo se lança e
 * qual é o "hoje" da organização.
 *
 * Moeda: a do negócio usado; num negócio novo, a da organização. O seletor de produtos e o total do quadro usam só ela.
 * Cliente da SESSÃO: a RLS decide o que o usuário enxerga, e `organization_id` vem da sessão, nunca do corpo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { moedaDaOrganizacao } from "@/lib/catalogo/moeda-da-org";

import { diaCivil } from "./faturamento";
import { repositorioItensSupabase } from "./repositorio-itens";
import { somaDoNegocio } from "./totais";

export interface ItemJaNoNegocio {
  id: string;
  nome: string;
  quantidade: number;
  preco_unit_cents: number;
  desconto_cents: number;
  acrescimo_cents: number;
  total_cents: number;
  currency: string;
}

export interface AlvoDaVenda {
  /** O negócio aberto que a venda vai usar; `null` = a venda abrirá um novo. */
  negocio: { id: string; titulo: string } | null;
  moeda: string;
  /** O que já está no negócio (somente leitura no quadro). */
  itens: ItemJaNoNegocio[];
  /** Soma das linhas na moeda do negócio — o "já no negócio" do quadro. */
  ja_no_negocio_cents: number;
  timezone: string;
  /** Hoje (AAAA-MM-DD) no fuso da organização: padrão e limite do campo de data. */
  hoje: string;
}

const FUSO_PADRAO = "America/Sao_Paulo";

export async function lerAlvoDaVenda(
  db: SupabaseClient,
  orgId: string,
  alvo: { contactId?: string | null; leadId?: string | null },
  agora: Date = new Date(),
): Promise<AlvoDaVenda> {
  const { data: escolhido, error } = await db.rpc("fn_escolher_negocio_da_venda", {
    p_org: orgId,
    p_contact: alvo.contactId ?? null,
    p_lead: alvo.leadId ?? null,
    p_travar: false,
  });
  if (error) throw new Error(`escolher_negocio_falhou: ${error.message}`);

  const { data: org } = await db.from("organizations").select("timezone").eq("id", orgId).maybeSingle();
  const timezone = (org as { timezone?: string | null } | null)?.timezone || FUSO_PADRAO;
  const hoje = diaCivil(agora, timezone);

  const leadId = (escolhido as string | null) ?? null;
  if (!leadId) {
    return { negocio: null, moeda: await moedaDaOrganizacao(db, orgId), itens: [], ja_no_negocio_cents: 0, timezone, hoje };
  }

  const { data: lead, error: leadErr } = await db.from("crm_leads").select("id, title, currency").eq("organization_id", orgId).eq("id", leadId).maybeSingle();
  if (leadErr) throw new Error(`ler_negocio_falhou: ${leadErr.message}`);
  const negocio = lead as { id: string; title: string | null; currency: string | null } | null;
  // A RLS escondeu o negócio entre a escolha e a leitura: trata como "sem negócio" (a venda abriria um novo).
  if (!negocio) return { negocio: null, moeda: await moedaDaOrganizacao(db, orgId), itens: [], ja_no_negocio_cents: 0, timezone, hoje };

  const moeda = negocio.currency ?? (await moedaDaOrganizacao(db, orgId));
  const itens = await repositorioItensSupabase(db).listar(orgId, leadId);
  return {
    negocio: { id: negocio.id, titulo: negocio.title ?? "" },
    moeda,
    itens: itens.map((i) => ({
      id: i.id,
      nome: i.nome,
      quantidade: i.quantidade,
      preco_unit_cents: i.preco_unit_cents,
      desconto_cents: i.desconto_cents,
      acrescimo_cents: i.acrescimo_cents,
      total_cents: i.total_cents,
      currency: i.currency,
    })),
    ja_no_negocio_cents: somaDoNegocio(itens, moeda).total_cents,
    timezone,
    hoje,
  };
}
