import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { MarcaDoProduto } from "@/components/app/MarcaDoProduto";
import type { ActiveOrg, AuthUser } from "@/lib/auth/types";
import { DEFAULT_APP_NAME, type Branding } from "@/lib/branding";
import { MarcaDaInstalacaoProvider } from "@/lib/branding/contexto";
import { resolverMarcaDaOrganizacao } from "@/lib/branding/organizacao";
import { marcaFoiConfigurada } from "@/lib/branding/resolve";

/**
 * O CONSUMIDOR do nome por organização — provado por comportamento, não por
 * símbolo.
 *
 * POR QUE ESTE ARQUIVO EXISTE: medido antes de escrever a feature, o nome da
 * organização não aparecia em lugar nenhum da casca para o cliente típico de um
 * revendedor — o único leitor era o `TenantSwitcher`, que devolve `null` com uma
 * organização só. Gravar `settings.branding.app_name` sem um leitor real teria
 * criado o campo decorativo clássico: a tela oferece, o código ignora, e o
 * cliente conclui que o produto está quebrado.
 *
 * Conferir que a Sidebar MENCIONA `activeOrg.marca` não bastaria — é evidência
 * de símbolo presente, não de comportamento presente. Os dois casos abaixo
 * medem o texto que a barra renderiza, com e sem a marca, e o segundo afirma
 * também a AUSÊNCIA do nome da instalação: sem isso, um componente que
 * mostrasse os dois passaria.
 */

/**
 * A marca da INSTALAÇÃO, como o SERVIDOR a entrega.
 *
 * ⚠️ Isto era um `vi.mock("@/lib/branding")` até a correção do hydration
 * mismatch. Não é mais: a barra deixou de chamar `branding()` — que lia
 * `window.__PUBLIC_ENV__` no navegador e `process.env` no SSR, fontes que
 * divergiram quando o layout raiz passou a injetar a marca do BANCO — e passou a
 * receber a marca por PROP, via `MarcaDaInstalacaoProvider`. Montar o provedor
 * aqui é o jeito honesto de simular "o operador gravou um logo na tela de
 * marca": deste lado da fronteira é exatamente o que o layout raiz faz.
 *
 * `logoUrl: null` no padrão porque com logo a barra mostra a imagem NO LUGAR do
 * texto — os três primeiros casos, que medem nome, não mediriam nada.
 */
let marcaDaInstalacao: Branding = {
  name: "Sistema do Revendedor",
  logoUrl: null,
  initial: "S",
};

/**
 * A marca da barra (`components/app/MarcaDoProduto.tsx`) como o
 * layout raiz a monta: dentro do provedor da marca. Este arquivo era
 * `sidebar-nome-da-organizacao.test.tsx` e media a `Sidebar` antiga; a barra
 * nova herdou a mesma regra e os mesmos casos.
 */
function renderSidebar(marcaPropria = true) {
  // `marcaPropria` chega resolvido do servidor (`marcaFoiConfigurada`, no layout
  // de /app). Nos casos de nome e logo, alguém configurou: `true`.
  return render(
    <MarcaDaInstalacaoProvider marca={marcaDaInstalacao}>
      <MarcaDoProduto marcaPropria={marcaPropria} />
    </MarcaDaInstalacaoProvider>,
  );
}

const usuario = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "admin@exemplo.test",
  is_platform_admin: false,
  organizations: [],
} as unknown as AuthUser;

const org = {
  orgId: "00000000-0000-4000-8000-0000000000aa",
  name: "Loja da Ana",
  role: "admin",
} as ActiveOrg;

let contexto: { user: AuthUser; activeOrg: ActiveOrg | null } = { user: usuario, activeOrg: org };
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => contexto,
}));

describe("o nome da marca na barra lateral", () => {
  it("sem marca da organização, mostra o nome da instalação", () => {
    // Não-regressão: a organização que nunca abriu a tela de marca precisa ver
    // exatamente o que via antes. É também a guarda de vacuidade do caso
    // seguinte — se a barra nunca mostrasse nome nenhum, os dois passariam.
    contexto = { user: usuario, activeOrg: org };
    renderSidebar();
    expect(screen.getByText("Sistema do Revendedor")).toBeTruthy();
  });

  it("com marca da organização, o nome dela SUBSTITUI o da instalação", () => {
    contexto = { user: usuario, activeOrg: { ...org, marca: { nome: "Loja da Ana" } } };
    renderSidebar();
    expect(screen.getByText("Loja da Ana")).toBeTruthy();
    // A ausência importa tanto quanto a presença: uma barra que mostrasse os
    // dois nomes passaria na asserção de cima e estaria errada.
    expect(screen.queryByText("Sistema do Revendedor")).toBeNull();
  });

  it("nada configurado: o padrão do produto é o sol e a escrita, legendados com o nome", () => {
    // A arte só aparece quando NINGUÉM definiu marca — o caso de fábrica. Ela
    // não pode tomar o lugar do nome de um revendedor (casos de cima).
    marcaDaInstalacao = { name: DEFAULT_APP_NAME, logoUrl: null, initial: "C" };
    contexto = { user: usuario, activeOrg: org };
    const { container } = renderSidebar(false);
    expect(container.querySelector('[data-marca="produto"]')).toBeTruthy();
    expect(screen.getByRole("img", { name: DEFAULT_APP_NAME })).toBeTruthy();
    expect(screen.getByText("CRM")).toBeTruthy();
    marcaDaInstalacao = { name: "Sistema do Revendedor", logoUrl: null, initial: "S" };
  });

  it("quem CONFIGUROU o mesmo texto do padrão vê o nome, não a arte (sem comparar string no cliente)", () => {
    marcaDaInstalacao = { name: DEFAULT_APP_NAME, logoUrl: null, initial: "C" };
    contexto = { user: usuario, activeOrg: org };
    const { container } = renderSidebar(true);
    expect(container.querySelector('[data-marca="nome"]')?.textContent).toBe(DEFAULT_APP_NAME);
    expect(container.querySelector('[data-marca="produto"]')).toBeNull();
    marcaDaInstalacao = { name: "Sistema do Revendedor", logoUrl: null, initial: "S" };
  });
});

