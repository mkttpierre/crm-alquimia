// @vitest-environment node
/**
 * O id do evento que gravamos no Google sai de DOIS lados: o SQL da reserva (que carimba
 * `google_event_id` antes da ida ao Google) e o TS que reconhece o evento na volta
 * (`idDeEventoDoGoogle` / `ehEventoNosso`, derivados de `SUFIXO_ICAL_UID`). Se alguém trocar o
 * sufixo só num lado, os eventos já gravados deixam de ser reconhecidos, sem erro nenhum: viram
 * compromisso fantasma ocupando horário.
 *
 * O invariante com banco (`tests/invariants/agenda-google-reconciliacao.test.ts`) prova o mesmo
 * de ponta a ponta, mas só roda com Postgres. Este lê os arquivos de SQL e compara o literal
 * com a constante, sem banco.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { idDeEventoDoGoogle } from "@/lib/agenda/google/escrita";
import { SUFIXO_ICAL_UID } from "@/lib/agenda/google/evento";

const RAIZ = path.resolve(__dirname, "../..");

/** Os arquivos que definem a função da reserva, e quantas vezes cada um grava o id. */
const ARQUIVOS: ReadonlyArray<[string, number]> = [
  ["supabase/baseline.sql", 2],
  ["supabase/migrations/20260907010000_0225_google_reconciliacao.sql", 1],
  ["supabase/migrations/20260907020000_0226_meet_e_entrega_transacional.sql", 1],
];

/** `google_event_id=regexp_replace('<sufixo>','[^a-v0-9]','','g')||replace(id::text,'-','')` */
const GRAVACAO = /google_event_id\s*=\s*regexp_replace\('([^']*)','\[\^a-v0-9\]','','g'\)\|\|replace\(id::text,'-',''\)/g;
/** Gravação do id com prefixo escrito no SQL (literal ou derivado): nenhuma pode escapar da forma acima. */
const QUALQUER_GRAVACAO = /google_event_id\s*=\s*(?:'|regexp_replace\b)/gi;

describe("sufixo do evento do Google: o mesmo no SQL e no TS", () => {
  for (const [arquivo, vezes] of ARQUIVOS) {
    it(`${arquivo} grava o id a partir de SUFIXO_ICAL_UID`, () => {
      const sql = readFileSync(path.join(RAIZ, arquivo), "utf8");
      const sufixos = [...sql.matchAll(GRAVACAO)].map((m) => m[1]);
      expect(sufixos, `${arquivo}: esperava ${vezes} gravação(ões) do id no formato do TS`).toHaveLength(vezes);
      for (const s of sufixos) expect(s).toBe(SUFIXO_ICAL_UID);
      expect(sql.match(QUALQUER_GRAVACAO)?.length ?? 0, `${arquivo}: gravação do id fora do formato`).toBe(vezes);
    });
  }

  it("a regra do SQL dá o mesmo id que o TS", () => {
    // `regexp_replace(s, '[^a-v0-9]', '', 'g')` em JS, aplicado ao sufixo, mais o uuid sem hífen.
    const id = "22222222-2222-4222-8222-222222222222";
    const peloSql = SUFIXO_ICAL_UID.replace(/[^a-v0-9]/g, "") + id.replace(/-/g, "");
    expect(idDeEventoDoGoogle(id)).toBe(peloSql);
  });
});
