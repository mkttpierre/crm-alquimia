/**
 * E7 (10/11/2026, suspeito): o ECO DO MOTOR DE DISPARO lido como "humano no celular".
 *
 * O motor chama o canal e só DEPOIS grava o espelho em `messages` (`lib/disparo/envio-real.ts`). Se o eco `fromMe`
 * do webhook chega antes do espelho, `handleOutboundFromUserPhone` não acha linha nenhuma: o dedup por `external_id`
 * não casa e `ehEcoDeEnvioNosso` só conhece linhas `ai`/`user` em `queued`/`sending` — o motor nunca grava uma dessas.
 * Resultado: a IA é pausada como se uma pessoa tivesse respondido, e o motor cancela a fila do lead como "humano no
 * comando" (`motor.ts`, veto de `situacaoHumana`).
 *
 * Regra: antes de tratar como humano, a ingestão confere se há envio do motor EM CURSO (ou acabado de sair) para
 * aquele contato com o mesmo corpo. Se houver, é eco: grava a linha (como sempre) e NÃO pausa a IA. Digitação real no
 * celular continua pausando.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import { dispatchWahaEvent, type WahaEnvelope, type WahaPayload } from "@/lib/waha/ingest";

type Linha = Record<string, unknown> & { id: string };

/**
 * Dublê com `messages` (vazia: o espelho do motor ainda não existe), `conversations` (registra o update do
 * silêncio), `crm_leads` (o lead do contato) e `disparo_envios` (o envio do motor em curso). Os filtros `eq`/`in`
 * são aplicados de verdade nas tabelas novas, para o gate não passar pelo motivo errado.
 */
function banco(envios: Array<Partial<Linha>>, leads: Array<Partial<Linha>> = [{ id: "lead-1", organization_id: "org-1", contact_id: "contato-1" }]) {
  const messages: Linha[] = [];
  const conversa: Record<string, unknown> = { id: "conversa-1", organization_id: "org-1", bot_silenced_until: null };
  const tabelas: Record<string, Linha[]> = {
    crm_leads: leads.map((l, i) => ({ id: `l${i}`, ...l }) as Linha),
    disparo_envios: envios.map((e, i) => ({ id: `e${i}`, ...e }) as Linha),
  };

  const consulta = (nome: string) => {
    const filtros: Array<(l: Linha) => boolean> = [];
    let externos: string[] = [];
    const q: Record<string, unknown> = {
      eq(c: string, v: unknown) {
        filtros.push((l) => l[c] === v);
        return q;
      },
      in(c: string, vs: unknown[]) {
        if (nome === "messages" && c === "external_id") externos = vs as string[];
        filtros.push((l) => vs.includes(l[c]));
        return q;
      },
      is: () => q,
      gte(c: string, v: string) {
        filtros.push((l) => typeof l[c] !== "string" || (l[c] as string) >= v);
        return q;
      },
      order: () => q,
      limit: () => q,
      async maybeSingle() {
        if (nome === "conversations") return { data: { bot_silenced_until: conversa.bot_silenced_until }, error: null };
        const achou = (tabelas[nome] ?? messages).find((l) => filtros.every((f) => f(l)) && (nome !== "messages" || externos.includes(l.external_id as string)));
        return { data: achou ?? null, error: null };
      },
      then(ok: (v: unknown) => unknown) {
        const linhas = nome === "messages" ? messages : (tabelas[nome] ?? []);
        return Promise.resolve(ok({ data: linhas.filter((l) => filtros.every((f) => f(l))), error: null }));
      },
    };
    return q;
  };

  const admin = {
    from: (nome: string) => ({
      select: () => consulta(nome),
      insert: (linha: Record<string, unknown>) => ({
        select: () => ({
          async maybeSingle() {
            if (nome !== "messages") return { data: { id: "x" }, error: null };
            const nova = { id: `msg-${messages.length + 1}`, ...linha } as Linha;
            messages.push(nova);
            return { data: { id: nova.id }, error: null };
          },
        }),
      }),
      update: (patch: Record<string, unknown>) => {
        if (nome === "conversations") Object.assign(conversa, patch);
        const enc: Record<string, unknown> = { error: null };
        enc.eq = () => enc;
        enc.in = () => enc;
        return enc;
      },
    }),
    rpc: async (fn: string) => {
      if (fn === "fn_upsert_wa_contact") return { data: "contato-1", error: null };
      if (fn === "fn_upsert_wa_conversation") return { data: "conversa-1", error: null };
      return { data: null, error: null };
    },
  };
  return { admin, messages, conversa };
}

