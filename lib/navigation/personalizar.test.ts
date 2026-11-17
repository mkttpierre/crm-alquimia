/**
 * Personalizar a barra (migration 0261): o que prendemos aqui é a PROJEÇÃO —
 * `barraLateral()` aplicando, nesta ordem, a restrição do admin, os nomes da
 * organização, os ocultos e a ordem pessoais — e os leitores/schemas dos dados.
 *
 * O que NÃO mudou e continua vigiado em `components/app/BarraLateral.test.tsx`:
 * a barra padrão (sem personalização) é a de antes.
 */
import { describe, expect, it } from "vitest";

import type { InterfaceSettings } from "@/lib/navigation/interface";
import {
  CHAVE_TRAVADA,
  LIMITE_DO_NOME,
  chaveDoGrupo,
  lerNomesDaBarra,
  lerPreferenciasDaBarra,
  moverItem,
  nomesDaBarraSchema,
  ordenarBloco,
  preferenciasDaBarraSchema,
  type PersonalizacaoDaBarra,
} from "@/lib/navigation/personalizar";
import {
  barraLateral,
  barraParaPersonalizar,
  chavesConhecidasDaBarra,
  hubSections,
  searchable,
} from "@/lib/navigation/registry";

const prefs = (ocultos: string[] = [], ordem: string[] = []): PersonalizacaoDaBarra => ({
  preferencias: { ocultos, ordem },
});

const chavesDe = (secoes: ReturnType<typeof barraLateral>, secao?: string) =>
  secoes.filter((s) => !secao || s.secao.id === secao).flatMap((s) => s.itens.map((i) => i.chave));

const padrao = barraLateral(false, "admin");

describe("barraLateral() sem personalização", () => {
  it("vazio, indefinido e lixo dão exatamente a barra padrão", () => {
    const base = JSON.stringify(barraLateral(false, "admin", undefined, undefined));
    expect(JSON.stringify(barraLateral(false, "admin", undefined, {}))).toBe(base);
    expect(JSON.stringify(barraLateral(false, "admin", undefined, prefs()))).toBe(base);
    expect(
      JSON.stringify(
        barraLateral(false, "admin", undefined, {
          preferencias: {
            ocultos: [1, null] as unknown as string[],
            ordem: "x" as unknown as string[],
          },
          nomes: { "/app/inbox": 7 } as unknown as Record<string, string>,
        }),
      ),
    ).toBe(base);
  });

  it("toda linha tem uma chave estável: o href do destino ou grupo:<id>", () => {
    const todas = padrao.flatMap((s) => s.itens);
    for (const i of todas) {
      expect(i.chave).toEqual(
        i.tipo === "grupo" ? expect.stringMatching(/^grupo:[a-z]+$/) : i.href,
      );
    }
    expect(chavesDe(padrao)).toContain(chaveDoGrupo("ia"));
    expect(chavesDe(padrao)).toContain("/app/inbox");
    expect(new Set(chavesDe(padrao)).size).toBe(chavesDe(padrao).length);
  });

  it("nenhum rótulo é nome próprio quando ninguém renomeou", () => {
    expect(padrao.flatMap((s) => s.itens).every((i) => i.nomeProprio === false)).toBe(true);
  });
});

