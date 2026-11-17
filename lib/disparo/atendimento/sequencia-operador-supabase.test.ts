// @vitest-environment node
/**
 * A trava atômica do agendamento (caso de exemplo): dois POSTs juntos passavam a checagem `emAberto` antes de
 * qualquer um gravar. O índice único parcial `disparo_envios_operador_em_aberto` (migration 0246) recusa o segundo
 * INSERT com 23505; o repositório o traduz para o 409 `ja_agendada` que o operador entende.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { ErroDaSequencia } from "./sequencia-operador";
import { repositorioSequenciaSupabase } from "./sequencia-operador-supabase";

const envio = {
  leadId: "l1", chipId: "c1", tipo: "funil_valores:1", texto: "oi", midiaId: null, midiaNome: null,
  enviarApos: new Date("2026-10-23T15:00:00Z"), presenca: "nenhuma" as const, presencaMs: 0, estado: "pendente" as const, motivo: null,
};

const db = (erro: { code: string; message: string } | null) =>
  ({ rpc: async () => ({ error: erro }) }) as unknown as SupabaseClient;

describe("enfileirar da sequência do operador", () => {
  it("traduz conflito de funil concorrente da RPC para ja_agendada", async () => {
    const banco = { rpc: async () => ({ error: { code: "P0001", message: "funil_em_andamento" } }) } as unknown as SupabaseClient;
    await expect(repositorioSequenciaSupabase(banco).enfileirar("org", [envio])).rejects.toMatchObject({ codigo: "ja_agendada", status: 409 });
  });
  it("23505 do índice único (outra sequência igual em aberto): ErroDaSequencia `ja_agendada` 409", async () => {
    const p = repositorioSequenciaSupabase(db({ code: "23505", message: "duplicate key value violates unique constraint \"disparo_envios_operador_em_aberto\"" })).enfileirar("org", [envio]);
    await expect(p).rejects.toBeInstanceOf(ErroDaSequencia);
    await expect(p).rejects.toMatchObject({ codigo: "ja_agendada", status: 409 });
  });

  it("irmão: sem erro, grava", async () => {
    await expect(repositorioSequenciaSupabase(db(null)).enfileirar("org", [envio])).resolves.toBeUndefined();
  });

  it("outro erro de banco continua sendo erro de banco", async () => {
    await expect(repositorioSequenciaSupabase(db({ code: "57014", message: "timeout" })).enfileirar("org", [envio])).rejects.not.toBeInstanceOf(ErroDaSequencia);
  });
});

describe("enfileirar grava a presença do passo", () => {
  it("presenca e presenca_ms vão para a linha da fila", async () => {
    const linhas: Record<string, unknown>[][] = [];
    const banco = { rpc: async (_nome: string, p: { p_linhas: Record<string, unknown>[] }) => (linhas.push(p.p_linhas), { error: null }) } as unknown as SupabaseClient;
    await repositorioSequenciaSupabase(banco).enfileirar("org", [{ ...envio, presenca: "gravando", presencaMs: 20000 }]);
    expect(linhas[0]?.[0]).toMatchObject({ presenca: "gravando", presenca_ms: 20000, origem: "operador" });
  });
});

describe("privacidade dos modelos do funil", () => {
  it("recusa na leitura um modelo pessoal dentro de funil compartilhado", async () => {
    const banco = { from: (t: string) => t === "operator_funnels"
      ? { select: () => ({ eq() { return this; }, or() { return this; }, limit: async () => ({ data: [{ id: "f", nome: "F", atalho: "ff", owner_user_id: null, operator_funnel_steps: [{ position: 1, template_id: "t", atraso_ms: 0, presenca: "nenhuma", presenca_ms: 0 }] }], error: null }) }) }
      : { select: () => ({ eq: () => ({ in: async () => ({ data: [{ id: "t", shortcut: null, title: "Privado", body: "segredo", owner_user_id: "u", media_id: null }], error: null }) }) }) } } as unknown as SupabaseClient;
    await expect(repositorioSequenciaSupabase(banco).funil("org", "u", { funnelId: "f" })).rejects.toThrow(/modelo pessoal/i);
  });
});
