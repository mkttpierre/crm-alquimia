/**
 * Reconciliação de entrada do canal Evolution: dublê da Evolution (credencial, estado, leitura
 * paginada) e do Supabase (sessões, `messages`, Central), com a triagem REAL do webhook.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/waha/ingest", () => ({ dispatchWahaEvent: vi.fn() }));
vi.mock("@/lib/channels/health", () => ({ REF_KIND_SESSAO: "channel_session" }));

import { reconciliarEntrada, horasDaJanela, type DepsDaReconciliacao } from "./reconciliacao";

const ORG = "org-1";
const AGORA = new Date("2026-11-10T15:00:00.000Z");
const TS = Math.floor(AGORA.getTime() / 1000) - 3600;

type Sessao = Record<string, unknown>;
type Linha = { organization_id: string; external_id: string; metadata: Record<string, unknown> };
type Aviso = Record<string, unknown> & { id: string };

const sessao = (id: string, instancia: string, extra: Sessao = {}): Sessao => ({
  id,
  organization_id: ORG,
  status: "WORKING",
  display_name: `Chip ${instancia}`,
  evolution_instance_name: instancia,
  is_warmup_complete: true,
  warmup_started_at: null,
  ...extra,
});

const entrada = (id: string, jid = "5581999990000@s.whatsapp.net", extra: Record<string, unknown> = {}) => ({
  id: `evo-${id}`,
  key: { remoteJid: jid, fromMe: false, id },
  pushName: "Maria",
  messageType: "conversation",
  message: { conversation: `texto ${id}` },
  messageTimestamp: TS,
  ...extra,
});

/** Supabase em memória: só o que a reconciliação usa. */
function bancoEmMemoria(sessoes: Sessao[], mensagens: Linha[] = [], avisos: Aviso[] = []) {
  const escritas: string[] = [];
  const from = (tabela: string) => {
    const filtros: Array<[string, string, unknown]> = [];
    let op: "select" | "insert" | "update" = "select";
    let valores: Record<string, unknown> = {};
    const casa = (l: Record<string, unknown>) =>
      filtros.every(([t, c, v]) =>
        t === "eq" ? l[c] === v : t === "in" ? (v as unknown[]).includes(l[c]) : t === "like" ? String(l[c]).startsWith(String(v).replace(/%$/, "")) : true,
      );
    const resolver = () => {
      if (tabela === "channel_sessions") return { data: sessoes, error: null };
      if (tabela === "messages") return { data: mensagens.filter(casa), error: null };
      if (tabela === "agent_inbox_items") {
        if (op === "insert") {
          escritas.push("aviso:insert");
          avisos.push({ id: `a${avisos.length + 1}`, status: "open", ...valores });
          return { data: null, error: null };
        }
        if (op === "update") {
          escritas.push("aviso:update");
          for (const a of avisos.filter(casa)) Object.assign(a, valores);
          return { data: null, error: null };
        }
        return { data: avisos.filter(casa)[0] ?? null, error: null };
      }
      return { data: null, error: null };
    };
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (c: string, v: unknown) => (filtros.push(["eq", c, v]), q),
      in: (c: string, v: unknown) => (filtros.push(["in", c, v]), q),
      like: (c: string, v: unknown) => (filtros.push(["like", c, v]), q),
      is: () => q,
      not: () => q,
      limit: () => q,
      insert: (v: Record<string, unknown>) => ((op = "insert"), (valores = v), q),
      update: (v: Record<string, unknown>) => ((op = "update"), (valores = v), q),
      maybeSingle: async () => resolver(),
      then: (r: (x: unknown) => void) => r(resolver()),
    };
    return q;
  };
  return { admin: { from } as never, mensagens, avisos, escritas };
}

