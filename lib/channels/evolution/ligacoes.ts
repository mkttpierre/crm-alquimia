/**
 * Ligação do WhatsApp (evento `call` da Evolution) → NOTA DE TELA na conversa.
 *
 * ─── Por que nota (`type=system`) e nunca mensagem ──────────────────────────────
 * Ligação não é texto de ninguém: o operador precisa VER que o lead ligou (ou que
 * a ligação ficou sem resposta), e nada mais. Por isso a linha nasce:
 *   - `type='system'` e `sent_via='system'`: a tela a desenha como nota no meio da
 *     conversa, sem tique de entrega; a saúde do chip e o chip mudo já pulam
 *     `system`;
 *   - `direction='outbound'`: NUNCA `inbound`. Toda leitura de "o lead respondeu"
 *     (motor de disparo, follow-up, trava de não entregue, IA) olha
 *     `direction='inbound'`, e uma ligação contada como resposta mudaria o que o
 *     sistema faz com o lead. O `trg_messages_emit_event` emite `message.sent` para
 *     ela, que não tem consumidor; `message.received` (o que acorda IA, automação e
 *     follow-up) só nasce de linha `inbound`. A leitura de "operador falou" do
 *     atendimento do motor pula `system` (`lib/disparo/atendimento/repositorio-supabase.ts`);
 *   - sem tocar na conversa (`last_*`): ligação não é a última mensagem de ninguém.
 *
 * ─── Uma linha por ligação, não por estado ─────────────────────────────────────
 * O Baileys manda um evento por estado (`offer`, `ringing`, `accept`, `reject`,
 * `timeout`, `terminate`) com o MESMO `id`. A linha usa `external_id =
 * 'ligacao:<id>'` — o unique `(organization_id, external_id)` impede a segunda — e
 * cada estado novo reescreve o texto: tocou e ninguém atendeu vira "perdida";
 * atendeu (em qualquer aparelho) fica "recebida". A hora é a do primeiro estado,
 * no fuso de São Paulo.
 *
 * ─── Feita × recebida ──────────────────────────────────────────────────────────
 * O `WACallEvent` não diz a direção. "Feita" quando o evento traz `fromMe: true`
 * ou quando quem iniciou (`from`) é o próprio número da conexão
 * (`channel_sessions.phone_number`). Sem o número cadastrado, toda ligação é lida
 * como recebida — o erro mais barato dos dois.
 *
 * Nunca lança: o webhook já gravou o que tinha de gravar; uma ligação que não
 * virou nota fica no log, contada.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { canonicalPhoneBR } from "@/lib/channels/phone-variants";
import { desfechoDaLigacao, textoDaLigacao, type DesfechoDaLigacao } from "@/lib/inbox/ligacao";
import { logger } from "@/lib/logger";
import { parseChatId } from "@/lib/waha/ingest";

import type { LigacaoVista } from "./webhook";

// A regra e o texto moram em `lib/inbox/ligacao.ts`, que a tela também usa.
export { desfechoDaLigacao, textoDaLigacao, type DesfechoDaLigacao };

/** Prefixo do `external_id` da nota de ligação (o id do Baileys não colide com id de mensagem). */
export const PREFIXO_ID_LIGACAO = "ligacao:";

interface SessaoDaLigacao {
  id: string;
  organization_id: string;
  phone_number: string | null;
}

interface EstadoGuardado {
  estados: string[];
  inicio: string;
  feita: boolean;
  video: boolean;
}

/**
 * Forma canônica do celular BR (COM o nono dígito), para comparar: o cadastro da
 * conexão e o JID do WhatsApp podem trazer o mesmo número com e sem o 9.
 */
function numeroCanonico(v: string | null | undefined): string {
  const d = (v ?? "").replace(/\D/g, "");
  return d ? canonicalPhoneBR(`+${d}`) : "";
}

/** O JID é o número desta própria conexão? Só JID de telefone responde; `@lid` não tem número. */
function ehOProprioNumero(jid: string | null, proprio: string): boolean {
  if (!jid || !proprio) return false;
  const p = parseChatId(jid);
  return p.kind === "phone" && numeroCanonico(p.phone) === proprio;
}

function estadoGuardado(metadata: unknown): EstadoGuardado | null {
  const l = metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>).ligacao : null;
  if (!l || typeof l !== "object") return null;
  const o = l as Record<string, unknown>;
  return {
    estados: Array.isArray(o.estados) ? o.estados.filter((e): e is string => typeof e === "string") : [],
    inicio: typeof o.inicio === "string" ? o.inicio : "",
    feita: o.feita === true,
    video: o.video === true,
  };
}

