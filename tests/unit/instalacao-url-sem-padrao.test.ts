/**
 * `playwright.instalacao.config.ts` mede a instalação que o `scripts/instalar.*` deixou de pé. Ela CRIA conta
 * e organização no CRM que encontrar: se caísse num padrão (localhost:3000), numa máquina que já roda outro
 * sistema nessa porta, criaria conta nele. Sem `CRM_ALQUIMIA_URL` ela recusa; com o `.env.local` desta pasta
 * dizendo outra porta do app, também.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { urlDaInstalacao } from "@/scripts/lib/url-da-instalacao";

const pastas: string[] = [];
afterAll(() => {
  for (const p of pastas) rmSync(p, { recursive: true, force: true });
});
function pasta(envLocal?: string) {
  const dir = mkdtempSync(join(tmpdir(), "crm-url-"));
  pastas.push(dir);
  if (envLocal !== undefined) writeFileSync(join(dir, ".env.local"), envLocal);
  return dir;
}

describe("urlDaInstalacao", () => {
  it("sem CRM_ALQUIMIA_URL recusa (nunca cai em localhost:3000)", () => {
    expect(() => urlDaInstalacao({}, pasta())).toThrow(/CRM_ALQUIMIA_URL/);
    expect(() => urlDaInstalacao({ CRM_ALQUIMIA_URL: "  " }, pasta())).toThrow(/CRM_ALQUIMIA_URL/);
  });

  it("endereço que não é URL é recusado", () => {
    expect(() => urlDaInstalacao({ CRM_ALQUIMIA_URL: "localhost3100" }, pasta())).toThrow(/CRM_ALQUIMIA_URL/);
  });

  it("com a variável e sem .env.local, usa o que foi dado", () => {
    expect(urlDaInstalacao({ CRM_ALQUIMIA_URL: "http://localhost:3100/" }, pasta())).toBe("http://localhost:3100");
  });

  it("aponta para outra porta local que a do app desta instalação: recusa", () => {
    const dir = pasta(["CRM_ALQUIMIA_PROJETO=crm-alquimia", "CRM_ALQUIMIA_PORTA_APP=3100", ""].join("\n"));
    expect(() => urlDaInstalacao({ CRM_ALQUIMIA_URL: "http://localhost:3000" }, dir)).toThrow(/3100/);
    expect(() => urlDaInstalacao({ CRM_ALQUIMIA_URL: "http://127.0.0.1:3000" }, dir)).toThrow(/3100/);
  });

  it("a mesma porta do .env.local passa", () => {
    const dir = pasta("CRM_ALQUIMIA_PORTA_APP=3100\n");
    expect(urlDaInstalacao({ CRM_ALQUIMIA_URL: "http://localhost:3100" }, dir)).toBe("http://localhost:3100");
  });
});

describe("playwright.instalacao.config.ts", () => {
  const antes = process.env.CRM_ALQUIMIA_URL;
  afterEach(() => {
    if (antes === undefined) delete process.env.CRM_ALQUIMIA_URL;
    else process.env.CRM_ALQUIMIA_URL = antes;
    vi.resetModules();
  });

  it("sem CRM_ALQUIMIA_URL, carregar a config falha", async () => {
    delete process.env.CRM_ALQUIMIA_URL;
    vi.resetModules();
    await expect(import("../../playwright.instalacao.config")).rejects.toThrow(/CRM_ALQUIMIA_URL/);
  });

  it("com a variável, a baseURL é a dada", async () => {
    process.env.CRM_ALQUIMIA_URL = "http://localhost:3999";
    vi.resetModules();
    const config = (await import("../../playwright.instalacao.config")).default;
    expect(config.use?.baseURL).toBe("http://localhost:3999");
  });
});