/** Evolution falsa: registros por instância, paginados do mais novo para o mais velho. */
function evolution(porInstancia: Record<string, unknown[]>, extra: Partial<DepsDaReconciliacao> = {}) {
  const ingeridas: Array<{ sessao: string; id: string; opcoes: unknown }> = [];
  let mensagensDoBanco: Linha[] = [];
  const deps: Partial<DepsDaReconciliacao> = {
    agora: () => AGORA,
    credenciais: async (_a, l) => ({ baseUrl: "http://evo", apiKey: "k", instance: l.instance, source: "session" }),
    estado: async () => "open",
    buscar: async (creds, { pagina, porPagina }) => {
      const todos = porInstancia[creds.instance] ?? [];
      return {
        total: todos.length,
        paginas: Math.ceil(todos.length / porPagina),
        registros: todos.slice((pagina - 1) * porPagina, pagina * porPagina),
      };
    },
    // A ingestão real grava a linha com a marca; o dublê faz o mesmo no banco em memória.
    ingerir: async (_admin, s, envelope, _req, opcoes) => {
      const id = String(envelope.payload?.id);
      ingeridas.push({ sessao: s.id, id, opcoes });
      mensagensDoBanco.push({ organization_id: s.organization_id, external_id: id, metadata: { recuperada: true } });
    },
    ...extra,
  };
  return { deps, ingeridas, ligar: (m: Linha[]) => (mensagensDoBanco = m) };
}

function montar(sessoes: Sessao[], porInstancia: Record<string, unknown[]>, extra: Partial<DepsDaReconciliacao> = {}, jaNoBanco: Linha[] = []) {
  const banco = bancoEmMemoria(sessoes, jaNoBanco);
  const evo = evolution(porInstancia, extra);
  evo.ligar(banco.mensagens);
  return { ...banco, ...evo };
}

beforeEach(() => vi.clearAllMocks());

describe("(a) mensagem só na Evolution entra uma única vez", () => {
  it("ausente é ingerida; a segunda passada a vê presente e não ingere de novo", async () => {
    const m = montar([sessao("s1", "chip-alfa")], { "chip-alfa": [entrada("A"), entrada("B")] }, {}, [
      { organization_id: ORG, external_id: "B", metadata: {} },
    ]);
    const r1 = await reconciliarEntrada(m.admin, { requestId: "r1" }, m.deps);
    expect(m.ingeridas.map((i) => i.id)).toEqual(["A"]);
    expect(r1.sessoes[0]).toMatchObject({ lidas: 2, ja_presentes: 1, ausentes: 1, recuperadas: 1 });

    const r2 = await reconciliarEntrada(m.admin, { requestId: "r2" }, m.deps);
    expect(m.ingeridas).toHaveLength(1);
    expect(r2.sessoes[0]).toMatchObject({ ja_presentes: 2, ausentes: 0, recuperadas: 0 });
  });

  it("presença é conferida na ORGANIZAÇÃO da sessão (o mesmo id em outro tenant não conta)", async () => {
    const m = montar([sessao("s1", "chip-alfa")], { "chip-alfa": [entrada("A")] }, {}, [
      { organization_id: "org-2", external_id: "A", metadata: {} },
    ]);
    await reconciliarEntrada(m.admin, { requestId: "r" }, m.deps);
    expect(m.ingeridas.map((i) => i.id)).toEqual(["A"]);
  });

  it("ingere da mais velha para a mais nova", async () => {
    const m = montar([sessao("s1", "chip-alfa")], {
      "chip-alfa": [entrada("NOVA", undefined, { messageTimestamp: TS + 60 }), entrada("VELHA", undefined, { messageTimestamp: TS - 60 })],
    });
    await reconciliarEntrada(m.admin, { requestId: "r" }, m.deps);
    expect(m.ingeridas.map((i) => i.id)).toEqual(["VELHA", "NOVA"]);
  });
});

describe("(b) grupo, status e canal nunca chegam à ingestão", () => {
  it("lote só de grupo/status/newsletter: nada ingerido, nada consultado, tudo contado", async () => {
    const m = montar([sessao("s1", "chip-alfa")], {
      "chip-alfa": [entrada("G", "120363@g.us"), entrada("S", "status@broadcast"), entrada("N", "1203@newsletter")],
    });
    const r = await reconciliarEntrada(m.admin, { requestId: "r" }, m.deps);
    expect(m.ingeridas).toEqual([]);
    expect(r.sessoes[0]!.ignoradas.grupo_ou_status).toBe(3);
    expect(m.escritas).toEqual([]);
  });

  it("lote misto: só a conversa individual entra", async () => {
    const m = montar([sessao("s1", "chip-alfa")], { "chip-alfa": [entrada("G", "120363@g.us"), entrada("P")] });
    const r = await reconciliarEntrada(m.admin, { requestId: "r" }, m.deps);
    expect(m.ingeridas.map((i) => i.id)).toEqual(["P"]);
    expect(r.sessoes[0]!.ignoradas.grupo_ou_status).toBe(1);
  });
});