describe("ocultos", () => {
  it("some a linha escolhida e só ela", () => {
    const antes = chavesDe(padrao);
    const depois = chavesDe(barraLateral(false, "admin", undefined, prefs(["/app/leads"])));
    expect(depois).toEqual(antes.filter((c) => c !== "/app/leads"));
  });

  it("ocultar uma linha leva o submenu dela junto (Radar mora dentro do Inbox)", () => {
    const secoes = barraLateral(false, "admin", undefined, prefs(["/app/inbox"]));
    const hrefs = secoes.flatMap((s) =>
      s.itens.flatMap((i) => [i.href, ...i.submenu.map((x) => x.href)]),
    );
    expect(hrefs).not.toContain("/app/inbox");
    expect(hrefs).not.toContain("/app/radar");
  });

  it("oculta uma linha de grupo pela chave grupo:<id>", () => {
    const rotulos = barraLateral(false, "admin", undefined, prefs([chaveDoGrupo("ia")])).flatMap(
      (s) => s.itens.map((i) => i.label),
    );
    expect(rotulos).not.toContain("Agente de IA");
    expect(rotulos).toContain("Análise");
  });

  it("bloco sem nenhuma linha visível some inteiro, com o título", () => {
    const secoes = barraLateral(
      false,
      "admin",
      undefined,
      prefs(["/app/disparo", "/app/connections", "/app/templates"]),
    );
    expect(secoes.map((s) => s.secao.id)).toEqual(["principal", "gestao"]);
  });

  it("⭐ Configurações nunca some, mesmo que a escolha esteja gravada", () => {
    const secoes = barraLateral(false, "viewer", undefined, prefs([CHAVE_TRAVADA, "/app/inicio"]));
    expect(chavesDe(secoes)).toContain(CHAVE_TRAVADA);
    expect(chavesDe(secoes)).not.toContain("/app/inicio");
  });

  it("chave desconhecida é ignorada sem erro", () => {
    const secoes = barraLateral(
      false,
      "admin",
      undefined,
      prefs(["/app/ja-nao-existe", "grupo:fantasma"]),
    );
    expect(chavesDe(secoes)).toEqual(chavesDe(padrao));
  });
});

describe("ordem", () => {
  it("quem está na ordem vem primeiro; o resto segue no fim, na ordem padrão", () => {
    const secoes = barraLateral(
      false,
      "admin",
      undefined,
      prefs([], ["/app/agenda", "/app/tasks"]),
    );
    expect(chavesDe(secoes, "principal")).toEqual([
      "/app/agenda",
      "/app/tasks",
      "/app/inicio",
      "/app/inbox",
      "/app/kanban",
      "/app/leads",
      "/app/contacts",
    ]);
  });

  it("⭐ item novo do catálogo (fora da ordem salva) entra no FIM do bloco dele", () => {
    // A ordem salva só conhece dois destinos do bloco; os demais são "novos".
    const secoes = barraLateral(
      false,
      "admin",
      undefined,
      prefs([], ["/app/leads", "/app/inicio"]),
    );
    const principal = chavesDe(secoes, "principal");
    expect(principal.slice(0, 2)).toEqual(["/app/leads", "/app/inicio"]);
    expect(principal.slice(2)).toEqual([
      "/app/inbox",
      "/app/kanban",
      "/app/contacts",
      "/app/tasks",
      "/app/agenda",
    ]);
  });

  it("a ordem de um bloco não puxa linha de outro bloco, nem inventa linha", () => {
    const secoes = barraLateral(
      false,
      "admin",
      undefined,
      prefs([], ["/app/disparo", "/app/inicio", "/app/nao-existe"]),
    );
    expect(chavesDe(secoes, "principal")[0]).toBe("/app/inicio");
    expect(chavesDe(secoes, "prospeccao")[0]).toBe("/app/disparo");
    expect(chavesDe(secoes)).not.toContain("/app/nao-existe");
  });

  it("Configurações fica por último no bloco, mesmo quando a ordem a põe primeiro", () => {
    const secoes = barraLateral(
      false,
      "admin",
      undefined,
      prefs([], [CHAVE_TRAVADA, "/app/products", chaveDoGrupo("analise")]),
    );
    expect(chavesDe(secoes, "gestao")).toEqual([
      "/app/products",
      chaveDoGrupo("analise"),
      chaveDoGrupo("ia"),
      CHAVE_TRAVADA,
    ]);
  });

  it("oculto e reordenado ao mesmo tempo: some, e a ordem dos outros vale", () => {
    const secoes = barraLateral(
      false,
      "admin",
      undefined,
      prefs(["/app/inbox"], ["/app/agenda", "/app/inbox"]),
    );
    expect(chavesDe(secoes, "principal").slice(0, 2)).toEqual(["/app/agenda", "/app/inicio"]);
    expect(chavesDe(secoes, "principal")).not.toContain("/app/inbox");
  });
});

