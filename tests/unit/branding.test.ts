import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { prefixoDoArquivo } from "@/components/auth/RecoveryCodesPanel";
import { DEFAULT_APP_NAME, resolveBranding } from "@/lib/branding";

const RAIZ = process.cwd();

describe("resolveBranding", () => {
  it("cai no padrão quando não há marca configurada", () => {
    expect(resolveBranding(undefined, undefined)).toEqual({
      name: DEFAULT_APP_NAME,
      logoUrl: null,
      initial: "C",
    });
  });

  it("trata string vazia e só-espaços como ausência de marca", () => {
    // instalação grava a chave declarada mesmo quando o operador não responde
    // (APP_NAME=), então "vazio" chega como string — não como undefined. Tratar
    // isso como marca válida deixaria a interface sem nome nenhum.
    expect(resolveBranding("", "").name).toBe(DEFAULT_APP_NAME);
    expect(resolveBranding("   ", "   ").name).toBe(DEFAULT_APP_NAME);
    expect(resolveBranding("   ", "   ").logoUrl).toBeNull();
  });

  it("usa a marca configurada e deriva a inicial", () => {
    const b = resolveBranding("  Acme CRM  ", "  https://cdn.exemplo.com/logo.svg  ");
    expect(b.name).toBe("Acme CRM");
    expect(b.logoUrl).toBe("https://cdn.exemplo.com/logo.svg");
    expect(b.initial).toBe("A");
  });

  it("mantém o nome mas dispensa o logo quando só o nome é configurado", () => {
    const b = resolveBranding("Acme CRM", undefined);
    expect(b.name).toBe("Acme CRM");
    expect(b.logoUrl).toBeNull();
  });

  it("não parte code point ao derivar a inicial", () => {
    // `[0]` cru devolveria metade do par substituto e renderizaria caractere
    // inválido na sidebar recolhida.
    expect(resolveBranding("🚀 Foguete", null).initial).toBe("🚀");
    expect(resolveBranding("Ótimo CRM", null).initial).toBe("Ó");
  });
});

