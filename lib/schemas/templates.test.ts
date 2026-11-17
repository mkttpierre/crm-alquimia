import { describe, expect, it } from "vitest";

import { createTemplateSchema } from "./templates";

const MIDIA = "33333333-3333-4333-8333-333333333331";

describe("mensagem pronta: texto ou anexo", () => {
  it("áudio sem texto é uma mensagem válida (o áudio é a mensagem)", () => {
    expect(createTemplateSchema.safeParse({ title: "Áudio preço", body: "", media_id: MIDIA }).success).toBe(true);
  });

  it("sem texto e sem anexo é recusada", () => {
    expect(createTemplateSchema.safeParse({ title: "Vazia", body: "  " }).success).toBe(false);
  });

  it("texto sem anexo continua valendo", () => {
    expect(createTemplateSchema.safeParse({ title: "Oi", body: "Oi {{primeiro_nome}}" }).success).toBe(true);
  });
});