const SESSION = { id: "sessao-1", organization_id: "org-1" };
const TEXTO = "Oi Maria, passando por aqui de novo. Posso te mostrar a novidade?";
const envelope = (p: WahaPayload): WahaEnvelope => ({ event: "message.any", session: "default", payload: p });
const eco = (body: string): WahaPayload => ({ id: "true_5511999990000@c.us_3EB0C767D097E9ECA6B1", from: "5511999990000@c.us", fromMe: true, body, timestamp: 1_760_000_000 });
const agoraIso = () => new Date().toISOString();

/** O envio do motor no instante da chamada ao canal: reservado, marcado, ainda sem espelho em `messages`. */
const emCurso = (p: Partial<Linha> = {}): Partial<Linha> => ({
  organization_id: "org-1", lead_id: "lead-1", estado: "enviando", texto: TEXTO, midia_id: null, updated_at: agoraIso(), ...p,
});

describe("eco do motor de disparo — a IA não é pausada pelo envio do próprio motor", () => {
  it("⭐ envio do motor em curso + eco com o MESMO texto: a IA NÃO é pausada (e a linha é gravada)", async () => {
    const { admin, conversa, messages } = banco([emCurso()]);
    await dispatchWahaEvent(admin as never, SESSION as never, envelope(eco(TEXTO)), "req-1");
    expect(conversa.bot_silenced_until, "a IA foi pausada pelo eco do próprio motor — e o motor cancelaria a fila do lead como 'humano no comando'").toBeNull();
    expect(messages).toHaveLength(1);
  });

  it("o eco que chega logo DEPOIS do registro (`enviado` há segundos, espelho que falhou) também é do motor", async () => {
    const { admin, conversa } = banco([emCurso({ estado: "enviado" })]);
    await dispatchWahaEvent(admin as never, SESSION as never, envelope(eco(TEXTO)), "req-2");
    expect(conversa.bot_silenced_until).toBeNull();
  });

  it("CONTROLE: digitação real no celular (texto diferente) AINDA pausa", async () => {
    const { admin, conversa } = banco([emCurso()]);
    await dispatchWahaEvent(admin as never, SESSION as never, envelope(eco("oi, aqui é o atendente pelo celular")), "req-3");
    expect(conversa.bot_silenced_until).not.toBeNull();
  });

  it("CONTROLE: envio do motor com o mesmo texto, mas antigo (fora da janela), não serve de álibi", async () => {
    const { admin, conversa } = banco([emCurso({ estado: "enviado", updated_at: new Date(Date.now() - 60 * 60_000).toISOString() })]);
    await dispatchWahaEvent(admin as never, SESSION as never, envelope(eco(TEXTO)), "req-4");
    expect(conversa.bot_silenced_until).not.toBeNull();
  });

  it("CONTROLE: envio do motor para OUTRO contato não serve de álibi", async () => {
    const { admin, conversa } = banco([emCurso({ lead_id: "lead-de-outro" })]);
    await dispatchWahaEvent(admin as never, SESSION as never, envelope(eco(TEXTO)), "req-5");
    expect(conversa.bot_silenced_until).not.toBeNull();
  });

  it("CONTROLE: envio do motor cancelado ou pendente (não chamou o canal) não serve de álibi", async () => {
    const { admin, conversa } = banco([emCurso({ estado: "pendente" }), emCurso({ estado: "cancelado" })]);
    await dispatchWahaEvent(admin as never, SESSION as never, envelope(eco(TEXTO)), "req-6");
    expect(conversa.bot_silenced_until).not.toBeNull();
  });
});
