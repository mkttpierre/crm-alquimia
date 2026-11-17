/**
 * VÍDEO E ÁUDIO PELO COMPOSER — pela tela, como o atendente faz.
 *
 * O dono relatou que vídeo e áudio pelo composer "não funcionam direito", e a correção de 05/11
 * nunca foi provada pela tela. Este spec dirige o browser logado e mede, em cada caso:
 *
 * 1. VÍDEO: anexar `tests/fixtures/midia/curto.mp4` pelo "+" → "Fotos e vídeos", escrever a legenda
 *    e enviar. O pedido de envio (`POST /api/v1/messages`) é INTERCEPTADO para ler o corpo
 *    (`type: "video"`, `media_mime: "video/mp4"`, legenda em `body`) e segue para o servidor;
 *    a bolha nova tem que aparecer com o player de vídeo apontando para a mídia DAQUELA mensagem.
 * 2. ÁUDIO: gravar com o microfone falso do Chromium (`--use-fake-device-for-media-stream`, que
 *    toca um bipe) e enviar. O corpo tem que dizer `type: "audio"` com um mime de áudio, e a bolha
 *    nova tem que trazer o player de voz.
 * 3. LIMITE: um vídeo acima de 16 MB é recusado NA TELA, antes de qualquer upload, com o limite
 *    escrito. A prova de "antes do upload" é que nenhum `POST .../media` sai do browser.
 *
 * O que NÃO prova: que o WhatsApp entregou. O canal da org de teste não está conectado, então o
 * envio fica em fila no servidor — o corpo exato que vai à Evolution é medido em
 * `lib/channels/evolution/envio-midia-composer.test.ts`, e a entrega real é o passo 5 da tarefa
 * (com o dono, no aparelho dele).
 *
 * Pré-requisitos (banco local, app buildada — NUNCA contra produção):
 *   pnpm exec tsx scripts/seed-e2e-credentials.ts
 *   pnpm e2e:env && pnpm e2e:build
 *   E2E_PORT=3021 pnpm exec playwright test tests/e2e/composer-midia.spec.ts
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test, type Page, type Request } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), ".superpowers/evidence/composer-midia");
const VIDEO_CURTO = path.join(process.cwd(), "tests/fixtures/midia/curto.mp4");

interface Creds {
  password: string;
  org_id: string;
  users: Record<string, { id: string; email: string; role: string }>;
}

const env = carregarEnvLocal();
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let creds: Creds;
let conversaId = "";

// Microfone falso: o Chromium entrega um bipe como se fosse a voz, e a permissão já vem concedida.
test.use({
  launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] },
  permissions: ["microphone"],
});

async function login(page: Page, email: string, senha: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(senha);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app/, { timeout: 60_000 });
}

async function captura(page: Page, nome: string): Promise<void> {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCIA, `${nome}.png`), fullPage: false });
}

interface CorpoDoEnvio {
  conversation_id: string;
  type: string;
  body?: string;
  media_storage_path?: string;
  media_mime?: string;
  media_size_bytes?: number;
}

/**
 * Intercepta o pedido de envio: guarda o corpo e deixa seguir para o servidor (a bolha que a tela
 * desenha é a linha que o servidor grava). Devolve uma promessa com o corpo e o id da mensagem.
 */
function interceptarEnvio(page: Page): Promise<{ corpo: CorpoDoEnvio; id: string }> {
  return new Promise((resolve, reject) => {
    let corpo: CorpoDoEnvio | null = null;
    void page.route("**/api/v1/messages", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      corpo = route.request().postDataJSON() as CorpoDoEnvio;
      const resposta = await route.fetch();
      const json = (await resposta.json().catch(() => null)) as { data?: { id?: string } } | null;
      await route.fulfill({ response: resposta, json });
      if (!json?.data?.id) reject(new Error(`envio sem id (HTTP ${resposta.status()}): ${JSON.stringify(json)}`));
      else resolve({ corpo: corpo!, id: json.data.id });
    });
  });
}

async function abrirComposer(page: Page): Promise<void> {
  await login(page, creds.users.agent!.email, creds.password);
  await page.goto(`/app/inbox/${conversaId}`);
  await expect(page.getByRole("button", { name: "Anexar" })).toBeEnabled({ timeout: 30_000 });
}