describe("nomes da organização", () => {
  const nomes = (n: Record<string, string>): PersonalizacaoDaBarra => ({ nomes: n });
  const linha = (secoes: ReturnType<typeof barraLateral>, chave: string) =>
    secoes.flatMap((s) => s.itens).find((i) => i.chave === chave)!;

  it("renomeia a linha de destino e a de grupo, e marca como nome próprio (sem tradução)", () => {
    const secoes = barraLateral(
      false,
      "admin",
      undefined,
      nomes({ "/app/inbox": "Atendimento", [chaveDoGrupo("ia")]: "Robôs" }),
    );
    expect(linha(secoes, "/app/inbox")).toMatchObject({ label: "Atendimento", nomeProprio: true });
    expect(linha(secoes, chaveDoGrupo("ia"))).toMatchObject({ label: "Robôs", nomeProprio: true });
    expect(linha(secoes, "/app/inicio")).toMatchObject({ label: "Início", nomeProprio: false });
  });

  it("não renomeia o submenu: só a linha de topo", () => {
    const secoes = barraLateral(
      false,
      "admin",
      undefined,
      nomes({ "/app/radar": "Esfriados", [chaveDoGrupo("ia")]: "Robôs" }),
    );
    const inbox = linha(secoes, "/app/inbox");
    expect(inbox.submenu.map((s) => s.label)).toContain("Radar");
    expect(linha(secoes, chaveDoGrupo("ia")).submenu.map((s) => s.label)).toContain("Agentes");
  });

  it("espaços sobrando são cortados; vazio, texto longo demais e valor que não é texto voltam ao padrão", () => {
    const secoes = barraLateral(
      false,
      "admin",
      undefined,
      nomes({
        "/app/inbox": "  Conversas  ",
        "/app/leads": "   ",
        "/app/contacts": "x".repeat(LIMITE_DO_NOME + 1),
        "/app/tasks": 5 as unknown as string,
      }),
    );
    expect(linha(secoes, "/app/inbox").label).toBe("Conversas");
    expect(linha(secoes, "/app/leads").label).toBe("Leads");
    expect(linha(secoes, "/app/contacts").label).toBe("Contatos");
    expect(linha(secoes, "/app/tasks").label).toBe("Tarefas");
  });

  it("aceita exatamente 40 caracteres", () => {
    const quarenta = "n".repeat(LIMITE_DO_NOME);
    expect(
      linha(
        barraLateral(false, "admin", undefined, nomes({ "/app/inbox": quarenta })),
        "/app/inbox",
      ).label,
    ).toBe(quarenta);
  });

  it("Configurações pode ser renomeada (só não pode sumir)", () => {
    expect(
      linha(
        barraLateral(false, "admin", undefined, nomes({ [CHAVE_TRAVADA]: "Ajustes" })),
        CHAVE_TRAVADA,
      ).label,
    ).toBe("Ajustes");
  });
});

