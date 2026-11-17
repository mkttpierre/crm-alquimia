import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MarcaDeSaida } from "@/lib/branding/saida";

/**
 * O LOGO NA FACHADA — as telas que existem antes de qualquer sessão.
 *
 * POR QUE ESTE ARQUIVO EXISTE: até esta onda o login renderizava só texto, e
 * `platform_branding.logo_url` não tinha um único leitor no produto. Quem
 * instala o sistema para clientes mostra a marca dele exatamente aqui — é a
 * primeira tela que o cliente do revendedor abre na vida, e a última que alguém
 * lembra de conferir.
 *
 * ── Por que renderizar o LAYOUT, e não a página ───────────────────────────────
 *
 * O `<img>` mora em `app/(public)/layout.tsx` porque são SEIS telas no grupo
 * (login, cadastro, recuperação, redefinição, MFA, códigos de recuperação) e uma
 * cópia por página divergiria na primeira vez que alguém mexesse numa só. O
 * teste segue o código: mede a casca, que é onde a decisão está.
 *
 * ── Por que `renderToStaticMarkup`, e não Testing Library ─────────────────────
 *
 * É um Server Component async: `render()` da Testing Library não sabe esperar a
 * promessa. Chamar a função e renderizar a árvore que ela devolve é o caminho
 * honesto — e mede o HTML de verdade, não a presença do símbolo `logoUrl` no
 * arquivo.
 */

const marcaDaSaida = vi.hoisted(() => vi.fn());
vi.mock("@/lib/branding/saida", () => ({ marcaDaSaida }));
// A casca passou a resolver o idioma da interface (ver `IdiomaProvider` no
// próprio layout) e por isso chama `createClient()`, que lê cookies — algo que
// só existe dentro de uma requisição real. Fora do login quase nunca há
// sessão, e o mock reflete exatamente isso: nenhum usuário.
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: null } })) },
  })),
}));

const MARCA: MarcaDeSaida = {
  nome: "Acme CRM",
  logoUrl: null,
  accent: "#2f6f4e",
  accentFg: "#ffffff",
  origens: { nome: "banco", cor: "banco" },
};

async function fachada(marca: MarcaDeSaida): Promise<string> {
  marcaDaSaida.mockResolvedValue(marca);
  const { default: PublicLayout } = await import("@/app/(public)/layout");
  return renderToStaticMarkup(await PublicLayout({ children: <p>formulário</p> }));
}

describe("a casca das telas de acesso", () => {
  beforeEach(() => {
    vi.resetModules();
    marcaDaSaida.mockReset();
  });

  it("com logo configurado, a fachada o desenha", async () => {
    const html = await fachada({ ...MARCA, logoUrl: "https://cdn.exemplo.test/revenda.png" });

    expect(html).toContain('src="https://cdn.exemplo.test/revenda.png"');
    // Legendado com a marca DESTA resolução: é ela que produziu a imagem.
    expect(html).toContain('alt="Acme CRM"');
    // Guarda de vacuidade: sem o conteúdo, a asserção de cima poderia estar
    // medindo uma casca que engoliu o formulário de login.
    expect(html).toContain("formulário");
  });

  it("sem logo, nenhuma imagem — e nunca um `src` vazio", async () => {
    const html = await fachada(MARCA);

    // `<img src="">` faz o navegador pedir a própria página e desenhar o ícone
    // de imagem quebrada no topo do login. É o estado de fábrica de TODA
    // instalação nova, então o caminho normal não pode ter esse defeito.
    expect(html).not.toContain("<img");
    expect(html).toContain("formulário");
  });

  it("sem NADA configurado, a fachada desenha o sol e a escrita do produto, acima do formulário", async () => {
    const html = await fachada({
      ...MARCA,
      nome: "CRM ALQUIM(IA)",
      origens: { nome: "padrao", cor: "padrao" },
    });

    // A arte do produto, como na barra lateral: o sol (PNG embutido) e a escrita
    // (SVG com o nome como legenda).
    expect(html).toContain('data-marca="produto"');
    expect(html).toContain('src="data:image/png;base64,');
    expect(html).toContain('aria-label="CRM ALQUIM(IA)"');
    // 72 px de sol, e o sol INVERTE no tema claro (branco -> preto da marca) e
    // volta ao branco no escuro. Sem estas classes o sol branco some no fundo claro.
    expect(html).toMatch(/class="[^"]*h-\[72px\][^"]*w-\[72px\]/);
    expect(html).toContain("invert dark:invert-0");
    // A escrita segue a cor do texto da página; só o "(IA)" é amarelo.
    expect(html).toContain("text-foreground");
    expect(html).toContain('fill="currentColor"');
    expect(html).toContain('fill="#E7B94F"');
    // E fica ACIMA do formulário.
    expect(html.indexOf('data-marca="produto"')).toBeLessThan(html.indexOf("formulário"));
    // Não é o logo configurado: o `data-testid` do logo da empresa não aparece.
    expect(html).not.toContain('data-testid="logo-da-fachada"');
  });

  it("logo configurado vence — a arte do produto nunca fica ao lado da marca de um revendedor", async () => {
    const html = await fachada({
      ...MARCA,
      logoUrl: "https://cdn.exemplo.test/revenda.png",
      origens: { nome: "padrao", cor: "padrao" },
    });

    expect(html).toContain('data-testid="logo-da-fachada"');
    expect(html).not.toContain('data-marca="produto"');
    expect(html).not.toContain("data:image/png;base64,");
  });

  it("só o NOME configurado também tira a arte do produto", async () => {
    // O nome aparece em texto sob o título de cada tela; o sol do produto ao lado
    // dele seria a nossa marca na tela de quem não a escolheu.
    const html = await fachada(MARCA);
    expect(html).not.toContain('data-marca="produto"');
    // Nem o sol (PNG embutido) nem a escrita (SVG com o traço amarelo do "(IA)").
    expect(html).not.toContain("data:image/png");
    expect(html).not.toContain("#E7B94F");
  });

  it("a fachada resolve a marca SEM organização — é o que `null` declara ali", async () => {
    await fachada(MARCA);

    // `marcaDaSaida(orgId)` com um id monta a pilha da organização. Na tela de
    // login não existe organização resolvida (ninguém entrou), e passar
    // qualquer outra coisa aqui seria inventar um tenant para pintar a fachada.
    expect(marcaDaSaida).toHaveBeenCalledWith(null);
  });
});
