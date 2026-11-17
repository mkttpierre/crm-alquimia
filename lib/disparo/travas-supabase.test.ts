// @vitest-environment node
/**
 * Trava com prazo sobre `disparo_travas` (A3/A5): a regra de "tomar" contra um cliente falso que imita o PostgREST.
 * O que só o Postgres prova (atomicidade do ON CONFLICT e do UPDATE com `ate < agora` sob disputa) fica para o
 * teste com banco; aqui vale a lógica: livre → toma; ocupada e no prazo → não toma; vencida → toma; sem tabela → livre.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { semTabela, soltarTrava, tomarTrava } from "./travas-supabase";

type Linha = { organization_id: string; chave: string; dono: string; ate: string };

/** Cliente mínimo: upsert(ignoreDuplicates).select, update().eq().eq().lt().select, delete().eq().eq().eq(). */
function clienteFalso(linhas: Linha[], erro: { code?: string; message: string } | null = null) {
  const db = {
    from: () => ({
      upsert: (l: Linha) => ({
        select: async () => {
          if (erro) return { data: null, error: erro };
          if (linhas.some((x) => x.organization_id === l.organization_id && x.chave === l.chave)) return { data: [], error: null };
          linhas.push({ ...l });
          return { data: [{ dono: l.dono }], error: null };
        },
      }),
      update: (patch: Partial<Linha>) => {
        const f: Record<string, string> = {};
        let antes = "";
        const q = {
          eq: (c: string, v: string) => ((f[c] = v), q),
          lt: (_c: string, v: string) => ((antes = v), q),
          select: async () => {
            const alvo = linhas.filter((x) => x.organization_id === f.organization_id && x.chave === f.chave && x.ate < antes);
            for (const x of alvo) Object.assign(x, patch);
            return { data: alvo.map((x) => ({ dono: x.dono })), error: null };
          },
        };
        return q;
      },
      delete: () => {
        const f: Record<string, string> = {};
        const q = {
          eq: (c: string, v: string) => {
            f[c] = v;
            if (Object.keys(f).length === 3) {
              const i = linhas.findIndex((x) => x.organization_id === f.organization_id && x.chave === f.chave && x.dono === f.dono);
              if (i >= 0) linhas.splice(i, 1);
              return Promise.resolve({ error: null });
            }
            return q;
          },
        };
        return q;
      },
    }),
  };
  return db as unknown as SupabaseClient;
}

const ORG = "org-1";
const AGORA = new Date("2026-10-26T12:00:00Z");

describe("trava com prazo", () => {
  it("livre: toma", async () => {
    const linhas: Linha[] = [];
    expect(await tomarTrava(clienteFalso(linhas), ORG, "chip:a", "volta-1", 60_000, AGORA)).toBe(true);
    expect(linhas[0]!.dono).toBe("volta-1");
  });

  it("ocupada e no prazo: a outra volta NÃO toma", async () => {
    const linhas: Linha[] = [{ organization_id: ORG, chave: "chip:a", dono: "volta-1", ate: new Date(AGORA.getTime() + 30_000).toISOString() }];
    expect(await tomarTrava(clienteFalso(linhas), ORG, "chip:a", "volta-2", 60_000, AGORA)).toBe(false);
    expect(linhas[0]!.dono).toBe("volta-1");
  });

  it("vencida (quem tomou morreu): a próxima toma", async () => {
    const linhas: Linha[] = [{ organization_id: ORG, chave: "chip:a", dono: "volta-morta", ate: new Date(AGORA.getTime() - 1).toISOString() }];
    expect(await tomarTrava(clienteFalso(linhas), ORG, "chip:a", "volta-2", 60_000, AGORA)).toBe(true);
    expect(linhas[0]!.dono).toBe("volta-2");
  });

  it("soltar só solta a trava do próprio dono", async () => {
    const linhas: Linha[] = [{ organization_id: ORG, chave: "chip:a", dono: "volta-2", ate: AGORA.toISOString() }];
    await soltarTrava(clienteFalso(linhas), ORG, "chip:a", "volta-1");
    expect(linhas).toHaveLength(1);
    await soltarTrava(clienteFalso(linhas), ORG, "chip:a", "volta-2");
    expect(linhas).toHaveLength(0);
  });

  it("tabela ainda não criada (código no ar antes da migration): a trava fica livre, como antes dela", async () => {
    expect(semTabela({ code: "42P01", message: 'relation "disparo_travas" does not exist' })).toBe(true);
    expect(semTabela({ code: "PGRST205", message: "Could not find the table 'public.disparo_travas' in the schema cache" })).toBe(true);
    expect(semTabela({ code: "57014", message: "canceling statement due to statement timeout" })).toBe(false);
    expect(await tomarTrava(clienteFalso([], { code: "PGRST205", message: "x" }), ORG, "chip:a", "v", 1000, AGORA)).toBe(true);
    await expect(tomarTrava(clienteFalso([], { code: "57014", message: "timeout" }), ORG, "chip:a", "v", 1000, AGORA)).rejects.toThrow(/timeout/);
  });
});