describe("a restrição do admin vence a preferência pessoal", () => {
  it("a pessoa não traz de volta o que a interface do vínculo tirou", () => {
    const secoes = barraLateral(
      false,
      "admin",
      { preset: "completa", destinos: ["/app/inbox", "/app/kanban"] },
      {
        preferencias: { ocultos: [], ordem: ["/app/leads", "/app/agenda", "/app/kanban"] },
        nomes: { "/app/leads": "Clientes" },
      },
    );
    const chaves = chavesDe(secoes);
    expect(chaves).not.toContain("/app/leads");
    expect(chaves).not.toContain("/app/agenda");
    expect(chaves[0]).toBe("/app/kanban");
    expect(secoes.flatMap((s) => s.itens).some((i) => i.label === "Clientes")).toBe(false);
  });

  it("o papel também vence: agent não ganha Disparo por tê-lo na ordem", () => {
    const secoes = barraLateral(
      false,
      "agent",
      undefined,
      prefs([], ["/app/disparo", "/app/inbox"]),
    );
    expect(chavesDe(secoes)).not.toContain("/app/disparo");
    expect(chavesDe(secoes, "principal")[0]).toBe("/app/inbox");
  });

  it("subpágina promovida (manager vê Webhooks sem Conexões) também se oculta e se renomeia pela chave dela", () => {
    const oculta = barraLateral(false, "manager", undefined, prefs(["/app/webhooks"]));
    expect(chavesDe(oculta)).not.toContain("/app/webhooks");
    const renomeada = barraLateral(false, "manager", undefined, {
      nomes: { "/app/webhooks": "Avisos" },
    });
    expect(renomeada.flatMap((s) => s.itens).find((i) => i.chave === "/app/webhooks")?.label).toBe(
      "Avisos",
    );
  });
});

describe("barraParaPersonalizar() — o que a tela de Personalizar lista", () => {
  it("devolve também as linhas ocultas, marcadas, na ordem pessoal, com o nome padrão", () => {
    const secoes = barraParaPersonalizar(false, "admin", undefined, {
      preferencias: { ocultos: ["/app/leads"], ordem: ["/app/agenda"] },
      nomes: { "/app/inbox": "Conversas" },
    });
    const principal = secoes.find((s) => s.secao.id === "principal")!.itens;
    expect(principal[0]!.chave).toBe("/app/agenda");
    const leads = principal.find((i) => i.chave === "/app/leads")!;
    expect(leads).toMatchObject({ oculto: true, fixo: false, nomePadrao: "Leads" });
    const inbox = principal.find((i) => i.chave === "/app/inbox")!;
    expect(inbox).toMatchObject({ label: "Conversas", nomePadrao: "Inbox", nomeProprio: true });
  });

  it("marca Configurações como fixa e nunca como oculta", () => {
    const itens = barraParaPersonalizar(false, "viewer", undefined, prefs([CHAVE_TRAVADA])).flatMap(
      (s) => s.itens,
    );
    expect(itens.find((i) => i.chave === CHAVE_TRAVADA)).toMatchObject({
      fixo: true,
      oculto: false,
    });
  });

  it("segue a mesma restrição de papel e de interface da barra", () => {
    const chaves = barraParaPersonalizar(false, "agent").flatMap((s) =>
      s.itens.map((i) => i.chave),
    );
    expect(chaves).not.toContain("/app/disparo");
    expect(chaves).toEqual(chavesDe(barraLateral(false, "agent")));
  });
});

describe("leitores (o que vem do banco nunca derruba a barra)", () => {
  it("lerPreferenciasDaBarra: forma errada vira vazio; só texto, sem repetição, sem a chave travada", () => {
    expect(lerPreferenciasDaBarra(null)).toEqual({ ocultos: [], ordem: [] });
    expect(lerPreferenciasDaBarra([])).toEqual({ ocultos: [], ordem: [] });
    expect(lerPreferenciasDaBarra({ ocultos: "x", ordem: 3 })).toEqual({ ocultos: [], ordem: [] });
    expect(
      lerPreferenciasDaBarra({
        ocultos: ["/app/leads", "/app/leads", 4, CHAVE_TRAVADA, ""],
        ordem: ["/app/agenda", null],
      }),
    ).toEqual({ ocultos: ["/app/leads"], ordem: ["/app/agenda"] });
  });

  it("lerNomesDaBarra: só texto aparado, não vazio e dentro do limite", () => {
    expect(lerNomesDaBarra("x")).toEqual({});
    expect(lerNomesDaBarra({ a: " Um ", b: "", c: 1, d: "y".repeat(41) })).toEqual({ a: "Um" });
  });
});