describe("marcaFoiConfigurada — a resposta do servidor", () => {
  it("fábrica (nada no banco nem no .env) não é marca própria", () => {
    expect(marcaFoiConfigurada(resolverMarcaDaOrganizacao(null, null, {}))).toBe(false);
    // `.env` com a chave declarada e vazia é o estado que a instalação deixa.
    expect(marcaFoiConfigurada(resolverMarcaDaOrganizacao(null, null, { APP_NAME: "" }))).toBe(
      false,
    );
  });

  it("nome no .env, ou nome da organização, é marca própria", () => {
    expect(marcaFoiConfigurada(resolverMarcaDaOrganizacao(null, null, { APP_NAME: "Acme" }))).toBe(
      true,
    );
    expect(
      marcaFoiConfigurada(
        resolverMarcaDaOrganizacao({ branding: { app_name: "Loja da Ana" } }, null, {}),
      ),
    ).toBe(true);
  });
});

/**
 * O CONSUMIDOR do logo — a outra metade, e a que estava faltando.
 *
 * POR QUE ESTE BLOCO EXISTE: medido antes desta onda, `platform_branding.logo_url`
 * era gravável e ilegível. O único render de logo do produto é esta barra, e ela
 * lia `window.__PUBLIC_ENV__.APP_LOGO_URL`, que vinha do `.env` cru — o operador
 * salvava e nada mudava. Estes casos medem a barra DESENHANDO a imagem, não a
 * presença do símbolo `logoUrl` no arquivo.
 *
 * O que eles NÃO provam, declarado: que a marca entregue ao provedor venha mesmo
 * do banco. Aquilo é a costura do layout raiz (`marcaResolvida()` alimentando o
 * `<MarcaDaInstalacaoProvider/>`), guardada em `tests/unit/branding.test.ts`, e a
 * prova de ponta a ponta é pela tela. Nem provam que os dois lados da fronteira
 * concordam — isso é `tests/unit/marca-sem-divergencia-de-hidratacao.test.tsx`.
 */
describe("o logo na barra lateral", () => {
  const LOGO_DA_INSTALACAO = "https://cdn.exemplo.test/revendedor.png";
  const LOGO_DA_ORG = "https://cdn.exemplo.test/loja-da-ana.png";

  afterEach(() => {
    marcaDaInstalacao = { name: "Sistema do Revendedor", logoUrl: null, initial: "S" };
  });

  const imagem = () => screen.getByRole("img");

  it("com logo da instalação, a barra desenha a imagem no lugar do nome", () => {
    marcaDaInstalacao = { ...marcaDaInstalacao, logoUrl: LOGO_DA_INSTALACAO };
    contexto = { user: usuario, activeOrg: org };
    renderSidebar();

    expect(imagem().getAttribute("src")).toBe(LOGO_DA_INSTALACAO);
    // A ausência importa: uma barra que mostrasse imagem E nome passaria só na
    // asserção de cima, e o cabeçalho tem 56px de altura para um dos dois.
    expect(screen.queryByText("Sistema do Revendedor")).toBeNull();
  });

  it("o logo da organização SUBSTITUI o da instalação", () => {
    marcaDaInstalacao = { ...marcaDaInstalacao, logoUrl: LOGO_DA_INSTALACAO };
    contexto = {
      user: usuario,
      activeOrg: { ...org, marca: { nome: "Loja da Ana", logoUrl: LOGO_DA_ORG } },
    };
    renderSidebar();

    expect(imagem().getAttribute("src")).toBe(LOGO_DA_ORG);
    // O `alt` acompanha a imagem que está ali: com o logo da org, legendar com o
    // nome do revendedor descreveria a marca errada para quem usa leitor de tela.
    expect(imagem().getAttribute("alt")).toBe("Loja da Ana");
  });

  it("logo VAZIO na organização cai para o da instalação, não apaga a marca", () => {
    // O caso que separa `||` de `??`. Vazio é AUSÊNCIA — a mesma regra que
    // `resolveBranding` e `primeiroDefinido` aplicam nas camadas de baixo. Com
    // `??`, `""` venceria a camada de cima e a barra cairia no TEXTO, apagando o
    // logo do revendedor por causa de um campo em branco.
    marcaDaInstalacao = { ...marcaDaInstalacao, logoUrl: LOGO_DA_INSTALACAO };
    contexto = { user: usuario, activeOrg: { ...org, marca: { logoUrl: "" } } };
    renderSidebar();

    expect(imagem().getAttribute("src")).toBe(LOGO_DA_INSTALACAO);
  });

  it("sem logo nenhum, continua sendo o nome — não uma imagem quebrada", () => {
    // Guarda de vacuidade dos três de cima: se a barra desenhasse `<img>` sempre,
    // com `src` vazio, todos passariam pelo `getByRole("img")` e o produto
    // mostraria o ícone de imagem quebrada em toda instalação de fábrica.
    contexto = { user: usuario, activeOrg: org };
    renderSidebar();

    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("Sistema do Revendedor")).toBeTruthy();
  });
});