describe("(c) fromMe (enviada pelo celular) entra; sem direção e técnico ficam de fora", () => {
  it("chamada, reação, sem conteúdo e fromMe ausente não entram; fromMe entra", async () => {
    const m = montar([sessao("s1", "chip-alfa")], {
      "chip-alfa": [
        entrada("EU", undefined, { key: { remoteJid: "5581999990000@s.whatsapp.net", fromMe: true, id: "EU" } }),
        entrada("SEM", undefined, { key: { remoteJid: "5581999990000@s.whatsapp.net", id: "SEM" } }),
        entrada("CALL", undefined, { messageType: "unknown", message: { call: {} } }),
        entrada("REACT", undefined, { messageType: "reactionMessage", message: { reactionMessage: { text: "x" } } }),
        entrada("NULO", undefined, { messageType: "audioMessage", message: null }),
        entrada("OK"),
      ],
    });
    const r = await reconciliarEntrada(m.admin, { requestId: "r" }, m.deps);
    expect(m.ingeridas.map((i) => i.id)).toEqual(["EU", "OK"]);
    expect(r.sessoes[0]!.ignoradas).toEqual({ grupo_ou_status: 0, sem_direcao: 1, tecnico: 3 });
  });

  it("a fromMe recuperada vai à ingestão como `fromMe` e com a marca `recuperada`", async () => {
    const m = montar([sessao("s1", "chip-alfa")], {
      "chip-alfa": [entrada("EU", undefined, { key: { remoteJid: "5581999990000@s.whatsapp.net", fromMe: true, id: "EU" } })],
    });
    const envelopes: unknown[] = [];
    const ingerir = m.deps.ingerir!;
    await reconciliarEntrada(m.admin, { requestId: "r" }, { ...m.deps, ingerir: async (a, s, e, q, o) => (envelopes.push(e), ingerir(a, s, e, q, o)) });
    expect(envelopes).toMatchObject([{ event: "message", payload: { id: "EU", fromMe: true } }]);
    expect(m.ingeridas.map((i) => i.opcoes)).toEqual([{ recuperada: true }]);
  });

  it("o que o CRM já gravou (mesmo external_id) não é reingerido", async () => {
    const m = montar(
      [sessao("s1", "chip-alfa")],
      { "chip-alfa": [entrada("EU", undefined, { key: { remoteJid: "5581999990000@s.whatsapp.net", fromMe: true, id: "EU" } })] },
      {},
      [{ organization_id: ORG, external_id: "EU", metadata: {} }],
    );
    const r = await reconciliarEntrada(m.admin, { requestId: "r" }, m.deps);
    expect(m.ingeridas).toEqual([]);
    expect(r.sessoes[0]).toMatchObject({ ja_presentes: 1, ausentes: 0 });
  });

  it("edição e exclusão que vêm como protocolo não contam como mensagem ausente", async () => {
    const m = montar([sessao("s1", "chip-alfa")], {
      "chip-alfa": [
        entrada("ED", undefined, {
          messageType: "conversation",
          message: { protocolMessage: { key: { id: "ORIG" }, type: 14, editedMessage: { conversation: "novo" } } },
        }),
      ],
    });
    await reconciliarEntrada(m.admin, { requestId: "r" }, m.deps);
    expect(m.ingeridas).toEqual([]);
  });
});

