import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { primeiroNome } from "./MenuDoUsuario";
import { tituloDaTela } from "./Topo";

describe("o título do topo", () => {
  it("é o nome da tela do catálogo, pelo casamento mais longo", () => {
    expect(tituloDaTela("/app/inbox")).toBe("Inbox");
    expect(tituloDaTela("/app/settings/marca")).toBe("Marca");
    expect(tituloDaTela("/app/settings")).toBe("Configurações");
    expect(tituloDaTela("/app/ai")).toBe("Agente de IA");
    expect(tituloDaTela("/app/ai/agents/123")).toBe("Agentes");
  });

  it("rota fora do catálogo não inventa título", () => {
    expect(tituloDaTela("/app/qualquer-coisa")).toBeNull();
  });

  it("o 'Olá' usa o primeiro nome, ou a parte local do e-mail sem nome", () => {
    expect(primeiroNome("Fulano Santos", "p@x.test")).toBe("Fulano");
    expect(primeiroNome(null, "fulano@x.test")).toBe("fulano");
    expect(primeiroNome("   ", "ana@x.test")).toBe("ana");
  });
});

// Em 375 px o grupo da direita do topo passava 7 px da borda e cortava o avatar.
// O jsdom não mede layout: a conta usa as larguras medidas na prova real (o botão do menu, 36 px; o
// conteúdo do grupo da direita sem os vãos e sem a margem do avatar, 306 - 4 x 4 - 6 = 284 px) e as classes
// que valem até 520 px. A soma tem de caber em 375 px, com o respiro das bordas.
describe("o topo cabe em 375 px", () => {
  const fonte = readFileSync(join(process.cwd(), "components", "app", "Topo.tsx"), "utf8");
  const PX_POR_UNIDADE = 4;
  const BOTAO_DO_MENU = 36;
  const CONTEUDO_DO_GRUPO = 284;
  const VAOS_DO_GRUPO = 4; // seletor de organização, idioma, busca, alertas e avatar

  function classeDe(trecho: RegExp): string {
    const m = trecho.exec(fonte);
    if (!m) throw new Error(`classe não achada: ${trecho}`);
    return m[1]!;
  }
  /** O valor que vale em 375 px: o do `max-[520px]:` se houver, senão o da classe sem prefixo. */
  function espaco(classes: string, nome: string): number {
    const lista = classes.split(/\s+/);
    const estreito = lista.find((c) => c.startsWith(`max-[520px]:${nome}-`));
    const base = lista.find((c) => c.startsWith(`${nome}-`));
    const valor = (estreito ?? base)?.split("-").pop();
    return valor ? Number(valor) * PX_POR_UNIDADE : 0;
  }

  it("menu, vãos, grupo da direita e as duas bordas somam no máximo 375 px", () => {
    const header = classeDe(/<header className="([^"]+)"/);
    const grupo = classeDe(/<div className="(ml-auto[^"]+)"/);
    const avatar = classeDe(/aria-label=\{t\("Menu do usuário"\)\} className="([^"]+)"/);
    const total =
      2 * espaco(header, "px") +
      BOTAO_DO_MENU +
      2 * espaco(header, "gap") +
      CONTEUDO_DO_GRUPO +
      VAOS_DO_GRUPO * espaco(grupo, "gap") +
      espaco(avatar, "ml");
    expect(total).toBeLessThanOrEqual(375);
  });
});
