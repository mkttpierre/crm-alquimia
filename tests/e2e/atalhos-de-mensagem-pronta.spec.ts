import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "@playwright/test";

/**
 * ATALHOS DE MENSAGEM PRONTA — pela tela, como o operador faz.
 *
 * 1. Em Atalhos, cria uma mensagem e um funil "valores" com ela.
 * 2. Na conversa, digita "valores": a barra mostra o cartão do funil acima da caixa.
 * 3. Esc fecha a barra; digitar de novo a reabre.
 * 4. Clicar no cartão agenda o funil e limpa a caixa (o texto digitado nunca vai ao lead).
 *
 * O agendamento exige uma conversa que saia por chip do motor. Num ambiente sem chip semeado o clique responde
 * "não sai por um chip do motor" — o caso 4 aceita os dois desfechos e registra qual foi, sem fingir que mediu o envio.
 * O que sai no WhatsApp (ordem, intervalos, "gravando…") é prova manual com o número do operador, fora desta spec.
 */

interface E2ECreds {
  password: string;
  users: Record<string, { id: string; email: string; role: string }>;
}

const creds = JSON.parse(fs.readFileSync(path.join(process.cwd(), ".e2e-creds.json"), "utf8")) as E2ECreds;
const EVIDENCE = path.join(process.cwd(), ".superpowers/evidence/atalhos-de-mensagem-pronta");

async function login(page: Page): Promise<void> {
  const manager = Object.values(creds.users).find((u) => u.role === "manager") ?? Object.values(creds.users).find((u) => u.role === "agent")!;
  await page.goto("/login");
  await page.locator("#email").fill(manager.email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app\//);
}

test.describe("atalhos de mensagem pronta", () => {
  test("criar funil em Atalhos e achá-lo pela palavra no chat", async ({ page }) => {
    fs.mkdirSync(EVIDENCE, { recursive: true });
    await login(page);
    const sufixo = Date.now().toString(36);

    await page.goto("/app/templates");
    await page.getByRole("button", { name: /nova mensagem/i }).click();
    await page.locator("#tpl-title").fill(`Valores e2e ${sufixo}`);
    await page.locator("#tpl-body").fill("Vou te explicar os valores 👇");
    await page.getByRole("button", { name: /criar template/i }).click();
    await expect(page.getByText(`Valores e2e ${sufixo}`)).toBeVisible();

    await page.getByRole("tab", { name: "Funis" }).click();
    await page.getByRole("button", { name: /novo funil/i }).click();
    await page.getByLabel("Nome do funil").fill(`Funil valores ${sufixo}`);
    await page.getByLabel("Palavras que acham este funil no chat (separe por vírgula)").fill(`valores${sufixo}`);
    await page.getByRole("button", { name: /adicionar mensagem/i }).click();
    await page.getByLabel("Mensagem do passo 1").selectOption({ label: `Valores e2e ${sufixo}` });
    await page.screenshot({ path: path.join(EVIDENCE, "1-editor-de-funil.png") });
    await page.getByRole("button", { name: /salvar funil/i }).click();
    await expect(page.getByText(`Funil valores ${sufixo}`)).toBeVisible();

    await page.goto("/app/inbox");
    const conversa = page.locator("[data-conversation-id]").first();
    test.skip((await conversa.count()) === 0, "ambiente sem conversa: a barra não tem onde aparecer");
    await conversa.click();

    const caixa = page.getByLabel(/mensagem/i);
    await caixa.fill(`valores${sufixo}`);
    const cartao = page.getByRole("button", { name: new RegExp(`Funil valores ${sufixo}`) });
    await expect(cartao).toBeVisible();
    await page.screenshot({ path: path.join(EVIDENCE, "2-barra-no-chat.png") });

    await caixa.press("Escape");
    await expect(cartao).toBeHidden();
    await caixa.fill(`valores${sufixo} `);
    await expect(cartao).toBeVisible();

    await cartao.click();
    await expect(caixa).toHaveValue("");
    const resposta = page.getByText(/Funil agendado|Ensaio:|não sai por um chip do motor|Nada foi agendado/i).first();
    await expect(resposta).toBeVisible();
    await page.screenshot({ path: path.join(EVIDENCE, "3-depois-do-clique.png") });
  });
});
