/**
 * O MOTOR DE DISPARO PELA TELA — o caminho de quem acabou de instalar, sem SQL:
 *
 *   organização sem motor → "Criar o motor" → "Usar no motor" numa conexão → escolher a etapa dos leads →
 *   escrever a abertura → mudar um intervalo na gaveta Personalizar → "Voltar ao recomendado" restaura →
 *   com o modo simulado, a volta do motor gera fila SIMULADA e nada sai para o WhatsApp.
 *
 * Semente (pela service key do .env.local, só na organização das credenciais de e2e): apaga o motor da
 * organização (para começar "nova"), cria uma conexão WORKING sem servidor de WhatsApp atrás (o runner não tem
 * canal) e um lead na etapa escolhida. A volta do motor é chamada pelo cron com o INTERNAL_SECRET, como o
 * scheduler faz; com o modo simulado e `DISPARO_REAL_LIBERADO` ausente, o envio vira linha `simulado`.
 *
 * AINDA NÃO EXECUTADA (FORA_DO_CI em `.github/workflows/e2e.yml`, com o motivo): escrita numa sessão que não pode
 * subir servidor. Evidência em `.superpowers/evidence/motor-pela-tela/`.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), ".superpowers/evidence/motor-pela-tela");

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
const sufixo = Date.now().toString(36);
const NOME_DA_CONEXAO = `Chip e2e ${sufixo}`;
let etapaId = "";

async function login(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app/, { timeout: 60_000 });
}

async function captura(page: Page, nome: string): Promise<void> {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCIA, `${nome}.png`), fullPage: true });
}

test.beforeAll(async () => {
  creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
  const org = creds.org_id;

  // "Organização nova": sem motor, sem chips do motor e sem fila.
  await admin.from("disparo_envios").delete().eq("organization_id", org);
  await admin.from("disparo_chips").delete().eq("organization_id", org);
  await admin.from("disparo_config").delete().eq("organization_id", org);

  // Uma conexão de pé (o runner não tem WhatsApp: é só a linha que a tela lista como conectada).
  const { error: erroConexao } = await admin.from("channel_sessions").insert({
    organization_id: org,
    display_name: NOME_DA_CONEXAO,
    phone_number: `55119${String(Date.now()).slice(-8)}`,
    status: "WORKING",
    provider: "waha",
    engine: "NOWEB",
    waha_session_name: `e2e-motor-${sufixo}`,
    webhook_secret_encrypted: "e2e",
  });
  if (erroConexao) throw new Error(`semente da conexão: ${erroConexao.message}`);

  // A primeira etapa ativa do primeiro funil, com um lead dentro.
  const { data: etapa } = await admin
    .from("crm_stages")
    .select("id, pipeline_id")
    .eq("organization_id", org)
    .eq("is_archived", false)
    .order("position", { ascending: true })
    .limit(1)
    .single();
  if (!etapa) throw new Error("a organização de e2e não tem etapa ativa");
  etapaId = etapa.id;
  const { data: contato } = await admin
    .from("contacts")
    .insert({ organization_id: org, name: `Lead motor ${sufixo}`, phone_number: `55118${String(Date.now()).slice(-8)}` })
    .select("id")
    .single();
  await admin.from("crm_leads").insert({ organization_id: org, pipeline_id: etapa.pipeline_id, stage_id: etapa.id, contact_id: contato?.id, title: `Lead motor ${sufixo}` });
});

test.afterAll(async () => {
  await admin.from("channel_sessions").delete().eq("organization_id", creds.org_id).eq("waha_session_name", `e2e-motor-${sufixo}`);
});

test("organização nova monta o motor pela tela e o modo simulado não envia nada", async ({ page }) => {
  const gestor = Object.values(creds.users).find((u) => u.role === "admin") ?? Object.values(creds.users).find((u) => u.role === "manager")!;
  await login(page, gestor.email);
  await page.goto("/app/disparo");

  // 1. Criar o motor: nasce simulado e desligado.
  await page.getByRole("button", { name: "Criar o motor" }).click();
  await expect(page.getByText("Simulado · nada sai")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Escolha o ritmo" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Recomendado/ })).toHaveAttribute("aria-pressed", "true");
  await captura(page, "1-motor-criado");

  // 2. Usar a conexão no motor.
  const chips = page.locator("#chips");
  await chips.getByRole("listitem").filter({ hasText: NOME_DA_CONEXAO }).getByRole("button", { name: "Usar no motor" }).click();
  await expect(chips.getByRole("listitem", { name: NOME_DA_CONEXAO })).toContainText("dia 1 da rampa");

  // 3. Escolher a etapa dos leads.
  await page.locator("#etapa-de-origem").selectOption(etapaId);
  await expect(page.locator("#leads")).toContainText(/1 lead nesta etapa|\d+ leads nesta etapa/);

  // 4. Escrever a abertura (o verificador do motor roda ao vivo).
  const abertura = page.getByRole("textbox", { name: /Abertura, variação 1/ });
  await abertura.fill("{oi} tudo bem? Vi seu contato e queria te mostrar uma novidade.");
  await expect(page.locator("#mensagens").getByText("Não sai assim:")).toHaveCount(0);
  await page.getByRole("button", { name: "Salvar mensagens" }).click();
  await expect(page.locator("#mensagens").getByText("Salvo.")).toBeVisible();
  await captura(page, "2-chip-etapa-abertura");

  // 5. Mudar um intervalo na gaveta e salvar: o ritmo vira "Personalizado".
  await page.getByRole("button", { name: "Personalizar" }).click();
  await page.getByLabel("Chip em rampa (mínimo)").fill("25");
  await page.getByLabel("Chip em rampa (máximo)").fill("35");
  await page.getByRole("button", { name: "Salvar" }).click();
  await expect(page.getByText("Personalizado")).toBeVisible();
  await captura(page, "3-personalizado");

  // 6. "Voltar ao recomendado" daquela seção restaura o padrão, e o perfil volta a ser o Recomendado.
  await page.getByRole("button", { name: "Personalizar" }).click();
  await page.getByRole("button", { name: "Voltar ao recomendado: Intervalo entre conversas novas" }).click();
  await expect(page.getByLabel("Chip em rampa (mínimo)")).toHaveValue("10");
  await page.getByRole("button", { name: "Salvar" }).click();
  await expect(page.getByText("Personalizado")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Recomendado/ })).toHaveAttribute("aria-pressed", "true");

  // 7. Ligar o motor (simulado) e rodar uma volta pelo cron: fila simulada, nada real.
  await page.getByRole("button", { name: "Ligar o motor" }).click();
  await expect(page.getByRole("button", { name: "Pausar o motor" })).toBeVisible();
  const volta = await page.request.post("/api/v1/cron/disparo", {
    headers: { Authorization: `Bearer ${env.INTERNAL_SECRET}`, "X-Disparo-Agora": new Date().toISOString() },
  });
  expect(volta.ok()).toBe(true);

  const { data: envios } = await admin.from("disparo_envios").select("estado").eq("organization_id", creds.org_id);
  expect((envios ?? []).some((e) => e.estado === "enviado")).toBe(false);
  // A abertura pode não ter saído nesta volta (primeiro envio do dia sorteado); se saiu, saiu SIMULADA.
  for (const e of envios ?? []) expect(["pendente", "simulado", "cancelado"]).toContain(e.estado);
  await page.getByRole("tab", { name: "Fila" }).click();
  await captura(page, "4-fila-simulada");
});