describe("guarda de white-label (self-host)", () => {
  const branding = fs.readFileSync(path.join(RAIZ, "lib/branding.ts"), "utf8");
  const publicEnvScript = fs.readFileSync(
    path.join(RAIZ, "app/public-env-script.tsx"),
    "utf8",
  );
  const layoutRaiz = fs.readFileSync(path.join(RAIZ, "app/layout.tsx"), "utf8");

  it("não usa prefixo NEXT_PUBLIC_ para a marca", () => {
    // POR QUE ESTE TESTE EXISTE: a convenção do Next empurra qualquer valor lido
    // no browser para NEXT_PUBLIC_*, e alguém vai "corrigir" isso um dia. Mas
    // NEXT_PUBLIC_* é queimada no bundle durante o `next build`, e o self-hoster
    // roda uma imagem PRÉ-BUILDADA: a marca dele nunca apareceria. O defeito
    // passaria em typecheck, lint e em toda a suíte, funcionaria em dev e na
    // Vercel, e falharia apenas na VPS de quem a feature existe para servir.
    expect(branding).not.toMatch(/NEXT_PUBLIC_APP_(NAME|LOGO_URL)/);
    expect(publicEnvScript).not.toMatch(/NEXT_PUBLIC_APP_(NAME|LOGO_URL)/);
  });

  it("injeta a marca em runtime pelo PublicEnvScript", () => {
    // Sem estas duas chaves no payload, os client components (Sidebar,
    // AdminSidebar) caem no padrão e só a marca do servidor muda — a instalação
    // ficaria com o nome do revendedor no título da aba e o nosso na sidebar.
    //
    // As duas liam `env.APP_NAME` / `env.APP_LOGO_URL` — o arquivo de instalação
    // CRU — e a consequência foi medida: `platform_branding.logo_url` e
    // `MarcaDeSaida.logoUrl` existiam sem nenhum leitor, porque o único render de
    // logo do produto (hoje `components/app/MarcaDoProduto.tsx`) lê daqui. O operador
    // salvava um valor que nada mostrava, e a tela dizia "salvo". Passam a vir da
    // marca RESOLVIDA (banco acima, `.env` embaixo).
    expect(publicEnvScript).toMatch(/APP_NAME:\s*marca\.name/);
    expect(publicEnvScript).toMatch(/APP_LOGO_URL:\s*marca\.logoUrl/);
  });

  it("a marca do payload vem do resolvedor, e não do `.env` por outro nome", () => {
    // As duas asserções de cima passariam com um `marca` montado ali mesmo a
    // partir de `env` — o defeito voltaria com outra roupa e o gate ficaria
    // verde. Estas duas fecham as pontas: nenhuma chave de marca sai de `env`
    // dentro do script, e quem preenche a prop é o layout raiz, com a MESMA
    // função que o título da aba e o CSS já usam.
    expect(publicEnvScript).not.toMatch(/APP_(NAME|LOGO_URL):\s*env\./);
    expect(layoutRaiz).toMatch(/<PublicEnvScript\s+marca=\{/);
    expect(layoutRaiz).toMatch(/marcaResolvida\(\)/);
  });

  it("o layout raiz resolve a marca UMA vez para os quatro consumidores", () => {
    // Guarda de vacuidade das duas de cima: se `marcaResolvida` deixasse de ser
    // a fonte da aba ou do CSS, o casamento de `marcaResolvida()` acima
    // continuaria verdadeiro e mediria um resolvedor que só o script usa — que é
    // exatamente a divergência ("aba com uma marca, barra com outra") que o
    // cabeçalho daquela função existe para impedir.
    expect(
      layoutRaiz.match(/await marcaResolvida\(\)/g) ?? [],
      "os quatro consumidores do layout raiz são `generateMetadata` (aba), " +
        "`EstiloDaMarca` (cor), `MarcaNoNavegador` (`window.__PUBLIC_ENV__`) e " +
        "`MarcaDosClientComponents` (o contexto que os `\"use client\"` leem). " +
        "Consumidor a mais é legítimo — atualize o número. Consumidor a MENOS " +
        "significa que alguém voltou a montar a pilha por fora.",
    ).toHaveLength(4);
  });

  it("os client components recebem a marca por PROP, não por fonte só-do-navegador", () => {
    // POR QUE ESTE CASO EXISTE: a asserção `APP_NAME: marca.name` acima ficou
    // verde enquanto o produto emitia React #418 em 7 de 7 telas de `/app/ai/*`.
    // Ela mede o que chega ao NAVEGADOR, e o defeito era o outro lado: o SSR de
    // um `"use client"` não tem `window`, então `branding()` lia `process.env` e
    // renderizava `<span>` onde o cliente hidratava `<img>`.
    //
    // O que fecha a ponta é a marca atravessar por PROP — a mesma rota de
    // `user`/`activeOrg`. As duas asserções são o par mínimo: o provedor existe
    // no layout raiz E ele envolve `children` (um provedor montado ao lado, sem
    // envolver a árvore, deixaria todo consumidor no padrão do produto).
    expect(layoutRaiz).toMatch(/<MarcaDaInstalacaoProvider\s+marca=\{/);
    expect(layoutRaiz).toMatch(/<MarcaDosClientComponents>\s*\n\s*<ThemeProvider>\{children\}/);
  });
});

describe("nome do arquivo de códigos de recuperação", () => {
  // Este arquivo fica anos na pasta de downloads do usuário: é o artefato de
  // marca mais duradouro que o produto entrega, e nenhuma atualização conserta
  // o que já foi baixado. Por isso o prefixo sai da marca da instalação.

  it("deriva o prefixo da marca, sem acento e sem espaço", () => {
    expect(prefixoDoArquivo("Acme CRM")).toBe("acme-crm");
    expect(prefixoDoArquivo("Ótima Gestão")).toBe("otima-gestao");
    // A marca padrão de hoje. Se o nome padrão mudar, este valor muda junto (de propósito: o arquivo
    // baixado fica anos na pasta do usuário, e a troca tem de ser vista).
    expect(prefixoDoArquivo(DEFAULT_APP_NAME)).toBe("crm-alquim-ia");
  });

  it("não devolve hífen pendurado nem repetido", () => {
    // `-recovery-codes.txt` vem logo depois: sobra de hífen viraria "acme--…".
    expect(prefixoDoArquivo("  Acme // CRM!  ")).toBe("acme-crm");
  });

  it("cai em 'crm' quando a marca não tem caractere aproveitável", () => {
    // Sem isto o `download` sairia vazio e o browser inventaria "download.txt" —
    // o usuário perderia de vista o arquivo com os códigos de recuperação dele.
    expect(prefixoDoArquivo("🚀")).toBe("crm");
    expect(prefixoDoArquivo("")).toBe("crm");
  });
});

/**
 * A catraca da marca — o nome do produto não é escrito à mão em código que chega ao usuário.
 *
 * Quem decide o nome que o usuário vê é o resolvedor de marca (`branding()`,
 * `marcaResolvida()`, `marcaDaSaida()`): cada instalação e cada organização pode ter
 * marca própria, e o produto é revendido assim. O nome da casa escrito direto num
 * `.tsx`, num e-mail ou num PDF aparece para o cliente do revendedor com o nome
 * errado. A única definição dele é `DEFAULT_APP_NAME` (`lib/branding.ts`); quem
 * precisa do padrão importa a constante.
 *
 * A varredura procura DUAS marcas: a da casa (derivada de `DEFAULT_APP_NAME`, para
 * a catraca acompanhar se o padrão mudar) e a da ORIGEM (o projeto de que este
 * nasceu, montada por partes porque este arquivo também passa pelo portão de
 * limpeza, `tests/unit/sem-dado-de-operacao.test.ts`, que só a aceita no crédito).
 *
 * A versão anterior deste gate ficava VERDE enquanto a marca vazava, por dois
 * furos independentes, e os dois só apareceram quando alguém foi olhar:
 *
 *  1. o padrão diferenciava maiúsculas. Passavam o endereço de suporte da tela de
 *     conta suspensa, o da tela de cobrança e o nome do arquivo de códigos de
 *     recuperação (o arquivo que o usuário baixa e guarda por anos). Endereço e
 *     nome de arquivo são minúsculos por natureza — ou seja, o gate era cego
 *     justamente na forma em que a marca de fato aparece;
 *  2. a varredura cobria só `app/` e `components/`, e só `.tsx`. Ficavam fora
 *     `lib/` inteiro (e-mail de convite, rodapé do PDF de LGPD, remetente) e
 *     todo arquivo `.ts` — inclusive `app/actions/auth/enrollMfa.ts`, que está
 *     DENTRO de `app/` e escapava pela extensão. Esse é o pior deles: o nome vai
 *     para o app autenticador e fica no celular do usuário para sempre.
 *
 * MECANISMO. A varredura casa as duas marcas sem diferenciar maiúsculas sobre `.ts`
 * e `.tsx` de `app/`, `components/`, `hooks/`, `lib/` e `workers/`. Cada arquivo
 * com ocorrência precisa de uma entrada em `MARCA_CONGELADA` com categoria, motivo
 * escrito e o conjunto EXATO de marcas encontradas. Arquivo novo reprova; marca
 * nova em arquivo já congelado reprova; marca que sumiu também reprova, e a
 * correção é apagar a linha da lista — é assim que ela só encolhe.
 *
 * MARCA ≠ PROTOCOLO. O que a varredura procura é o NOME DE EXIBIÇÃO. Os
 * identificadores técnicos que levam `crm-alquimia` (headers do webhook, cookie de
 * sessão, servidor MCP, `X-Client-Info`, chaves de storage, as propriedades
 * gravadas no Google Calendar) são contrato de fio, fixos do produto de propósito:
 * se viessem da marca resolvida, trocar a marca derrubaria integração e sessão.
 * Eles não são texto de tela e ficam fora desta catraca.
 */

/** O nome da origem, por partes (ver o cabeçalho acima). */
const ORIGEM = ["desk", "comm"].join("");
/** A forma com maiúscula e o sufixo, como a marca aparecia em texto. */
const ORIGEM_CRM = ["Desk", "commCRM"].join("");
/** A marca da casa (o padrão), para montar casos de teste sem escrevê-la à mão. */
const CASA = DEFAULT_APP_NAME;

const escaparRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** O núcleo da marca da casa (sem o "CRM " da frente), com o "CRM " opcional antes. */
const NUCLEO_DA_CASA = DEFAULT_APP_NAME.replace(/^CRM\s+/i, "");
const PADRAO_DA_CASA = `(?:CRM\\s+)?${escaparRegex(NUCLEO_DA_CASA)}`;

type CategoriaDeMarca =
  /** Contrato de fio: alguém FORA deste processo casa a string por igualdade
   *  (header de webhook, nome do servidor MCP, user-agent). Nunca renomear. */
  | "PROTOCOLO"
  /** Chave de cookie, de storage do browser ou de contêiner. Não sai para
   *  terceiro, mas renomear desloga a base instalada ou perde estado local. */
  | "INFRA"
  /** Vazamento real de marca, visível ao usuário final. Declara a fase que o
   *  resolve — pendência sem prazo é pendência esquecida. */
  | "DIVIDA"
  /** Só desenvolvimento: fixture de teste. Não embarca na imagem. */
  | "DEV"
  /** A definição do nome padrão do produto. Tem de existir em UM lugar. */
  | "PADRAO";

type EntradaDeMarca = {
  categoria: CategoriaDeMarca;
  /** Por que esta ocorrência pode ficar. Quem adiciona linha aqui escreve isto. */
  motivo: string;
  /** Fase que remove a ocorrência. Obrigatório — e só faz sentido — em `DIVIDA`. */
  fase?: number;
  /** Conjunto EXATO de marcas do arquivo, como `marcasNoTexto` as normaliza. */
  marcas: string[];
};

const MARCA_CONGELADA: Record<string, EntradaDeMarca> = {
  // ─── PADRAO — a definição do nome padrão. Tem de existir em UM lugar. ───
  "lib/branding.ts": {
    categoria: "PADRAO",
    motivo:
      "DEFAULT_APP_NAME: o nome que vale quando a instalação não configurou marca. Todo outro lugar importa esta constante ou passa pelo resolvedor",
    marcas: [CASA],
  },
};

/**
 * As raízes varridas — e a FRONTEIRA, escrita, porque foi a ausência dela que
 * deixou `hooks/` de fora até alguém ir olhar.
 *
 * O critério é UM: código que EMBARCA na imagem e cujo texto pode alcançar o
 * usuário final. Por isso entram `app/`, `components/`, `lib/`, `workers/` —
 * e `hooks/`, que tem 112 arquivos, é importada por 171 arquivos de `app` e
 * `components`, e emite `toast` direto na tela. Ficou fora só porque a lista
 * nasceu enumerando o que alguém lembrou, e enumeração sem critério não avisa
 * quando fica incompleta.
 *
 * Ficam FORA, com motivo:
 *  - `scripts/` (14 ocorrências, todas fixture de dev e prosa de log) e
 *    `tests/`: não embarcam na imagem — o `Dockerfile` copia `.next/standalone`,
 *    `.next/static` e `public/`;
 *  - `evidence/` e `loop/`: ferramental de sessão, mesma razão;
 *  - `types/`: um único `.d.ts`, sem string de runtime (medido: 0 ocorrências).
 *
 * `app/design/` (o showcase interno do design system) ficava fora e passou a ser
 * varrido: ele usa `DEFAULT_APP_NAME` como todo o resto.
 */
const RAIZES_VARRIDAS = ["app", "components", "hooks", "lib", "workers"] as const;

/**
 * Extrai as marcas de um texto, uma por ocorrência.
 *
 * Casa a marca da casa (nome de exibição, normalizado em minúsculas) e a da origem
 * em qualquer caixa. Da origem leva junto o identificador inteiro em volta (um
 * header, um endereço de e-mail), porque é o identificador — não a palavra
 * solta — que distingue contrato de fio de vazamento de marca.
 *
 * Linha que ABRE com `//`, `*` ou `/*` é comentário e não conta: comentário não
 * chega ao usuário, e contá-lo encheria a lista de entradas inertes até ninguém
 * mais ler as que importam. O teste olha só o início da linha DE PROPÓSITO —
 * procurar `//` em qualquer posição descartaria uma URL entre aspas, que é
 * exatamente um vazamento de verdade.
 */
function marcasNoTexto(fonte: string): string[] {
  const achadas: string[] = [];
  for (const linha of fonte.split("\n")) {
    const inicio = linha.trimStart();
    if (inicio.startsWith("//") || inicio.startsWith("*") || inicio.startsWith("/*")) continue;
    for (const casada of linha.matchAll(new RegExp(`[\\w@.-]*${ORIGEM}[\\w@.-]*`, "gi"))) {
      // Pontuação encostada (o ponto final de uma frase) não faz parte
      // do identificador e faria a lista mudar por causa de uma vírgula.
      achadas.push(casada[0].toLowerCase().replace(/^[.-]+/, "").replace(/[.-]+$/, ""));
    }
    for (const casada of linha.matchAll(new RegExp(PADRAO_DA_CASA, "gi"))) {
      // Normalizada na forma canônica (a do padrão), em qualquer caixa que apareça.
      achadas.push(/^CRM/i.test(casada[0]) ? CASA : NUCLEO_DA_CASA);
    }
  }
  return achadas.sort();
}

function arquivosVarridos(dir: string): string[] {
  const alvos: string[] = [];
  for (const entrada of fs.readdirSync(path.join(RAIZ, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, entrada.name);
    if (entrada.isDirectory()) alvos.push(...arquivosVarridos(rel));
    else if (rel.endsWith(".ts") || rel.endsWith(".tsx")) alvos.push(rel);
  }
  return alvos;
}

describe("catraca de marca hardcoded", () => {
  const porRaiz = new Map(RAIZES_VARRIDAS.map((r) => [r, arquivosVarridos(r)]));
  const alvos = [...porRaiz.values()].flat();
  const encontrado = new Map<string, string[]>();
  for (const arquivo of alvos) {
    const marcas = marcasNoTexto(fs.readFileSync(path.join(RAIZ, arquivo), "utf8"));
    if (marcas.length > 0) encontrado.set(arquivo, marcas);
  }

  it("a varredura alcança as cinco raízes — senão o resto não prova nada", () => {
    // Guarda de vacuidade com nome. `workers/` hoje não tem NENHUMA ocorrência
    // fora de comentário: sem esta asserção, uma varredura que nem descesse lá
    // devolveria a mesma lista vazia e passaria como se estivesse vigiando.
    for (const [raiz, arquivos] of porRaiz) {
      expect(arquivos.length, `${raiz}/ não devolveu arquivo nenhum`).toBeGreaterThan(0);
    }
    expect(alvos.length).toBeGreaterThan(500);
    expect(alvos.filter((f) => f.endsWith(".ts")).length).toBeGreaterThan(100);
    expect(alvos.filter((f) => f.endsWith(".tsx")).length).toBeGreaterThan(100);
  });

  it("pega a marca em qualquer caixa e dentro de identificador", () => {
    // O furo nº 1 do gate antigo, agora com asserção: o padrão com maiúscula deixava passar
    // as três formas de baixo, que são as formas em que a marca de fato aparece.
    expect(marcasNoTexto(`a.download = "${ORIGEM}crm-recovery-codes.txt";`)).toEqual([
      `${ORIGEM}crm-recovery-codes.txt`,
    ]);
    expect(marcasNoTexto(`href="mailto:suporte@${ORIGEM}.app"`)).toEqual([`suporte@${ORIGEM}.app`]);
    expect(marcasNoTexto(`const k = "sb-${ORIGEM.toUpperCase()}-auth";`)).toEqual([`sb-${ORIGEM}-auth`]);
  });

  it("pega a marca da CASA em texto de tela, em qualquer caixa, e não o identificador técnico", () => {
    expect(marcasNoTexto(`const titulo = "Bem-vindo ao ${CASA}";`)).toEqual([CASA]);
    expect(marcasNoTexto(`<h1>${CASA.toUpperCase()}</h1>`)).toEqual([CASA]);
    expect(marcasNoTexto(`assunto: \`Alerta — ${NUCLEO_DA_CASA.toLowerCase()}\``)).toEqual([NUCLEO_DA_CASA]);
    expect(marcasNoTexto(`  // o ${CASA} faz isto`)).toEqual([]);
    // contrato de fio não é nome de exibição
    expect(marcasNoTexto(`const COOKIE = "sb-crm-alquimia-auth"; headers["x-crm-alquimia-event"] = e;`)).toEqual([]);
    // quem importa a constante não escreve a marca
    expect(marcasNoTexto("const nome = DEFAULT_APP_NAME;")).toEqual([]);
  });

  it("ignora comentário, mas não confunde `//` de URL com comentário", () => {
    // A regra de comentário é uma exceção, e exceção sem guarda vira buraco:
    // procurar `//` em qualquer posição da linha esconderia justamente a URL.
    expect(marcasNoTexto(`  // fala do ${ORIGEM_CRM}`)).toEqual([]);
    expect(marcasNoTexto(` * fala do ${ORIGEM_CRM}`)).toEqual([]);
    expect(marcasNoTexto(`const u = "https://${ORIGEM}.app/x";`)).toEqual([`${ORIGEM}.app`]);
    expect(marcasNoTexto(`fetch(url); // manda pro ${ORIGEM_CRM}`)).toEqual([`${ORIGEM}crm`]);
  });

  it("nenhum arquivo fora da lista fixa a marca", () => {
    const novos = [...encontrado.keys()].filter((f) => !(f in MARCA_CONGELADA));
    expect(
      novos,
      `Marca hardcoded em arquivo que não está congelado.\n` +
        `Use o resolvedor (branding(), marcaResolvida(), marcaDaSaida()) ou a constante\n` +
        `DEFAULT_APP_NAME de lib/branding.ts. Exceção só com decisão, em MARCA_CONGELADA\n` +
        `com categoria e motivo:\n` +
        novos.map((f) => `  ${f}  ${JSON.stringify(encontrado.get(f))}`).join("\n"),
    ).toEqual([]);
  });

  it("arquivo congelado não ganhou nem perdeu marca sem a lista acompanhar", () => {
    const divergentes: string[] = [];
    for (const [arquivo, entrada] of Object.entries(MARCA_CONGELADA)) {
      const atual = encontrado.get(arquivo) ?? [];
      const congelado = [...entrada.marcas].sort();
      if (JSON.stringify(atual) !== JSON.stringify(congelado)) {
        divergentes.push(`  ${arquivo}\n    lista: ${JSON.stringify(congelado)}\n    disco: ${JSON.stringify(atual)}`);
      }
    }
    expect(
      divergentes,
      `O conjunto de marcas mudou num arquivo congelado.\n` +
        `Ganhou marca: é ocorrência NOVA — tire do código.\n` +
        `Perdeu marca: a dívida encolheu — atualize (ou apague) a linha da lista.\n` +
        divergentes.join("\n"),
    ).toEqual([]);
  });

  it("a lista não guarda arquivo que já não tem marca nenhuma", () => {
    // É o que força a lista a ENCOLHER: quem limpar um arquivo é obrigado a
    // apagar a linha, em vez de deixar a pendência morta ocupando espaço.
    const obsoletos = Object.keys(MARCA_CONGELADA).filter((f) => !encontrado.has(f));
    expect(
      obsoletos,
      `Estes arquivos não têm mais marca — apague a linha de MARCA_CONGELADA:\n` +
        obsoletos.map((f) => `  ${f}`).join("\n"),
    ).toEqual([]);
  });

  it("toda entrada declara categoria e explica o porquê", () => {
    const validas: CategoriaDeMarca[] = ["PROTOCOLO", "INFRA", "DIVIDA", "DEV", "PADRAO"];
    const ruins = Object.entries(MARCA_CONGELADA)
      .filter(([, e]) => !validas.includes(e.categoria) || e.motivo.trim().length < 40)
      .map(([f]) => f);
    expect(ruins, `entrada sem categoria válida ou sem justificativa escrita:\n  ${ruins.join("\n  ")}`).toEqual([]);
  });

  it("a Fase 4 fechou e o alarme de orçamento virou CRM ALQUIM(IA): não sobra dívida", () => {
    // As três regras acima forçam a lista a ENCOLHER, mas nada impedia que ela
    // voltasse a CRESCER: uma `DIVIDA` nova entra sem ninguém notar, porque
    // acrescentar linha à allowlist é o caminho de menor resistência de quem
    // está com pressa. Este caso trava o conjunto pelo NOME, não pelo tamanho —
    // contar só o número deixaria trocar uma dívida por outra em silêncio.
    const dividas = Object.entries(MARCA_CONGELADA)
      .filter(([, e]) => e.categoria === "DIVIDA")
      .map(([arquivo]) => arquivo);
    expect(
      dividas,
      "as dívidas de marca zeraram (a última, o alarme de orçamento de IA, saiu na " +
        "renomeação para CRM ALQUIM(IA)). Dívida nova aqui precisa de decisão, " +
        "não de mais uma linha na lista.",
    ).toEqual([]);
  });

  it("toda DIVIDA nomeia a fase que a resolve, e só DIVIDA tem fase", () => {
    // Pendência sem prazo é pendência esquecida — e categoria que não é dívida
    // com "fase" declarada seria alguém tratando contrato de fio como pendência.
    const semFase = Object.entries(MARCA_CONGELADA)
      .filter(([, e]) => (e.categoria === "DIVIDA") !== (typeof e.fase === "number"))
      .map(([f]) => f);
    expect(semFase, `DIVIDA sem fase, ou fase declarada onde não é dívida:\n  ${semFase.join("\n  ")}`).toEqual([]);
  });
});

/**
 * A SEGUNDA varredura: os arquivos que o GoTrue lê, e que a primeira nunca viu.
 *
 * A catraca de cima varre `.ts`/`.tsx` de `app|components|hooks|lib|workers` —
 * o código que embarca na imagem. Ela é cega para `supabase/templates/*.html` e
 * `supabase/config.toml`, e essa cegueira tinha consequência medida: dava para
 * zerar a lista de dívidas, ver a suíte inteira verde, e o cliente do
 * revendedor continuar recebendo o assunto com o nome da origem fixo no
 * PRIMEIRO e-mail que ele abre na vida.
 *
 * Estes arquivos não são renderizados por nenhum TypeScript nosso: quem os
 * renderiza é o GoTrue, um processo de terceiro. Não há resolvedor a chamar —
 * quem troca os marcadores (`__APP_NAME__`, `__ACCENT__`) é a pessoa que instala,
 * à mão (cabeçalho do modelo). Por isso a guarda aqui é diferente em
 * NATUREZA da de cima: lá ela cobra `branding()`; aqui ela cobra placeholder.
 *
 * ⚠️ A REGRA DE COMENTÁRIO NÃO SE REAPROVEITA. `marcasNoTexto` ignora linha que
 * ABRE com `//`, `*` ou `/*`. Comentário de HTML é `<!-- … -->`, atravessa
 * várias linhas e as linhas do meio não abrem com nada. Copiar a função sem
 * ajustar faria a marca DENTRO de um comentário contar como vazamento e a marca
 * de verdade, na mesma linha de um `-->`, passar.
 */
describe("catraca de marca no que o GoTrue renderiza", () => {
  /** Comentário de HTML é um TRECHO, não um prefixo de linha. */
  function semComentariosHtml(fonte: string): string {
    return fonte.replace(/<!--[\s\S]*?-->/g, "");
  }

  /**
   * TOML: só linha que ABRE com `#`. Um `#` no meio da linha não é tratado como
   * comentário DE PROPÓSITO — `#506d48` dentro de uma string seria decapitado, e
   * uma marca depois dele sumiria. Contar demais aqui custa uma linha de
   * allowlist; contar de menos custa a marca vazando com o gate verde.
   */
  function semComentariosToml(fonte: string): string {
    return fonte
      .split("\n")
      .filter((linha) => !linha.trimStart().startsWith("#"))
      .join("\n");
  }

  const ALVOS: { arquivo: string; limpar: (f: string) => string }[] = [
    { arquivo: "supabase/templates/confirmation.html", limpar: semComentariosHtml },
    { arquivo: "supabase/templates/recovery.html", limpar: semComentariosHtml },
    { arquivo: "supabase/config.toml", limpar: semComentariosToml },
  ];

  const CONGELADO_SUPABASE: Record<string, EntradaDeMarca> = {
    "supabase/config.toml": {
      categoria: "DEV",
      motivo:
        "config do Supabase LOCAL (o `supabase start` da instalação e do CI). O GoTrue que lê este arquivo é um processo de terceiro e não chama o resolvedor: os dois assuntos de e-mail são o nome padrão. Quem tem marca própria troca o assunto aqui e os marcadores dos modelos em supabase/templates, à mão (cabeçalho do modelo)",
      marcas: [CASA, CASA],
    },
  };

  const encontradoAqui = new Map<string, string[]>();
  for (const { arquivo, limpar } of ALVOS) {
    const marcas = marcasNoTexto(limpar(fs.readFileSync(path.join(RAIZ, arquivo), "utf8")));
    if (marcas.length > 0) encontradoAqui.set(arquivo, marcas);
  }

  it("os arquivos varridos existem e os modelos têm placeholder", () => {
    // Vacuidade em duas pontas. Se os arquivos sumissem de lugar, a varredura
    // devolveria vazio e os casos abaixo passariam vigiando o nada; e se os
    // modelos perdessem o `__APP_NAME__`, "sem marca" passaria a significar
    // "sem nome nenhum no e-mail", que é outro defeito com o mesmo sintoma.
    for (const { arquivo } of ALVOS) {
      expect(fs.existsSync(path.join(RAIZ, arquivo)), `${arquivo} sumiu`).toBe(true);
    }
    for (const modelo of ["supabase/templates/confirmation.html", "supabase/templates/recovery.html"]) {
      const texto = fs.readFileSync(path.join(RAIZ, modelo), "utf8");
      expect(texto, `${modelo} não substitui a marca`).toContain("__APP_NAME__");
      expect(texto, `${modelo} não substitui o accent`).toContain("__ACCENT__");
    }
  });

  it("comentário de HTML não conta, e `-->` no meio da linha não engole o resto", () => {
    expect(marcasNoTexto(semComentariosHtml(`<!-- fala do ${ORIGEM_CRM} -->`))).toEqual([]);
    expect(marcasNoTexto(semComentariosHtml(`<!--\n  ${ORIGEM_CRM}\n  em várias linhas\n-->`))).toEqual([]);
    // O caso que a regra de `//` erraria: marca REAL depois do fecho.
    expect(marcasNoTexto(semComentariosHtml(`<!-- nota --> Sua conta no ${ORIGEM_CRM}`))).toEqual([
      `${ORIGEM}crm`,
    ]);
    // E a marca fora de comentário nenhum continua contando.
    expect(marcasNoTexto(semComentariosHtml(`<p>conta no ${ORIGEM_CRM}</p>`))).toEqual([`${ORIGEM}crm`]);
  });

  it("comentário de TOML não conta, mas `#` dentro de string não vira comentário", () => {
    expect(marcasNoTexto(semComentariosToml(`# Supabase CLI config — ${ORIGEM_CRM}`))).toEqual([]);
    expect(marcasNoTexto(semComentariosToml(`cor = "#506d48"  # ${ORIGEM_CRM}`))).toEqual([
      `${ORIGEM}crm`,
    ]);
    expect(marcasNoTexto(semComentariosToml(`subject = "Olá — ${ORIGEM_CRM}"`))).toEqual([`${ORIGEM}crm`]);
  });

  it("nenhum arquivo do GoTrue fixa a marca fora da lista", () => {
    const novos = [...encontradoAqui.keys()].filter((f) => !(f in CONGELADO_SUPABASE));
    expect(
      novos,
      `Marca hardcoded em arquivo que o GoTrue renderiza.\n` +
        `Use o marcador __APP_NAME__ (quem troca é a pessoa, à mão; ver o cabeçalho do modelo):\n` +
        novos.map((f) => `  ${f}  ${JSON.stringify(encontradoAqui.get(f))}`).join("\n"),
    ).toEqual([]);
  });

  it("a lista do GoTrue não guarda arquivo que já não tem marca", () => {
    const obsoletos = Object.keys(CONGELADO_SUPABASE).filter((f) => !encontradoAqui.has(f));
    expect(obsoletos, `apague a linha destes de CONGELADO_SUPABASE:\n  ${obsoletos.join("\n  ")}`).toEqual([]);
  });

  it("arquivo congelado do GoTrue não mudou de conjunto sem a lista acompanhar", () => {
    for (const [arquivo, entrada] of Object.entries(CONGELADO_SUPABASE)) {
      expect(encontradoAqui.get(arquivo) ?? [], arquivo).toEqual([...entrada.marcas].sort());
    }
  });

  it("os dois modelos de e-mail não têm marca nenhuma — é o estado que se defende", () => {
    // Explícito, e não só implícito na ausência de linha na allowlist: é ESTE
    // caso que falha quando alguém reescreve o nome da origem num template.
    expect(encontradoAqui.has("supabase/templates/confirmation.html")).toBe(false);
    expect(encontradoAqui.has("supabase/templates/recovery.html")).toBe(false);
  });
});