describe("(d) recuperada não pede despacho nem envio", () => {
  it("toda ingestão leva `recuperada: true`", async () => {
    const m = montar([sessao("s1", "chip-alfa")], { "chip-alfa": [entrada("A"), entrada("B")] });
    await reconciliarEntrada(m.admin, { requestId: "r" }, m.deps);
    expect(m.ingeridas.map((i) => i.opcoes)).toEqual([{ recuperada: true }, { recuperada: true }]);
  });

  it("o módulo não chama atendimento do motor nem nada que envie (âncora no fonte)", () => {
    const fonte = readFileSync(join(__dirname, "reconciliacao.ts"), "utf8");
    const imports = fonte.split("\n").filter((l) => l.startsWith("import "));
    expect(imports.join("\n")).not.toMatch(/atendimento|gancho|enviar|pos-entrada|kick-local-pipeline|agent-engine/);
    expect(imports.join("\n")).not.toMatch(/\benviarTexto\b|\benviarMidia\b|\benviarAudio\b/);
  });

  it("abre UM aviso na Central e, na passada seguinte, soma no mesmo (sem empilhar)", async () => {
    const m = montar([sessao("s1", "chip-alfa")], { "chip-alfa": [entrada("A"), entrada("B")] });
    await reconciliarEntrada(m.admin, { requestId: "r1" }, m.deps);
    expect(m.avisos).toHaveLength(1);
    expect(m.avisos[0]).toMatchObject({ kind: "channel_number_alert", severity: "warn", ref_kind: "channel_session", ref_id: "s1" });
    expect(String(m.avisos[0]!.title)).toBe('Mensagens recuperadas da conexão "Chip chip-alfa" (2)');
    expect(String(m.avisos[0]!.body)).toMatch(/Nada foi respondido automaticamente/);

    // Chega mais uma mensagem perdida: o mesmo aviso passa a dizer 3.
    const r2 = evolution({ "chip-alfa": [entrada("A"), entrada("B"), entrada("C")] });
    r2.ligar(m.mensagens);
    await reconciliarEntrada(m.admin, { requestId: "r2" }, r2.deps);
    expect(m.avisos).toHaveLength(1);
    expect(String(m.avisos[0]!.title)).toBe('Mensagens recuperadas da conexão "Chip chip-alfa" (3)');
  });

  it("passada sem recuperada não toca na Central", async () => {
    const m = montar([sessao("s1", "chip-alfa")], { "chip-alfa": [] });
    await reconciliarEntrada(m.admin, { requestId: "r" }, m.deps);
    expect(m.escritas).toEqual([]);
  });
});

describe("(e) dry_run não grava nada", () => {
  it("conta lidas/presentes/ausentes/ignoradas sem ingerir nem avisar", async () => {
    const m = montar([sessao("s1", "chip-alfa")], { "chip-alfa": [entrada("A"), entrada("B"), entrada("G", "1@g.us")] }, {}, [
      { organization_id: ORG, external_id: "B", metadata: {} },
    ]);
    const r = await reconciliarEntrada(m.admin, { requestId: "r", dryRun: true, horas: 168 }, m.deps);
    expect(m.ingeridas).toEqual([]);
    expect(m.escritas).toEqual([]);
    expect(r).toMatchObject({ dry_run: true, horas: 168, total_lidas: 3, total_ausentes: 1, total_recuperadas: 0 });
    expect(r.sessoes[0]).toMatchObject({ lidas: 3, ja_presentes: 1, ausentes: 1, ignoradas: { grupo_ou_status: 1, sem_direcao: 0, tecnico: 0 } });
  });
});

