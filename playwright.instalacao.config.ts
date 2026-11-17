import { defineConfig } from "@playwright/test";

import { urlDaInstalacao } from "./scripts/lib/url-da-instalacao";

/**
 * Playwright para a spec da INSTALAÇÃO NOVA (`tests/e2e/instalacao-nova.spec.ts`).
 *
 * Diferente da `playwright.config.ts` da suíte, esta NÃO sobe servidor nem lê `.env.e2e`: ela mede a
 * instalação que o `scripts/instalar.*` deixou de pé, em `CRM_ALQUIMIA_URL`. SEM PADRÃO de propósito: a spec
 * cria conta e organização no CRM que encontrar, e `localhost:3000` pode ser outro sistema nesta máquina.
 * Sem a variável (ou com uma porta local diferente da `CRM_ALQUIMIA_PORTA_APP` do `.env.local`) recusa. Uso:
 *
 *   CRM_ALQUIMIA_URL=http://localhost:3100 pnpm exec playwright test -c playwright.instalacao.config.ts
 */
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: /instalacao-nova\.spec\.ts$/,
  timeout: 240_000,
  workers: 1,
  retries: 0,
  use: {
    baseURL: urlDaInstalacao(process.env, __dirname),
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
