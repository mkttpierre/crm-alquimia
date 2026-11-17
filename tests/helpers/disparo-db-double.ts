/**
 * Dublê de banco das rotas de escrita do motor (`app/api/v1/disparo/{config,chips}`).
 *
 * Aplica de verdade os filtros (`eq`, `in`, `is`, `neq`) e NÃO imita a RLS: se a rota esquecer o
 * `.eq("organization_id", …)`, a linha da outra organização aparece e o teste de isolamento reprova.
 * Mede o handler, não o dublê. Simula as duas unicidades que as rotas tratam (`disparo_config` por
 * organização e `disparo_chips (organization_id, nome)`) devolvendo `23505`, e guarda cada escrita.
 */
import { randomUUID } from "node:crypto";

type Linha = Record<string, unknown>;
type Filtro = (l: Linha) => boolean;
export type Escrita = { tabela: string; tipo: "insert" | "update"; valores: Linha; linhas: number };

const UNICAS: Record<string, string[][]> = {
  disparo_config: [["organization_id"]],
  disparo_chips: [["id"], ["organization_id", "nome"]],
  // Agentes externos (migration 0256).
  external_agents: [["id"], ["organization_id", "nome"]],
  api_tokens: [["id"], ["token_hash"]],
  conversa_esperas_avisadas: [["conversation_id", "desde"]],
};

const PADROES: Record<string, () => Linha> = {
  external_agents: () => ({
    id: randomUUID(),
    tipo: "outro",
    avatar_url: null,
    papel: "admin",
    pode_motor: true,
    api_token_id: null,
    ultimo_uso_em: null,
    ultima_acao: null,
    revogado_em: null,
    created_at: new Date().toISOString(),
  }),
  api_tokens: () => ({ id: randomUUID(), revoked_at: null, expires_at: null, scopes: [] }),
  disparo_chips: () => ({
    id: randomUUID(),
    estado: "rampa",
    saude: "verde",
    dia_rampa: 1,
    pausado_ate: null,
    proximo_envio_em: null,
    saude_motivo: null,
    saude_calculada_em: null,
    envios_desde_pausa: 0,
  }),
  disparo_config: () => ({
    ligado: false,
    modo: "simulado",
    teto_diario: null,
    cadencia: "reativacao_3_toques",
    fonte_stage_id: null,
    ritmo: {},
    modelos: {},
    proibidos: [],
  }),
};

export function bancoDuble(inicial: Record<string, Linha[]> = {}) {
  const tabelas: Record<string, Linha[]> = {};
  for (const [t, ls] of Object.entries(inicial)) tabelas[t] = ls.map((l) => ({ ...l }));
  const escritas: Escrita[] = [];
  const linhas = (t: string) => (tabelas[t] ??= []);

  function consulta(tabela: string) {
    const filtros: Filtro[] = [];
    let operacao: { tipo: "select" } | { tipo: "update"; valores: Linha } | { tipo: "insert"; valores: Linha[] } = { tipo: "select" };
    let devolver = false;
    let contar = false;
    let limite: number | null = null;

    const executar = (): { data: unknown; error: unknown; count?: number | null } => {
      if (operacao.tipo === "insert") {
        const novas: Linha[] = [];
        for (const v of operacao.valores) {
          const nova = { ...(PADROES[tabela]?.() ?? {}), ...v };
          for (const chaves of UNICAS[tabela] ?? []) {
            const bate = (l: Linha) => chaves.every((k) => l[k] === nova[k]);
            if ([...linhas(tabela), ...novas].some(bate)) {
              return { data: null, error: { code: "23505", message: `duplicate key (${chaves.join(", ")})` } };
            }
          }
          novas.push(nova);
        }
        linhas(tabela).push(...novas);
        escritas.push({ tabela, tipo: "insert", valores: operacao.valores[0] ?? {}, linhas: novas.length });
        return { data: devolver ? novas.map((l) => ({ ...l })) : null, error: null };
      }
      const alvo = linhas(tabela).filter((l) => filtros.every((f) => f(l)));
      if (operacao.tipo === "update") {
        for (const l of alvo) Object.assign(l, operacao.valores);
        escritas.push({ tabela, tipo: "update", valores: operacao.valores, linhas: alvo.length });
        return { data: devolver ? alvo.map((l) => ({ ...l })) : null, error: null };
      }
      const recorte = limite === null ? alvo : alvo.slice(0, limite);
      return { data: contar ? null : recorte.map((l) => ({ ...l })), error: null, count: contar ? alvo.length : null };
    };

    const b = {
      select(_colunas?: string, opcoes?: { count?: string; head?: boolean }) {
        if (operacao.tipo !== "select") devolver = true;
        if (opcoes?.head) contar = true;
        return b;
      },
      insert(v: Linha | Linha[]) {
        operacao = { tipo: "insert", valores: Array.isArray(v) ? v : [v] };
        return b;
      },
      update(v: Linha) {
        operacao = { tipo: "update", valores: v };
        return b;
      },
      /** Só como INSERT (sem resolver conflito): basta para quem conta o que foi gravado. */
      upsert(v: Linha | Linha[]) {
        operacao = { tipo: "insert", valores: Array.isArray(v) ? v : [v] };
        return b;
      },
      eq(c: string, v: unknown) {
        filtros.push((l) => l[c] === v);
        return b;
      },
      not(c: string, op: string, v: unknown) {
        // Só a forma que as rotas usam: `.not(coluna, "is", null)`.
        if (op !== "is") throw new Error(`dublê: .not(${op}) não suportado`);
        filtros.push((l) => (l[c] ?? null) !== v);
        return b;
      },
      neq(c: string, v: unknown) {
        filtros.push((l) => l[c] !== v);
        return b;
      },
      in(c: string, vs: unknown[]) {
        filtros.push((l) => vs.includes(l[c]));
        return b;
      },
      gte(c: string, v: string) {
        filtros.push((l) => typeof l[c] === "string" && (l[c] as string) >= v);
        return b;
      },
      gt(c: string, v: string) {
        filtros.push((l) => typeof l[c] === "string" && (l[c] as string) > v);
        return b;
      },
      lt(c: string, v: string) {
        filtros.push((l) => typeof l[c] === "string" && (l[c] as string) < v);
        return b;
      },
      is(c: string, v: unknown) {
        filtros.push((l) => (l[c] ?? null) === v);
        return b;
      },
      order() {
        return b;
      },
      limit(n: number) {
        limite = n;
        return b;
      },
      async maybeSingle() {
        const r = executar();
        const lista = (r.data as Linha[] | null) ?? [];
        return { data: lista[0] ?? null, error: r.error };
      },
      async single() {
        const r = executar();
        const lista = (r.data as Linha[] | null) ?? [];
        return { data: lista[0] ?? null, error: r.error ?? (lista.length === 1 ? null : { code: "PGRST116", message: "not one row" }) };
      },
      then<R>(ok: (r: { data: unknown; error: unknown; count?: number | null }) => R, erro?: (e: unknown) => R) {
        return Promise.resolve(executar()).then(ok, erro);
      },
    };
    return b;
  }

  /** Chamadas de RPC (`emit_event`…): guardadas para o teste conferir o evento, sempre sem erro. */
  const rpcs: { nome: string; args: Record<string, unknown> }[] = [];
  return {
    cliente: {
      from: (tabela: string) => consulta(tabela),
      rpc: async (nome: string, args: Record<string, unknown>) => {
        rpcs.push({ nome, args });
        return { data: null, error: null };
      },
    },
    rpcs,
    tabelas,
    escritas,
    linhas,
  };
}
