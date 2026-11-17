/**
 * A API da Nuvemshop pede User-Agent com o nome do app E um contato (e-mail ou URL). O padrão leva a URL do
 * projeto; a instalação põe o próprio contato em `NUVEMSHOP_USER_AGENT`.
 */
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_APP_NAME } from "@/lib/branding";

import { userAgentDaNuvemshop } from "./config";

const ANTES = process.env.NUVEMSHOP_USER_AGENT;
afterEach(() => {
  if (ANTES === undefined) delete process.env.NUVEMSHOP_USER_AGENT;
  else process.env.NUVEMSHOP_USER_AGENT = ANTES;
});

describe("userAgentDaNuvemshop", () => {
  it("sem a variável, leva nome do produto e uma URL de contato", () => {
    delete process.env.NUVEMSHOP_USER_AGENT;
    const ua = userAgentDaNuvemshop();
    expect(ua).toBe(`${DEFAULT_APP_NAME} (+https://github.com/mkttpierre/crm-alquimia)`);
    expect(ua).toMatch(/\(\+https?:\/\/[^)]+\)$/);
  });

  it("com a variável, usa o valor da instalação", () => {
    process.env.NUVEMSHOP_USER_AGENT = "Minha Loja CRM (contato@minhaloja.com.br)";
    expect(userAgentDaNuvemshop()).toBe("Minha Loja CRM (contato@minhaloja.com.br)");
  });

  it("variável só com espaços cai no padrão", () => {
    process.env.NUVEMSHOP_USER_AGENT = "   ";
    expect(userAgentDaNuvemshop()).toBe(`${DEFAULT_APP_NAME} (+https://github.com/mkttpierre/crm-alquimia)`);
  });
});
