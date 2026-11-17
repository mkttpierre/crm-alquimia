/**
 * TRAVA do atendimento. O atendimento não conhece canal: o que ele decide vira
 * fila (`disparo_envios`) e aviso na Central. Este teste prova, em TODAS as
 * combinações travadas de modo × DISPARO_REAL_LIBERADO, que:
 *   1. nenhum adapter de canal é pedido (`getAdapter` espionado) e nenhum
 *      `fetch` sai (sem chave do Jev);
 *   2. toda resposta nasce `simulado`;
 *   3. nenhum arquivo do atendimento importa `lib/channels` (a única porta
 *      para o canal continua sendo `lib/disparo/envio-real.ts`, do motor).
 * E, na única combinação aberta, a resposta nasce `pendente` — para o motor,
 * que confere a trava de novo — e mesmo assim nada fala com canal aqui.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getAdapter = vi.fn(() => {
  throw new Error("o atendimento pediu um adapter de canal");
});
vi.mock("@/lib/channels", () => ({ getAdapter, resolveSessionRef: vi.fn(), CHANNEL_SESSION_REF_COLUMNS: "" }));

import { CONFIG_PROSPECCAO_EXEMPLO, CONFIG_VENDA_EXEMPLO, configDisparoExemplo, RepositorioEmMemoria } from "./apoio-de-teste";
import { atenderMensagem } from "./atendimento";
import { criarJulgar } from "./jev";

const ORG = "33333333-3333-4333-8333-333333333333";
const AGORA = new Date("2026-10-14T13:00:00Z");
const fetchEspiao = vi.fn();

beforeEach(() => {
  getAdapter.mockClear();
  fetchEspiao.mockClear();
  vi.stubGlobal("fetch", fetchEspiao);
});
afterEach(() => vi.unstubAllGlobals());

const MODOS = ["simulado", "real"] as const;
const AMBIENTES: Record<string, string | undefined>[] = [
  {},
  { DISPARO_REAL_LIBERADO: "" },
  { DISPARO_REAL_LIBERADO: "true" },
  { DISPARO_REAL_LIBERADO: "1" },
  { DISPARO_REAL_LIBERADO: "SIM" },
  { DISPARO_REAL_LIBERADO: " sim" },
  { DISPARO_REAL_LIBERADO: "sim" },
];
const MENSAGENS = ["Quero sim", "Quanto custa?", "achei caro", "quero o de 12 meses", "isso é golpe?", "vou pensar", "me manda o site"];

describe("trava: o atendimento nunca chama o canal", () => {
  for (const modo of MODOS) {
    for (const ambiente of AMBIENTES) {
      const aberta = modo === "real" && ambiente.DISPARO_REAL_LIBERADO === "sim";
      it(`modo ${modo}, DISPARO_REAL_LIBERADO=${JSON.stringify(ambiente.DISPARO_REAL_LIBERADO)}: ${aberta ? "pendente para o motor" : "tudo simulado"}`, async () => {
        for (const config of [CONFIG_VENDA_EXEMPLO, CONFIG_PROSPECCAO_EXEMPLO]) {
          const repo = new RepositorioEmMemoria(ORG, configDisparoExemplo(ORG, modo), config);
          for (const [i, texto] of MENSAGENS.entries()) {
            const lead = repo.novoLead(`l${i}`, { campos: { codigo: "C1" } });
            repo.chipPorLead.set(lead.id, "chip-x");
            const r = await atenderMensagem({ repo, agora: AGORA, ambiente, julgar: criarJulgar({ chave: null }) }, ORG, lead.id, {
              chave: `${modo}-${i}`,
              messageId: null,
              texto,
              midia: false,
            });
            expect(r.modo).toBe(aberta ? "real" : "simulado");
          }
          expect(repo.envios.length).toBeGreaterThan(0);
          expect(repo.envios.every((e) => e.estado === (aberta ? "pendente" : "simulado"))).toBe(true);
          if (!aberta) expect(repo.envios.every((e) => e.motivo?.startsWith("atendimento simulado"))).toBe(true);
        }
        expect(getAdapter).not.toHaveBeenCalled();
        expect(fetchEspiao).not.toHaveBeenCalled();
      });
    }
  }

  it("nenhum arquivo do atendimento importa lib/channels nem o envio real", () => {
    const dir = join(process.cwd(), "lib", "disparo", "atendimento");
    for (const arq of readdirSync(dir).filter((a) => a.endsWith(".ts") && !a.endsWith(".test.ts"))) {
      const fonte = readFileSync(join(dir, arq), "utf8");
      expect(fonte, arq).not.toMatch(/from\s+["'](@\/lib\/channels|\.\.\/\.\.\/channels)/);
      expect(fonte, arq).not.toMatch(/envio-real/);
    }
  });
});
