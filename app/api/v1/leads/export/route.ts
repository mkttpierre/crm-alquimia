/**
 * GET /api/v1/leads/export — leads (negócios) em CSV, em streaming.
 *
 * Query: `busca`, `tag`, `pipeline` (UUID), `de`/`ate` (`AAAA-MM-DD`, última compra do contato) — os mesmos filtros da
 * tela de Leads — e `separador` (`virgula` | `ponto-e-virgula`).
 *
 * Manager ou acima, sempre da organização ativa, fora do modo suporte (exportar a base é ato do dono da conta), no
 * máximo 5 por minuto por usuário, e auditado (`leads.exported`, com contagem e filtros, sem dado nenhum: da busca só
 * se grava que houve e o tamanho). A COMISSÃO DO DONO NUNCA SAI: negócio de valor sigiloso vai sem valor. O que sai e o
 * que nunca sai está em `lib/exportacao/leads.ts`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { consultaDeLeads } from "@/lib/exportacao/consulta";
import { prepararExportacaoDeLeads } from "@/lib/exportacao/leads";
import {
  barrarModoSuporte,
  barrarSeEstourouOLimite,
  falhaAoPreparar,
  filtrosParaAuditoria,
  lerFiltros,
  lerSeparador,
  respostaEmCsv,
} from "@/lib/exportacao/rota";
import { traduzir } from "@/lib/i18n/dicionario";
import { nomesDosAtendentes } from "@/lib/negocio/nomes-dos-atendentes";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "crm_leads" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const suporte = barrarModoSuporte(authz.user, requestId, t);
  if (suporte) return suporte;

  const params = new URL(req.url).searchParams;
  const separador = lerSeparador(params.get("separador"));
  if (!separador) {
    return fail("validation_failed", t("Separador inválido. Use virgula ou ponto-e-virgula."), 422, { requestId });
  }
  const lidos = lerFiltros(params, consultaDeLeads, requestId, t);
  if (!lidos.ok) return lidos.response;
  const filtros = lidos.filtros;

  const estourou = await barrarSeEstourouOLimite(
    "export-leads",
    authz.user.id,
    requestId,
    t("Muitas exportações seguidas. Tente de novo em um minuto."),
  );
  if (estourou) return estourou;

  let preparada;
  try {
    preparada = await prepararExportacaoDeLeads(
      await createClient(),
      authz.org.orgId,
      filtros,
      t,
      nomesDosAtendentes,
    );
  } catch (erro) {
    // Antes do primeiro byte: ainda dá para responder erro de verdade, em vez de um arquivo vazio com status 200.
    return falhaAoPreparar(erro, "leads.export", requestId, t);
  }

  return respostaEmCsv({
    requestId,
    prefixoDoArquivo: "leads",
    separador,
    preparada,
    auditoria: {
      action: "leads.exported",
      organizationId: authz.org.orgId,
      actorUserId: authz.user.id,
      resourceType: "crm_leads",
      filtros: filtrosParaAuditoria(filtros, "busca"),
    },
  });
}