test.describe("Composer — vídeo e áudio", () => {
  test.describe.configure({ timeout: 180_000 });

  test.beforeAll(async () => {
    if (!fs.existsSync(CREDS_PATH)) {
      execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
    }
    creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;

    const { data: sessaoExistente } = await admin
      .from("channel_sessions")
      .select("id")
      .eq("organization_id", creds.org_id)
      .limit(1)
      .maybeSingle();
    let sessaoId = (sessaoExistente as { id: string } | null)?.id ?? null;
    if (!sessaoId) {
      const { data, error } = await admin
        .from("channel_sessions")
        .insert({
          organization_id: creds.org_id,
          waha_session_name: `e2e-composer-midia-${Date.now()}`,
          webhook_secret_encrypted: "e2e",
        })
        .select("id")
        .single();
      if (error) throw new Error(`channel_sessions: ${error.message}`);
      sessaoId = (data as { id: string }).id;
    }

    const { data: contato, error: erroContato } = await admin
      .from("contacts")
      .insert({
        organization_id: creds.org_id,
        display_name: `Composer Mídia ${Date.now()}`,
        phone_number: `+55119${String(Date.now()).slice(-8)}`,
      })
      .select("id")
      .single();
    if (erroContato) throw new Error(`contacts: ${erroContato.message}`);

    // Conversa que o cliente acabou de abrir: janela aberta, nada barrando a resposta.
    const agora = new Date().toISOString();
    const { data: conversa, error: erroConversa } = await admin
      .from("conversations")
      .insert({
        organization_id: creds.org_id,
        contact_id: (contato as { id: string }).id,
        channel_session_id: sessaoId,
        status: "open",
        last_message_preview: "Oi, me manda o vídeo?",
        last_message_at: agora,
        last_inbound_at: agora,
      })
      .select("id")
      .single();
    if (erroConversa) throw new Error(`conversations: ${erroConversa.message}`);
    conversaId = (conversa as { id: string }).id;
  });

  test("vídeo mp4 com legenda: sai como vídeo e a bolha traz o player de vídeo", async ({ page }) => {
    await abrirComposer(page);
    const envio = interceptarEnvio(page);

    await page.getByRole("button", { name: "Anexar" }).click();
    // O input vive fora do popover (AttachMenu): é o de "Fotos e vídeos", o que aceita `video/*`.
    await page.locator('input[type="file"][accept*="video/"]').setInputFiles(VIDEO_CURTO);

    const dialogo = page.getByRole("dialog", { name: "Enviar anexo" });
    await expect(dialogo).toBeVisible();
    await expect(dialogo.locator("video")).toHaveCount(1);
    await dialogo.getByLabel("Legenda").fill("Olha o vídeo");
    await captura(page, "1-video-preview");
    await dialogo.getByRole("button", { name: "Enviar" }).click();

    const { corpo, id } = await envio;
    expect(corpo).toMatchObject({ conversation_id: conversaId, type: "video", media_mime: "video/mp4", body: "Olha o vídeo" });
    expect(corpo.media_storage_path).toMatch(/\.mp4$/);
    expect(corpo.media_size_bytes).toBe(fs.statSync(VIDEO_CURTO).size);

    await expect(dialogo).toHaveCount(0);
    await expect(page.locator(`video[src="/api/v1/messages/${id}/media"]`)).toBeVisible({ timeout: 30_000 });
    await captura(page, "2-video-na-conversa");
  });

  test("áudio gravado no navegador: sai como áudio e a bolha traz o player de voz", async ({ page }) => {
    await abrirComposer(page);
    const envio = interceptarEnvio(page);

    await page.getByRole("button", { name: "Gravar áudio" }).click();
    await expect(page.getByRole("button", { name: "Cancelar gravação" })).toBeVisible();
    await page.waitForTimeout(2_000); // dois segundos de "voz"
    await captura(page, "3-audio-gravando");
    await page.getByRole("button", { name: "Enviar áudio" }).click();

    const { corpo, id } = await envio;
    expect(corpo).toMatchObject({ conversation_id: conversaId, type: "audio" });
    // O upload converte o webm do Chrome para ogg (voice-transcode); se o ffmpeg faltar, segue webm.
    expect(corpo.media_mime).toMatch(/^audio\/(ogg|webm)/);
    expect(corpo.body).toBeUndefined();

    await expect(page.locator(`audio[src="/api/v1/messages/${id}/media"]`)).toHaveCount(1, { timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Reproduzir áudio" }).last()).toBeVisible();
    await captura(page, "4-audio-na-conversa");
  });

  test("vídeo acima de 16 MB: recusado na tela, com o limite escrito, sem upload", async ({ page }) => {
    await abrirComposer(page);
    const uploads: Request[] = [];
    page.on("request", (r) => {
      if (r.method() === "POST" && /\/api\/v1\/conversations\/[^/]+\/media$/.test(r.url())) uploads.push(r);
    });

    await page.getByRole("button", { name: "Anexar" }).click();
    await page.locator('input[type="file"][accept*="video/"]').setInputFiles({
      name: "grande.mp4",
      mimeType: "video/mp4",
      buffer: Buffer.alloc(16 * 1024 * 1024 + 1),
    });

    await expect(page.getByText(/16 MB/)).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Enviar anexo" })).toHaveCount(0);
    await captura(page, "5-video-grande-recusado");
    expect(uploads, "o arquivo grande não podia ter subido").toHaveLength(0);
  });
});