describe("schemas das Server Actions", () => {
  it("preferências: aceita o formato, tira repetida e a chave travada", () => {
    const r = preferenciasDaBarraSchema.parse({
      ocultos: ["/app/leads", "/app/leads", CHAVE_TRAVADA, "grupo:ia"],
      ordem: ["/app/agenda", "/app/agenda"],
    });
    expect(r).toEqual({ ocultos: ["/app/leads", "grupo:ia"], ordem: ["/app/agenda"] });
  });

  it("preferências: recusa campo extra, chave fora do formato e lista grande demais", () => {
    expect(preferenciasDaBarraSchema.safeParse({ ocultos: [], ordem: [], extra: 1 }).success).toBe(
      false,
    );
    expect(
      preferenciasDaBarraSchema.safeParse({ ocultos: ["javascript:alert(1)"], ordem: [] }).success,
    ).toBe(false);
    expect(preferenciasDaBarraSchema.safeParse({ ocultos: ["/APP/x"], ordem: [] }).success).toBe(
      false,
    );
    expect(preferenciasDaBarraSchema.safeParse({ ocultos: [], ordem: 3 }).success).toBe(false);
    const muitas = Array.from({ length: 201 }, (_, i) => `/app/t${i}`);
    expect(preferenciasDaBarraSchema.safeParse({ ocultos: muitas, ordem: [] }).success).toBe(false);
  });

  it("nomes: apara, descarta vazio e aceita 40", () => {
    expect(
      nomesDaBarraSchema.parse({
        "/app/inbox": "  Conversas ",
        "/app/leads": "  ",
        "grupo:ia": "n".repeat(40),
      }),
    ).toEqual({
      "/app/inbox": "Conversas",
      "grupo:ia": "n".repeat(40),
    });
  });

  it("nomes: recusa 41 caracteres, chave fora do formato e valor que não é texto", () => {
    expect(nomesDaBarraSchema.safeParse({ "/app/inbox": "n".repeat(41) }).success).toBe(false);
    expect(nomesDaBarraSchema.safeParse({ inbox: "Ok" }).success).toBe(false);
    expect(nomesDaBarraSchema.safeParse({ "/app/inbox": 3 }).success).toBe(false);
  });
});

describe("ordenarBloco()", () => {
  it("estável: sem ordem salva devolve o bloco como está, com a travada no fim", () => {
    const itens = [{ chave: "a" }, { chave: CHAVE_TRAVADA }, { chave: "b" }];
    expect(ordenarBloco(itens, []).map((i) => i.chave)).toEqual(["a", "b", CHAVE_TRAVADA]);
  });
});

describe("moverItem()", () => {
  const bloco = [{ chave: "a" }, { chave: "b" }, { chave: "c" }, { chave: CHAVE_TRAVADA }];
  const chaves = (l: { chave: string }[]) => l.map((i) => i.chave);

  it("sobe e desce uma posição, sem mexer no original", () => {
    expect(chaves(moverItem(bloco, "b", -1))).toEqual(["b", "a", "c", CHAVE_TRAVADA]);
    expect(chaves(moverItem(bloco, "b", 1))).toEqual(["a", "c", "b", CHAVE_TRAVADA]);
    expect(chaves(bloco)).toEqual(["a", "b", "c", CHAVE_TRAVADA]);
  });

  it("nas pontas não faz nada", () => {
    expect(chaves(moverItem(bloco, "a", -1))).toEqual(chaves(bloco));
  });

  it("ninguém passa de Configurações, e ela não se move", () => {
    expect(chaves(moverItem(bloco, "c", 1))).toEqual(chaves(bloco));
    expect(chaves(moverItem(bloco, CHAVE_TRAVADA, -1))).toEqual(chaves(bloco));
  });

  it("chave que não está no bloco não muda nada", () => {
    expect(chaves(moverItem(bloco, "z", 1))).toEqual(chaves(bloco));
  });
});

