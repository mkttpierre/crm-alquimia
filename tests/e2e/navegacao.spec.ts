/**
 * Navegação agrupada — prova pela TELA (DoD item 12).
 *
 * Os testes unitários provam que o registro e os componentes fazem o que
 * dizem. Isto prova o que o usuário reclamou: que dá para *achar* as coisas.
 * O caso que originou a mudança é o primeiro — chegar em Funis sem saber que
 * ele morava em Configurações.
 *
 * Pré-requisito: `.e2e-creds.json` (gerado por scripts/seed-e2e-credentials.ts).
 */
import { mkdirSync } from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "@playwright/test";

import { lerCreds, loginComoAdmin } from "./helpers/login-admin";
import { afirmarAdminDeTenantPuro } from "./utils/precondicao";

let creds = lerCreds();
const EVIDENCE = path.join(process.cwd(), ".superpowers", "evidence");

mkdirSync(EVIDENCE, { recursive: true });

// ── Precondição de identidade ────────────────────────────────────────────────
// O menu é `sidebarGroups(isPlatformAdmin, role)` (`registry.ts:510-519`), então
// a suspeita natural é que promover o `e2e-admin` a dono do servidor inflasse o
// sidebar que esta spec mede item a item.
//
// ⚠️ MEDIDO, e a suspeita não se confirma: `canSee` (`registry.ts:503-507`) é
// `isPlatformAdmin || ROLE_RANK[role] >= ROLE_RANK[minRole]`; `ROLE_RANK.admin`
// é 5, o TETO, e o maior `minRole` do registro é `"admin"`. Para um admin de
// tenant o menu é IDÊNTICO promovido ou não — as asserções de `toHaveText`
// abaixo não mudariam. Guardar a identidade aqui continua valendo (é a spec de
// navegação; qualquer destino futuro exclusivo do dono apareceria primeiro
// nela), mas registrar a diferença entre "muda" e "poderia mudar" é o ponto.
test.beforeAll(async () => {
  await afirmarAdminDeTenantPuro(creds.users.admin!.email);
});

async function login(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app\//);
}

async function loginAdmin(page: Page): Promise<void> {
  creds = await loginComoAdmin(page, creds);
}

const sidebar = (page: Page) => page.getByRole("navigation", { name: "Navegação principal" });