async function registrarUma(admin: SupabaseClient, sessao: SessaoDaLigacao, l: LigacaoVista, tentativa = 0): Promise<boolean> {
  const org = sessao.organization_id;
  const proprio = numeroCanonico(sessao.phone_number);
  const feitaAgora = l.fromMe || ehOProprioNumero(l.de, proprio);
  // O chat é o OUTRO lado. Evento que só aponta o próprio número não tem conversa a marcar.
  if (ehOProprioNumero(l.chat, proprio)) return false;
  const parsed = parseChatId(l.chat);
  if (parsed.kind !== "phone" && parsed.kind !== "lid") return false;

  // Mesma identidade da mensagem: a ligação cai na MESMA conversa que o texto do lead.
  const { data: contato, error: erroContato } = await admin.rpc("fn_upsert_wa_contact" as never, {
    p_org: org,
    p_kind: parsed.kind,
    p_phone: parsed.kind === "phone" ? canonicalPhoneBR(parsed.phone) : l.telefone ? canonicalPhoneBR(l.telefone) : null,
    p_lid: parsed.kind === "lid" ? parsed.lid : null,
    p_chat_id: l.chat,
    p_notify: null,
  } as never);
  if (erroContato) throw new Error(`contato: ${String(erroContato.message).slice(0, 120)}`);
  if (!contato) return false;
  const { data: conversa, error: erroConversa } = await admin.rpc("fn_upsert_wa_conversation" as never, {
    p_org: org,
    p_contact: contato,
    p_session: sessao.id,
  } as never);
  if (erroConversa) throw new Error(`conversa: ${String(erroConversa.message).slice(0, 120)}`);
  if (!conversa) return false;

  const externalId = `${PREFIXO_ID_LIGACAO}${l.id}`;
  const { data: existente, error: erroLeitura } = await admin
    .from("messages")
    .select("id, metadata")
    .eq("organization_id", org)
    .eq("external_id", externalId)
    .maybeSingle();
  if (erroLeitura) throw new Error(`leitura: ${String(erroLeitura.message).slice(0, 120)}`);

  const antes = estadoGuardado((existente as { metadata?: unknown } | null)?.metadata);
  const ligacao: EstadoGuardado & { id: string; desfecho: DesfechoDaLigacao } = {
    id: l.id,
    estados: [...new Set([...(antes?.estados ?? []), l.estado])],
    inicio: antes?.inicio || l.quando || new Date().toISOString(),
    feita: (antes?.feita ?? false) || feitaAgora,
    video: (antes?.video ?? false) || l.video,
    desfecho: "recebida",
  };
  ligacao.desfecho = desfechoDaLigacao(ligacao.estados, ligacao.feita);
  const body = textoDaLigacao(ligacao.desfecho, new Date(ligacao.inicio));

  if (existente) {
    const meta = (existente as { metadata?: unknown }).metadata;
    const { error } = await admin
      .from("messages")
      .update({ body, metadata: { ...(meta && typeof meta === "object" ? meta : {}), ligacao } })
      .eq("organization_id", org)
      .eq("id", (existente as { id: string }).id);
    if (error) throw new Error(`atualizacao: ${String(error.message).slice(0, 120)}`);
    return true;
  }

  const { error } = await admin.from("messages").insert({
    organization_id: org,
    conversation_id: conversa,
    channel_session_id: sessao.id,
    contact_id: contato,
    external_id: externalId,
    type: "system",
    direction: "outbound",
    status: "sent",
    sent_via: "system",
    body,
    sent_at: ligacao.inicio,
    metadata: { ligacao },
  });
  // Dois estados da mesma ligação entregues juntos: o outro gravou primeiro. Uma volta lê e reescreve.
  if (error?.code === "23505" && tentativa === 0) return registrarUma(admin, sessao, l, 1);
  if (error) throw new Error(`insercao: ${String(error.message).slice(0, 120)}`);
  return true;
}

/** Grava (ou atualiza) a nota de cada ligação do lote. Devolve quantas ficaram registradas. Nunca lança. */
export async function registrarLigacoes(
  admin: SupabaseClient,
  sessao: SessaoDaLigacao,
  ligacoes: readonly LigacaoVista[],
): Promise<number> {
  let registradas = 0;
  for (const l of ligacoes) {
    try {
      if (await registrarUma(admin, sessao, l)) registradas++;
    } catch (e) {
      logger.warn("evolution.ligacao: nota de ligação não registrada", {
        organization_id: sessao.organization_id,
        channel_session_id: sessao.id,
        detail: e instanceof Error ? e.message.slice(0, 160) : "erro",
      });
    }
  }
  return registradas;
}