describe("a porta da tela Personalizar não depende da interface do vínculo", () => {
  const PORTA = "/app/settings/personalizar";
  // `simplificada` e uma lista de `destinos` gravada ANTES desta feature (não a conhece): as duas
  // são listas de itens permitidos, e a tela nova não estaria em nenhuma delas.
  const interfaces: Record<string, InterfaceSettings> = {
    simplificada: { preset: "simplificada" },
    "lista antiga": { preset: "completa", destinos: ["/app/inbox", "/app/kanban"] },
    "só o hub de CRM": { preset: "completa", destinos: ["/app/products"] },
  };

  for (const [nome, settings] of Object.entries(interfaces)) {
    for (const papel of ["viewer", "agent", "manager", "admin"] as const) {
      it(`${nome}, ${papel}: aparece no hub de Configurações e no ⌘K, e NÃO no submenu da barra (a porta é o botão Personalizar)`, () => {
        const hub = hubSections("organizacao", false, papel, settings).flatMap((s) =>
          s.items.map((d) => d.href),
        );
        expect(hub).toContain(PORTA);
        expect(searchable(false, papel, settings).map((d) => d.href)).toContain(PORTA);
        const secoes = barraLateral(false, papel, settings);
        const submenu = secoes.flatMap((s) => s.itens.flatMap((i) => i.submenu.map((x) => x.href)));
        // Prova de que o teste olha uma barra de verdade: a linha de Configurações existe e o
        // submenu dela tem conteúdo. Sem isto, `not.toContain` passaria também com a barra vazia
        // ou com a linha sumida (achado 3 da revisão).
        const configuracoes = secoes
          .flatMap((s) => s.itens)
          .find((i) => i.chave === CHAVE_TRAVADA);
        expect(configuracoes, "linha de Configurações na barra").toBeDefined();
        expect(configuracoes!.submenu.length, "submenu de Configurações").toBeGreaterThan(0);
        expect(submenu.length).toBeGreaterThan(0);
        // Desde o modo personalização (16/11/2026) a porta da barra é o botão do rodapé, que
        // não depende da interface: o submenu de Configurações não lista mais a tela.
        expect(submenu).not.toContain(PORTA);
      });
    }
  }

  it("ser essencial não conta como destino escolhido: a home continua a de antes", () => {
    expect(
      barraLateral(false, "agent", { preset: "completa", destinos: ["/app/inbox"] })[0]!.itens[0]!
        .href,
    ).toBe("/app/inbox");
  });
});

describe("chavesConhecidasDaBarra()", () => {
  it("é o universo de chaves possíveis, com ou sem permissão: destinos, hubs e grupos", () => {
    const conhecidas = chavesConhecidasDaBarra();
    for (const k of [
      "/app/inbox",
      "/app/webhooks",
      "/app/crm",
      "/app/settings",
      "grupo:ia",
      CHAVE_TRAVADA,
    ]) {
      expect(conhecidas.has(k), k).toBe(true);
    }
    expect(conhecidas.has("/app/rota-que-saiu")).toBe(false);
    expect(conhecidas.has("grupo:fantasma")).toBe(false);
  });

  it("toda linha de qualquer barra, de qualquer papel, tem chave conhecida", () => {
    const conhecidas = chavesConhecidasDaBarra();
    for (const papel of ["viewer", "agent", "manager", "admin"] as const) {
      for (const k of chavesDe(barraLateral(false, papel)))
        expect(conhecidas.has(k), `${papel} ${k}`).toBe(true);
    }
    for (const k of chavesDe(
      barraLateral(false, "manager", { preset: "completa", destinos: ["/app/products"] }),
    )) {
      expect(conhecidas.has(k), k).toBe(true);
    }
  });
});
