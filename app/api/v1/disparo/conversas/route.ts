/**
 * GET /api/v1/disparo/conversas — as conversas do atendimento do motor (quem respondeu): etapa,
 * última leitura, se precisa do operador, se está quente, e o caminho até o lead e a conversa.
 *
 * SÓ LEITURA. Quatro consultas fixas: as conversas da página (com o lead embutido), as leituras
 * desses leads, os contatos e as conversas do inbox deles. Nada por linha.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import {
  TAMANHO_DA_PAGINA,
  consultaDeConversasSchema,
  type ConversaDaTela,
  type Pagina,
} from "@/lib/disparo-painel/esquemas";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Contato = { id: string; name: string | null; display_name: string | null };
type LinhaDaConversa = {
  lead_id: string;
  etapa: string;
  quente: boolean;
  precisa_operador: boolean;
  motivo_operador: string | null;
  auto_seguidas: number;
  updated_at: string;
  lead: { id: string; title: string; contact_id: string | null } | null;
};

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "disparo_conversas" });
  if (!authz.ok) return authz.response;
  const { org, user } = authz;
  const t = (texto: string) => traduzir(texto, user.idioma);

  const parsed = consultaDeConversasSchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) {
    return fail("validation_failed", t("Parâmetros inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  const { filtro, pagina } = parsed.data;
  const supabase = await createClient();

  let consulta = supabase
    .from("disparo_conversas")
    .select(
      "lead_id, etapa, quente, precisa_operador, motivo_operador, auto_seguidas, updated_at, lead:crm_leads(id, title, contact_id)",
      { count: "exact" },
    )
    .eq("organization_id", org.orgId);
  if (filtro === "operador") consulta = consulta.eq("precisa_operador", true);
  if (filtro === "quentes") consulta = consulta.eq("quente", true);
  const { data, error, count } = await consulta
    .order("precisa_operador", { ascending: false })
    .order("updated_at", { ascending: false })
    .range((pagina - 1) * TAMANHO_DA_PAGINA, pagina * TAMANHO_DA_PAGINA - 1);
  if (error) return fail("internal_error", t("Não foi possível ler as conversas."), 500, { requestId });

  const linhas = (data ?? []) as unknown as LinhaDaConversa[];
  const leadIds = linhas.map((l) => l.lead_id);
  const contatoIds = [...new Set(linhas.map((l) => l.lead?.contact_id).filter((x): x is string => !!x))];

  const ultimaLeitura = new Map<string, NonNullable<ConversaDaTela["ultima_leitura"]>>();
  const contatos = new Map<string, Contato>();
  const conversaDoContato = new Map<string, string>();

  if (leadIds.length > 0) {
    const [leituras, nomes, conversas] = await Promise.all([
      supabase
        .from("disparo_leituras")
        .select("lead_id, texto, decisao, irritada, created_at")
        .eq("organization_id", org.orgId)
        .in("lead_id", leadIds)
        .order("created_at", { ascending: false })
        .limit(leadIds.length * 5),
      contatoIds.length
        ? supabase.from("contacts").select("id, name, display_name").eq("organization_id", org.orgId).in("id", contatoIds)
        : Promise.resolve({ data: [] as Contato[], error: null }),
      contatoIds.length
        ? supabase
            .from("conversations")
            .select("id, contact_id")
            .eq("organization_id", org.orgId)
            .in("contact_id", contatoIds)
            .order("last_message_at", { ascending: false, nullsFirst: false })
        : Promise.resolve({ data: [] as { id: string; contact_id: string }[], error: null }),
    ]);
    if (leituras.error || nomes.error || conversas.error) {
      return fail("internal_error", t("Não foi possível ler as conversas."), 500, { requestId });
    }
    for (const l of leituras.data ?? []) {
      if (!ultimaLeitura.has(l.lead_id)) {
        ultimaLeitura.set(l.lead_id, { texto: l.texto, decisao: l.decisao, irritada: l.irritada, em: l.created_at });
      }
    }
    for (const c of (nomes.data ?? []) as Contato[]) contatos.set(c.id, c);
    for (const c of conversas.data ?? []) if (!conversaDoContato.has(c.contact_id)) conversaDoContato.set(c.contact_id, c.id);
  }

  const itens: ConversaDaTela[] = linhas.map((l) => {
    const contato = l.lead?.contact_id ? contatos.get(l.lead.contact_id) : undefined;
    return {
      lead_id: l.lead_id,
      lead_nome: contato ? rotuloDoContato(contato) : l.lead?.title || "—",
      etapa: l.etapa,
      quente: l.quente,
      precisa_operador: l.precisa_operador,
      motivo_operador: l.motivo_operador,
      auto_seguidas: l.auto_seguidas,
      atualizada_em: l.updated_at,
      ultima_leitura: ultimaLeitura.get(l.lead_id) ?? null,
      conversation_id: l.lead?.contact_id ? (conversaDoContato.get(l.lead.contact_id) ?? null) : null,
    };
  });
  const corpo: Pagina<ConversaDaTela> = { itens, pagina, tamanho: TAMANHO_DA_PAGINA, total: count ?? 0 };
  return ok(corpo, { requestId });
}
