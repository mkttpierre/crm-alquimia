import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * A VIEW `ai_provider_credentials_safe` SÓ PODE CRESCER NO FIM, EM TODO O BASELINE.
 *
 * `create or replace view` aceita acrescentar colunas no fim e recusa tirar ou
 * reordenar ("cannot drop columns from view"). O `baseline.sql` recria esta view
 * em vários pontos (o trecho do dump e um apêndice por migration que mexeu nela:
 * 0259, 0260…), e o `install.sh` roda com ON_ERROR_STOP: se qualquer recriação
 * trouxer uma lista MAIS CURTA do que a que já está de pé, a instalação nova
 * para ali — e o update, na segunda passada, deixa de aplicar o resto do arquivo.
 * Foi exatamente o que a revisão da 0260 achou: o apêndice da 0259 recriava a
 * view sem `base_url` depois de o dump já tê-la criado com ela.
 *
 * Este teste dispensa Postgres: compara, na ORDEM EM QUE APARECEM no arquivo, as
 * colunas de cada `create or replace view`. Cada lista tem de ser PREFIXO da
 * seguinte (ou igual) — isto é, nunca encolher — e a última tem de ser a da
 * migration mais recente que a mudou.
 */

const NOME = "ai_provider_credentials_safe";

/** As colunas de cada `create or replace view <NOME>` do texto, na ordem em que aparecem. */
function listasDeColunas(sql: string): string[][] {
  const achados: string[][] = [];
  const re = new RegExp(
    `create\\s+or\\s+replace\\s+view\\s+"?public"?\\."?${NOME}"?[\\s\\S]*?\\bselect\\b([\\s\\S]*?)\\bfrom\\b`,
    "gi",
  );
  for (const m of sql.matchAll(re)) {
    achados.push(
      (m[1] ?? "")
        .split(",")
        .map((c) => c.replace(/["\s]/g, ""))
        .filter((c) => c !== ""),
    );
  }
  return achados;
}

const baseline = listasDeColunas(readFileSync("supabase/baseline.sql", "utf8"));
const m0259 = listasDeColunas(
  readFileSync("supabase/migrations/20261116030000_0259_credencial_guarda_modelos_com_ferramentas.sql", "utf8"),
);
const m0260 = listasDeColunas(
  readFileSync("supabase/migrations/20261116040000_0260_credencial_ollama_sem_chave.sql", "utf8"),
);

const ehPrefixo = (curta: string[], longa: string[]) =>
  curta.length <= longa.length && curta.every((c, i) => longa[i] === c);

describe("baseline.sql: a view de credenciais nunca encolhe", () => {
  it("controle positivo: a sonda enxerga as recriações (dump, 0259 e 0260)", () => {
    expect(baseline.length).toBeGreaterThanOrEqual(3);
    expect(m0259).toHaveLength(1);
    expect(m0260).toHaveLength(1);
    expect(baseline[0]).toContain("id");
  });

  it("cada recriação é prefixo da seguinte — senão install/update dão 'cannot drop columns'", () => {
    for (let i = 0; i + 1 < baseline.length; i++) {
      expect(
        ehPrefixo(baseline[i]!, baseline[i + 1]!),
        `a recriação #${i + 1} da view (${baseline[i]!.join(", ")}) não é prefixo da #${i + 2} (${baseline[i + 1]!.join(", ")})`,
      ).toBe(true);
    }
  });

  it("a última recriação é a lista da migration mais recente (0260)", () => {
    expect(baseline[baseline.length - 1]).toEqual(m0260[0]);
  });

  it("a 0260 só ACRESCENTA ao fim da lista da 0259", () => {
    expect(ehPrefixo(m0259[0]!, m0260[0]!)).toBe(true);
    expect(m0260[0]!.length).toBeGreaterThan(m0259[0]!.length);
  });

  it("a sonda reprova o defeito que a revisão achou (lista que encolhe depois de crescer)", () => {
    const curta = ["id", "models_tools"];
    const longa = ["id", "models_tools", "base_url"];
    expect(ehPrefixo(longa, curta)).toBe(false);
    expect(ehPrefixo(curta, longa)).toBe(true);
  });
});
