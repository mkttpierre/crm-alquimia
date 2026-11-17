/**
 * Regras por organização na hora de escolher a próxima abertura (exemplo): o lead só
 * sai pelo chip dono dele, só nas classes de ataque e sem pendência do operador;
 * e o chip de base mais fria fica um degrau atrás na rampa. Sem a configuração, nada
 * muda (a organização B não usa).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { ritmoSchema } from "./config";
import { repositorioSupabase } from "./repositorio-supabase";
import { tetoAberturas, tetoTotal } from "./ritmo";

const ORG = "00000000-0000-4000-8000-0000000000f1";

function dbEspiao() {
  const chamadas: [string, ...unknown[]][] = [];
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "or", "order"]) b[m] = (...a: unknown[]) => (chamadas.push([m, ...a]), b);
  b["range"] = () => b;
  b["then"] = (ok: (r: unknown) => void) => ok({ data: [], error: null });
  return { db: { from: () => b } as unknown as SupabaseClient, chamadas };
}

describe("filtro da abertura", () => {
  it("sem filtro: nenhuma restrição em custom_fields", async () => {
    const { db, chamadas } = dbEspiao();
    await repositorioSupabase(db).proximoLeadParaAbertura(ORG, "st");
    expect(chamadas.some((c) => String(c[1]).startsWith("custom_fields"))).toBe(false);
  });

  it("com filtro: chip dono, classes e sem pendência do operador", async () => {
    const { db, chamadas } = dbEspiao();
    await repositorioSupabase(db).proximoLeadParaAbertura(ORG, "st", {
      chipOrigem: "chip-alfa",
      classes: ["A", "B", "C"],
      semPendenciaOperador: true,
      camposIguais: { d1_pronto: "true" },
    });
    expect(chamadas).toContainEqual(["eq", "custom_fields->>d1_pronto", "true"]);
    expect(chamadas).toContainEqual(["eq", "custom_fields->>chip_origem", "chip-alfa"]);
    expect(chamadas.filter((c) => c[0] === "eq" && c[1] === "custom_fields->>classe").map((c) => c[2])).toEqual(["A", "B", "C"]);
    expect(chamadas.find((c) => c[0] === "or")?.[1]).toContain("precisa_operador");
  });

  it("o schema do ritmo traz tudo desligado por padrão", () => {
    const r = ritmoSchema.parse({});
    expect(r.filtroAbertura).toEqual({ porChipOrigem: false, classes: [], semPendenciaOperador: false, camposIguais: {} });
    expect(r.chipsRampaAtrasada).toEqual([]);
  });
});

describe("rampa atrasada do chip de base mais fria", () => {
  const ritmo = ritmoSchema.parse({ chipsRampaAtrasada: ["chip-beta", "chip-gama"] });
  it("fica um degrau atrás da rampa e no máximo 50", () => {
    expect(tetoAberturas(4, ritmo, null, "chip-alfa")).toBe(17);
    expect(tetoAberturas(4, ritmo, null, "chip-beta")).toBe(14);
    expect(tetoAberturas(1, ritmo, null, "chip-gama")).toBe(10);
    expect(tetoAberturas(4, ritmo, null, "chip-beta")).toBeLessThanOrEqual(50);
  });
  it("o teto total acompanha", () => {
    expect(tetoTotal(4, ritmo, null, "chip-beta")).toBe(Math.round(14 * ritmo.fatorTotal) + ritmo.folgaTotal);
  });
  it("sem a lista, ninguém é atrasado", () => {
    expect(tetoAberturas(4, ritmoSchema.parse({}), null, "chip-beta")).toBe(17);
  });
});

describe("rampa própria por chip (chip frio)", () => {
  const propria = [3, 4, 5, 6, 8, 10, 12, 15, 18, 22, 26, 29, 32, 34, 36];
  const ritmo = ritmoSchema.parse({ rampasPorChip: { "chip-frio-2": propria } });
  it("o chip com rampa própria usa a dele, dia a dia", () => {
    expect(tetoAberturas(1, ritmo, null, "chip-frio-2")).toBe(3);
    expect(tetoAberturas(5, ritmo, null, "chip-frio-2")).toBe(8);
    expect(tetoAberturas(10, ritmo, null, "chip-frio-2")).toBe(22);
  });
  it("depois do fim da rampa própria, segura o último valor", () => {
    expect(tetoAberturas(99, ritmo, null, "chip-frio-2")).toBe(36);
  });
  it("os outros chips seguem a rampa da organização", () => {
    expect(tetoAberturas(1, ritmo, null, "chip-alfa")).toBe(10);
    expect(tetoAberturas(5, ritmo, null, "chip-alfa")).toBe(20);
  });
  it("o teto diário da organização ainda limita", () => {
    expect(tetoAberturas(10, ritmo, 15, "chip-frio-2")).toBe(15);
  });
  it("o teto total acompanha a rampa própria", () => {
    expect(tetoTotal(1, ritmo, null, "chip-frio-2")).toBe(Math.round(3 * ritmo.fatorTotal) + ritmo.folgaTotal);
  });
  it("rampa própria vence a rampa atrasada", () => {
    const r = ritmoSchema.parse({ chipsRampaAtrasada: ["chip-frio-2"], rampasPorChip: { "chip-frio-2": propria } });
    expect(tetoAberturas(1, r, null, "chip-frio-2")).toBe(3);
  });
  it("sem a configuração, ninguém tem rampa própria", () => {
    expect(ritmoSchema.parse({}).rampasPorChip).toEqual({});
  });
});