describe("(f) teto por passada, com continuação", () => {
  it("ingere até o teto (somando sessões) e deixa o resto para a próxima passada", async () => {
    const muitas = Array.from({ length: 5 }, (_, i) => entrada(`M${i}`, undefined, { messageTimestamp: TS + i }));
    const m = montar([sessao("s1", "chip-alfa"), sessao("s2", "chip-beta")], { "chip-alfa": muitas, "chip-beta": [entrada("X")] });
    const r1 = await reconciliarEntrada(m.admin, { requestId: "r1", teto: 3 }, m.deps);
    expect(m.ingeridas.map((i) => i.id)).toEqual(["M0", "M1", "M2"]);
    expect(r1.sessoes[0]).toMatchObject({ ausentes: 5, recuperadas: 3, pendentes: 2 });
    expect(r1.sessoes[1]).toMatchObject({ ausentes: 1, recuperadas: 0, pendentes: 1 });

    await reconciliarEntrada(m.admin, { requestId: "r2", teto: 3 }, m.deps);
    expect(m.ingeridas.map((i) => i.id)).toEqual(["M0", "M1", "M2", "M3", "M4", "X"]);
  });

  it("lê todas as páginas da janela", async () => {
    const muitas = Array.from({ length: 230 }, (_, i) => entrada(`P${i}`));
    const m = montar([sessao("s1", "chip-alfa")], { "chip-alfa": muitas });
    const r = await reconciliarEntrada(m.admin, { requestId: "r", dryRun: true }, m.deps);
    expect(r.sessoes[0]!.lidas).toBe(230);
  });

  it("horas fora de faixa caem no padrão; acima do máximo, no máximo", () => {
    expect(horasDaJanela(undefined)).toBe(24);
    expect(horasDaJanela("abc")).toBe(24);
    expect(horasDaJanela("0")).toBe(24);
    expect(horasDaJanela("48")).toBe(48);
    expect(horasDaJanela("9999")).toBe(168);
  });
});

describe("(g) falha de um chip não impede os outros; desconectada é pulada", () => {
  it("leitura que estoura numa sessão vira `erro` nela; a seguinte é reconciliada", async () => {
    const m = montar([sessao("s1", "chip-alfa"), sessao("s2", "chip-beta")], { "chip-beta": [entrada("Y")] }, {
      buscar: async (creds, input) => {
        if (creds.instance === "chip-alfa") throw new Error("evolution_timeout");
        return { total: 1, paginas: 1, registros: input.pagina === 1 ? [entrada("Y")] : [] };
      },
    });
    const r = await reconciliarEntrada(m.admin, { requestId: "r" }, m.deps);
    expect(r.sessoes.map((s) => s.desfecho)).toEqual(["erro", "ok"]);
    expect(m.ingeridas.map((i) => i.id)).toEqual(["Y"]);
  });

  it("sessão STOPPED ou instância fora de `open` é pulada sem chamar a leitura", async () => {
    const buscar = vi.fn(async () => ({ total: 0, paginas: 0, registros: [] }));
    const m = montar([sessao("s1", "chip-alfa", { status: "STOPPED" }), sessao("s2", "chip-beta")], {}, {
      buscar,
      estado: async () => "connecting",
    });
    const r = await reconciliarEntrada(m.admin, { requestId: "r" }, m.deps);
    expect(r.sessoes.map((s) => s.desfecho)).toEqual(["desconectada", "desconectada"]);
    expect(buscar).not.toHaveBeenCalled();
  });

  it("falha na ingestão de uma mensagem não corta as seguintes", async () => {
    const m = montar([sessao("s1", "chip-alfa")], { "chip-alfa": [entrada("A", undefined, { messageTimestamp: TS }), entrada("B", undefined, { messageTimestamp: TS + 1 })] });
    const original = m.deps.ingerir!;
    m.deps.ingerir = async (...a) => {
      if (a[2].payload?.id === "A") throw new Error("waha_message_insert_failed");
      return original(...a);
    };
    const r = await reconciliarEntrada(m.admin, { requestId: "r" }, m.deps);
    expect(r.sessoes[0]).toMatchObject({ falhas: 1, recuperadas: 1 });
  });
});

describe("(i) carência: mensagem recém-chegada é do webhook, não da reconciliação", () => {
  it("a janela termina 3 min antes de agora — quem acabou de chegar ainda está a caminho pelo webhook", async () => {
    const janelas: Array<{ desde: Date; ate: Date }> = [];
    const m = montar([sessao("s1", "chip-alfa")], { "chip-alfa": [] }, {
      buscar: async (_creds, { desde, ate }) => {
        janelas.push({ desde, ate });
        return { total: 0, paginas: 0, registros: [] };
      },
    });

    await reconciliarEntrada(m.admin, { requestId: "r" }, m.deps);

    expect(janelas).toHaveLength(1);
    expect(AGORA.getTime() - janelas[0]!.ate.getTime()).toBe(3 * 60_000);
    expect(janelas[0]!.ate.getTime() - janelas[0]!.desde.getTime()).toBe(24 * 3_600_000);
  });
});
