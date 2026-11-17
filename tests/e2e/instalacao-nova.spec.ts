/**
 * E2E: a INSTALAÇÃO NOVA, como uma pessoa leiga a vive.
 *
 * Jornada: cadastro (sem e-mail de confirmação) -> onboarding -> tela de Conexões -> "Conectar novo
 * WhatsApp" -> o QR da Evolution local aparece.
 *
 * ─── QUEM A EXECUTA ─────────────────────────────────────────────────────────
 * A prova de instalação nova, numa pasta limpa, com Docker: depois de o instalador deixar tudo de pé.
 *
 * ─── Como rodar ─────────────────────────────────────────────────────────────
 * Ela NÃO sobe servidor: mede a instalação que o instalador deixou de pé. Por isso tem config própria
 * (a `playwright.config.ts` da suíte sobe o `next start` com o banco de teste e exigiria outra porta):
 *
 *   bash scripts/instalar.sh                       # (ou scripts\instalar.ps1) instala e sobe tudo
 *   CRM_ALQUIMIA_URL=http://localhost:3000 \
 *     pnpm exec playwright test -c playwright.instalacao.config.ts
 *
 * Precisa de uma conta NOVA a cada execução (o e-mail é aleatório). A Evolution é a de verdade: o QR é
 * o que ela devolve, então a spec confere que a imagem tem o tamanho de um QR e que o servidor respondeu
 * (não confere o conteúdo do código: ele muda a cada ~20 s e só vale para o WhatsApp de quem o lê).
 *
 * ─── O que prova, e o que não prova ─────────────────────────────────────────
 * Prova: nenhum e-mail para confirmar; a organização nasce no cadastro; o onboarding é percorrível sem
 * WAHA nem chave de IA; a conexão por QR passa pela Evolution do compose, com o webhook global.
 * NÃO prova: o pareamento (exige um aparelho), o envio nem a chegada de mensagem.
 */
import { randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

const SENHA = "InstalacaoNova!2026#Qa";
const NOME_DA_EMPRESA = "Empresa de Teste da Instalacao";

test.describe.configure({ mode: "serial", timeout: 240_000 });

/** Passos do onboarding que a instalação nova mostra, todos puláveis. */
async function percorrerOnboardingPulando(page: Page): Promise<void> {
  // 1. Boas-vindas: o nome da empresa vem do cadastro; falta aceitar os termos.
  await expect(page).toHaveURL(/\/onboarding\/welcome/, { timeout: 40_000 });
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Continuar" }).click();

  // 2..N. Cada passo seguinte tem um "Pular" (por enquanto). Para no "Tudo pronto!".
  for (let passo = 0; passo < 8; passo++) {
    await page.waitForLoadState("networkidle");
    if (await page.getByRole("heading", { name: "Tudo pronto!" }).isVisible().catch(() => false)) return;
    const pular = page.getByRole("button", { name: /^Pular( por enquanto)?$/ }).first();
    const continuar = page.getByRole("button", { name: /^Continuar sem publicar$/ }).first();
    if (await pular.isVisible().catch(() => false)) {
      await pular.click();
    } else if (await continuar.isVisible().catch(() => false)) {
      await continuar.click();
    } else {
      // passo sem botão de pular (ex.: já está pronto): dá um instante e tenta de novo
      await page.waitForTimeout(1_000);
    }
  }
  await expect(page.getByRole("heading", { name: "Tudo pronto!" })).toBeVisible({ timeout: 20_000 });
}

test("instalação nova: cadastro sem e-mail, onboarding, conexões e QR da Evolution", async ({ page }) => {
  const email = `instalacao-${randomUUID().slice(0, 8)}@exemplo.test`;

  // ── 1. Cadastro: sem confirmação de e-mail, a conta nasce pronta ───────────────────────────────
  await page.goto("/signup");
  await page.locator("#org_name").fill(NOME_DA_EMPRESA);
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(SENHA);
  await page.locator("#password_confirm").fill(SENHA);
  await page.getByRole("button", { name: /criar conta/i }).click();

  // Nada de "abra o e-mail": cai direto no onboarding, já com a organização criada.
  await expect(page).toHaveURL(/\/onboarding\/welcome/, { timeout: 60_000 });
  await expect(page.getByText(/Enviamos um link de confirmação/i)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: NOME_DA_EMPRESA })).toBeVisible();

  // ── 2. Onboarding: percorrível sem WAHA e sem chave de IA ──────────────────────────────────────
  await percorrerOnboardingPulando(page);
  await page.getByRole("button", { name: "Começar a usar" }).click();
  await expect(page).toHaveURL(/\/app\//, { timeout: 40_000 });

  // ── 3. Conexões: o botão vale (há servidor de QR) e não acusa "serviço não configurado" ────────
  await page.goto("/app/connections");
  await expect(page.getByRole("heading", { name: "Conexões" })).toBeVisible();
  await expect(page.getByText("O serviço do WhatsApp não está configurado.")).toHaveCount(0);
  const conectar = page.getByRole("button", { name: "Conectar novo WhatsApp" });
  await expect(conectar).toBeEnabled();

  // ── 4. "Conectar novo WhatsApp" -> o QR da Evolution local ─────────────────────────────────────
  const criada = page.waitForResponse(
    (r) => r.url().endsWith("/api/v1/channel-sessions") && r.request().method() === "POST",
    { timeout: 120_000 },
  );
  await conectar.click();
  const resposta = await criada;
  expect(resposta.status(), "a conexão deveria ser criada (201)").toBe(201);
  const corpo = (await resposta.json()) as { data: { id: string; provider: string } };
  expect(corpo.data.provider).toBe("evolution");

  const qr = page.getByRole("img", { name: "QR Code para conectar WhatsApp" });
  await expect(qr, "o QR da Evolution não apareceu").toBeVisible({ timeout: 90_000 });

  // A imagem veio mesmo do servidor (PNG de verdade, do tamanho de um QR), não de um quadro vazio.
  const png = await page.request.get(`/api/v1/channel-sessions/${corpo.data.id}/qr`);
  expect(png.status()).toBe(200);
  expect(png.headers()["content-type"]).toContain("image/png");
  expect((await png.body()).byteLength).toBeGreaterThan(1_000);
});