async function expectSemOverflowHorizontal(page: Page, contexto: string): Promise<void> {
  const m = await page.evaluate(() => ({
    // ⚠️ `body.scrollWidth`, NÃO `documentElement`. `app/globals.css` põe
    // `overflow-x: hidden` em `html` E em `body` (linhas 422 e 440), e sob isso
    // o `scrollWidth` do `documentElement` é GRAMPEADO no `clientWidth`: a
    // conta dá zero mesmo com um filho de 3000px dentro. Medido com o chromium
    // do repo, viewport 390x844, filho de 3000px — `visible` → 2610,
    // `hidden` → 0, e `body.scrollWidth` = 3000 nos DOIS casos.
    //
    // A asserção existia e era incapaz de falhar. Trocar a medida é o conserto;
    // o caso de sabotagem ao lado é o que prova que a nova consegue.
    scrollWidth: document.body.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));

  expect(
    m.scrollWidth,
    `${contexto}: documentElement.scrollWidth (${m.scrollWidth}) não pode passar do clientWidth (${m.clientWidth})`,
  ).toBeLessThanOrEqual(m.clientWidth + 1);
}

// `loginComoAdmin` espera a virada da janela TOTP entre logins consecutivos
// (o servidor recusa código repetido), e essa espera sozinha pode consumir os
// 30 s do teto global do playwright.config.ts. Toda spec da casa que usa o
// helper sobe o teto — 240 s em `agente-novo-e-uso`, `agente-papeis-operador`,
// `escopo-de-funil-do-agente` e `capacidades-do-agente`; 90 s em
// `prova-painel-provedores`. Esta era a única que faltava, e por isso dois
// testes que já estavam verdes passaram a estourar 30 s.
test.describe.configure({ timeout: 120_000 });

test.describe("navegação agrupada", () => {
  test("a barra tem hierarquia: os três blocos do protótipo A, na ordem", async ({ page }) => {
    await loginAdmin(page);

    // O primeiro bloco (o dia a dia) não tem título; depois vêm
    // Prospecção e Gestão. "Equipe agora" fica fora da <nav> (não é navegação).
    await expect(sidebar(page).getByRole("heading")).toHaveText(["Prospecção", "Gestão"]);
    const diaADia = sidebar(page).getByRole("region", { name: "Dia a dia" });
    await expect(diaADia.getByRole("link")).toHaveText([
      "Início",
      "Inbox",
      "Funis",
      "Leads",
      "Contatos",
      "Tarefas",
      "Agenda",
    ]);

    await page.screenshot({
      path: path.join(EVIDENCE, "nav-sidebar-agrupado.png"),
      fullPage: true,
    });
  });

  test("chega nas Etapas do funil pelo CRM, sem passar por Configurações", async ({ page }) => {
    await loginAdmin(page);

    // O caso que originou tudo: o usuário não sabia que esta tela existia.
    //
    // ⚠️ O ITEM MUDOU DE NOME, e o nome antigo ("Funis") passou para o VIZINHO —
    // a lista de funis, em /app/kanban. Um teste que continuasse clicando em
    // "Funis" seguiria verde medindo a outra tela; por isso a asserção de URL
    // abaixo é específica (`settings/tenant/pipelines`) e não o antigo
    // /pipelines/, que casa com as duas.
    //
    // ⚠️ E O CAMINHO MUDOU: com Tarefas (PR #546), o CRM chegou a cinco telas e
    // o menu passou a rolar em 900px. A resposta foi o hub do grupo, como o
    // comentário de densidade do `Sidebar.tsx` já mandava — então esta tela
    // agora mora atrás de "Ver tudo em CRM". Este teste percorre o caminho
    // INTEIRO em vez de checar um link: hub → tela.
    //
    // ⚠️ Na barra nova o hub do CRM mora no SUBMENU de Funis (a seta
    // "Mais em Funis"), ao lado de "Etapas do funil". Que a porta existe é o
    // unitário `components/app/BarraLateral.test.tsx` que prende.
    await sidebar(page).getByRole("button", { name: "Mais em Funis" }).click();
    await sidebar(page).getByRole("link", { name: "Ver tudo em CRM" }).click();
    await page.waitForURL(/\/app\/crm$/);
    await expect(page.getByRole("heading", { name: "O dia a dia da venda" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Preparar a venda" })).toBeVisible();

    await page.screenshot({ path: path.join(EVIDENCE, "nav-hub-crm.png"), fullPage: true });

    await page.getByRole("link", { name: /Etapas do funil/ }).click();
    await page.waitForURL(/settings\/tenant\/pipelines/);
    await expect(page.getByRole("heading", { name: "Etapas do funil", level: 1 })).toBeVisible();
  });

  test("Produtos tem linha própria em Gestão, e continua no hub do CRM", async ({ page }) => {
    // Produtos VOLTOU para a barra (bloco Gestão, protótipo A). O hub
    // do CRM segue listando a tela — inventário não perde item.
    await loginAdmin(page);

    const gestao = sidebar(page).getByRole("region", { name: "Gestão" });
    await expect(gestao.getByRole("link", { name: "Produtos" })).toBeVisible();

    await sidebar(page).getByRole("button", { name: "Mais em Funis" }).click();
    await sidebar(page).getByRole("link", { name: "Ver tudo em CRM" }).click();
    await page.waitForURL(/\/app\/crm$/);
    await page
      .getByRole("main")
      .getByRole("link", { name: /Produtos/ })
      .click();
    await page.waitForURL(/\/app\/products/);
  });

  test("e a lista de funis é o item vizinho, com nome próprio", async ({ page }) => {
    await loginAdmin(page);
    await sidebar(page).getByRole("link", { name: "Funis", exact: true }).click();
    await page.waitForURL(/\/app\/kanban/);
    await expect(page.getByRole("heading", { name: "Funis", level: 1 })).toBeVisible();
  });

  test("chega em Conhecimento, que só existia atrás das abas de IA", async ({ page }) => {
    await loginAdmin(page);

    // "Agente de IA" abre um submenu na própria barra; a visão
    // geral do grupo (o hub) é o primeiro item dele.
    await sidebar(page).getByRole("button", { name: "Agente de IA" }).click();
    await sidebar(page).getByRole("link", { name: "Visão geral" }).click();
    await page.waitForURL(/\/app\/ai$/);

    // O hub organiza por jornada, não numa grade solta.
    await expect(page.getByRole("heading", { name: "Montar o agente" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Ensinar o agente" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Acompanhar o agente" })).toBeVisible();

    await page.screenshot({ path: path.join(EVIDENCE, "nav-hub-ia.png"), fullPage: true });

    await page.getByRole("link", { name: /Conhecimento/ }).click();
    await page.waitForURL(/knowledge\/sources/);
  });

  /**
   * O canal oficial saiu de Configurações no PR #105 e virou aba de Conexões.
   * A porta, portanto, é Conexões — que vive no bloco Prospecção da barra
   *e não mais como um card perdido em Configurações.
   */
  test("chega ao canal oficial por Conexões, não por Configurações", async ({ page }) => {
    await loginAdmin(page);

    await sidebar(page).getByRole("link", { name: "Conexões" }).click();
    await page.waitForURL(/\/app\/connections/);
    await expect(page.getByRole("tab", { name: /oficial/i })).toBeVisible();
  });

  test("o ⌘K acha o canal oficial por nome, mesmo sem tela própria", async ({ page }) => {
    await loginAdmin(page);

    // Ninguém procura por "Conexões" quando quer o número oficial da Meta —
    // procura por "oficial". A busca varre a descrição além do rótulo.
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByRole("combobox").fill("oficial");
    await expect(page.getByRole("option", { name: /Conexões/ })).toBeVisible();
  });

  test("⌘K abre, filtra e navega", async ({ page }) => {
    await loginAdmin(page);

    await page.keyboard.press("ControlOrMeta+k");
    const busca = page.getByRole("combobox");
    await expect(busca).toBeVisible();

    await busca.fill("conhec");
    await expect(page.getByRole("option", { name: /Conhecimento/ })).toBeVisible();

    await page.screenshot({ path: path.join(EVIDENCE, "nav-command-palette.png") });

    await page.keyboard.press("Enter");
    await page.waitForURL(/knowledge\/sources/);
  });

  /**
   * A REGRA MUDOU NA TAREFA 16, e o motivo está aqui para ninguém "consertar"
   * de volta. A barra antiga tinha de caber inteira em 900px porque era o único
   * lugar onde um grupo podia ficar escondido. A barra nova tem submenus (que
   * crescem quando abertos) e o bloco "Equipe agora" (que cresce com a equipe):
   * ela ROLA POR DENTRO. O que não pode acontecer é:
   *   1. a barra passar da altura da tela (aí quem rola é a página, e o rodapé
   *      com o usuário some);
   *   2. o rodapé (versão + usuário) sair da tela;
   *   3. um bloco ficar inalcançável — rolando a área da barra, todo título
   *      chega à vista.
   *
   * Medido por ferramenta, nunca a olho.
   */
  test("a barra cabe na tela, rola por dentro e nenhum bloco fica inalcançável", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await loginAdmin(page);

    const m = await page.evaluate(() => {
      const nav = document.querySelector('aside nav[aria-label="Navegação principal"]')!;
      const area = nav.parentElement!;
      const aside = nav.closest("aside")!;
      const usuario = aside.querySelector('button[aria-label="Menu do usuário"]')!;
      const altura = window.innerHeight;
      const rolagem = getComputedStyle(area).overflowY;
      area.scrollTop = area.scrollHeight;
      const r = area.getBoundingClientRect();
      const titulosFora = [...nav.querySelectorAll("h2")].filter((h) => {
        const b = h.getBoundingClientRect();
        return b.top < r.top - 1 || b.bottom > r.bottom + 1;
      }).length;
      area.scrollTop = 0;
      return {
        alturaDaBarra: aside.getBoundingClientRect().height,
        altura,
        rodapeDentro: usuario.getBoundingClientRect().bottom <= altura + 1,
        rolagem,
        titulosFora,
      };
    });

    expect(m.alturaDaBarra, "a barra não pode passar da altura da tela").toBeLessThanOrEqual(
      m.altura + 1,
    );
    expect(m.rodapeDentro, "o rodapé com o usuário tem de ficar na tela").toBe(true);
    expect(m.rolagem, "o que não cabe rola dentro da barra").toBe("auto");
    expect(
      m.titulosFora,
      "com a área rolada até o fim, os títulos de bloco seguem alcançáveis",
    ).toBe(0);
  });

  test.describe("mobile", () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test("em 390px, o sidebar vira gaveta e não cria overflow horizontal", async ({ page }) => {
      await loginAdmin(page);

      await expect(
        sidebar(page),
        "o sidebar desktop fica fora da árvore acessível no mobile",
      ).toHaveCount(0);
      await expectSemOverflowHorizontal(page, "shell mobile após login");

      await page.getByRole("button", { name: "Mostrar ou esconder o menu" }).click();
      await expect(sidebar(page)).toBeVisible();
      await expectSemOverflowHorizontal(page, "shell mobile com drawer aberto");
      await page.screenshot({
        path: path.join(EVIDENCE, "nav-mobile-390-drawer-aberta.png"),
        fullPage: true,
      });

      await sidebar(page).getByRole("link", { name: "Funis", exact: true }).click();
      await page.waitForURL(/\/app\/kanban/);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expectSemOverflowHorizontal(page, "shell mobile após navegar pelo drawer");

      await page.screenshot({
        path: path.join(EVIDENCE, "nav-mobile-390-sem-overflow.png"),
        fullPage: true,
      });
    });
  });

  test("Configurações aparece sem rolar num notebook comum (1280×768)", async ({ page }) => {
    // Antes, Configurações morava num rodapé fixo, fora da área que
    // rola. Na barra nova ela é a última linha de Gestão; o que se cobra é o que
    // importava: estar à vista sem rolar no notebook comum.
    await page.setViewportSize({ width: 1280, height: 768 });
    await loginAdmin(page);

    const config = sidebar(page).getByRole("button", { name: "Configurações" });
    await expect(config).toBeVisible();
    const caixa = await config.boundingBox();
    expect(caixa, "Configurações renderizada").not.toBeNull();
    expect(caixa!.y + caixa!.height, "Configurações dentro da dobra de 768px").toBeLessThanOrEqual(
      768,
    );
  });

  test("um agent não vê o que a permissão tira, e nenhum título sobra vazio", async ({ page }) => {
    await login(page, creds.users.agent!.email);

    // Disparo (manager) e Conexões (admin) somem; Atalhos fica, então o título
    // "Prospecção" continua com conteúdo.
    await expect(sidebar(page).getByRole("link", { name: "Disparo" })).toHaveCount(0);
    await expect(sidebar(page).getByRole("link", { name: "Conexões" })).toHaveCount(0);
    await expect(sidebar(page).getByRole("link", { name: "Atalhos" })).toBeVisible();
    const vazios = await page.evaluate(
      () =>
        [
          ...document.querySelectorAll('aside nav[aria-label="Navegação principal"] section'),
        ].filter((s) => s.querySelectorAll("li").length === 0).length,
    );
    expect(vazios, "bloco com título e nenhuma linha").toBe(0);
  });
});
