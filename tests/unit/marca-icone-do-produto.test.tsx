// @vitest-environment node
// `node`, e não o `jsdom` padrão: o `next/og` rasteriza com `sharp`, que recebe um
// Buffer — e no jsdom o `Uint8Array` é de outro realm, o que o sharp recusa
// ("Unsupported input"). O que se mede aqui não toca o DOM.
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import fs from "node:fs";
import path from "node:path";

import { SOL_DO_PRODUTO } from "@/lib/branding/arte-do-produto";
import { PRETO_DO_PRODUTO, SOL_PRETO_DO_PRODUTO } from "@/lib/branding/arte-do-servidor";
import {
  __esvaziarCacheDaImagem,
  chaveDaImagem,
  imagemEmCache,
  TTL_DA_IMAGEM_MS,
} from "@/lib/branding/cache-da-imagem";
import {
  cabecalhoDeEmail,
  desenhoDoCabecalhoDeEmail,
  desenhoDoIcone,
  iconeDaMarca,
  nomeDesenhavel,
} from "@/lib/branding/icone-imagem";
import { marcaDeSaidaFoiConfigurada } from "@/lib/branding/resolve";
import type * as IconeImagem from "@/lib/branding/icone-imagem";
import type { MarcaDeSaida } from "@/lib/branding/saida";

/**
 * O ícone da aba e do app: o SOL do produto quando ninguém configurou marca, e o
 * ladrilho da cor + inicial da marca quando alguém configurou.
 *
 * Mede o desenho (a decisão) com `renderToStaticMarkup`, e o PNG de verdade (que
 * o satori consegue desenhar esse desenho) com `ImageResponse` — a primeira sem a
 * segunda passaria com um JSX que o renderizador recusa.
 */

const marcaDaSaida = vi.hoisted(() => vi.fn());
vi.mock("@/lib/branding/saida", () => ({ marcaDaSaida }));
// O desenho de verdade, só que espiado: a rota chama `iconeDaMarca` por este módulo, e
// contar as chamadas é o que prova que o cache a poupa.
const desenhou = vi.hoisted(() => vi.fn());
vi.mock("@/lib/branding/icone-imagem", async (importarOriginal) => {
  const real = await importarOriginal<typeof IconeImagem>();
  desenhou.mockImplementation(real.iconeDaMarca);
  return { ...real, iconeDaMarca: desenhou };
});

const PADRAO: MarcaDeSaida = {
  nome: "CRM ALQUIM(IA)",
  logoUrl: null,
  accent: "#506d48",
  accentFg: "#ffffff",
  origens: { nome: "padrao", cor: "padrao" },
};
const COM_NOME: MarcaDeSaida = {
  ...PADRAO,
  nome: "Acme CRM",
  accent: "#2f6f4e",
  origens: { nome: "banco", cor: "banco" },
};
const COM_LOGO: MarcaDeSaida = { ...PADRAO, logoUrl: "https://cdn.exemplo.test/logo.png" };

const html = (marca: MarcaDeSaida, v: Parameters<typeof desenhoDoIcone>[1], lado = 64) =>
  renderToStaticMarkup(desenhoDoIcone(marca, v, lado));

describe("quem configurou marca", () => {
  it("é o nome vindo de qualquer camada OU um logo — o padrão não tem logo", () => {
    expect(marcaDeSaidaFoiConfigurada(PADRAO)).toBe(false);
    expect(marcaDeSaidaFoiConfigurada(COM_NOME)).toBe(true);
    expect(marcaDeSaidaFoiConfigurada(COM_LOGO)).toBe(true);
  });
});

describe("o desenho do ícone sem marca configurada", () => {
  it("aba clara: o sol PRETO sobre transparente, no tamanho todo", () => {
    const h = html(PADRAO, "aba-claro");
    expect(h).toContain(`src="${SOL_PRETO_DO_PRODUTO}"`);
    expect(h).toContain('width="64"');
    expect(h).not.toContain("background");
    expect(h).not.toContain(PRETO_DO_PRODUTO);
  });

  it("aba escura: o sol BRANCO", () => {
    const h = html(PADRAO, "aba-escuro");
    expect(h).toContain(`src="${SOL_DO_PRODUTO}"`);
    expect(h).not.toContain(SOL_PRETO_DO_PRODUTO);
  });

  it("app: sol branco sobre #111111, com respiro em volta", () => {
    const h = html(PADRAO, "app", 180);
    expect(h).toContain(`background:${PRETO_DO_PRODUTO}`);
    expect(h).toContain(`src="${SOL_DO_PRODUTO}"`);
    // 68% de 180 — o sol não encosta na borda do ícone.
    expect(h).toContain('width="122"');
  });

  it("o preto da marca é o do brandkit", () => {
    expect(PRETO_DO_PRODUTO).toBe("#111111");
  });
});

describe("o desenho do ícone com marca configurada: a marca vence, o sol some", () => {
  for (const variante of ["aba-claro", "aba-escuro", "app"] as const) {
    it(`${variante}: ladrilho da cor dela com a inicial`, () => {
      const h = html(COM_NOME, variante);
      expect(h).toContain("background:#2f6f4e");
      expect(h).toContain(">A<");
      expect(h).not.toContain("<img");
    });
  }

  it("só o logo configurado também tira o sol — a cor é a do produto, a inicial é a do nome", () => {
    const h = html(COM_LOGO, "aba-claro");
    expect(h).not.toContain("<img");
    expect(h).toContain(">C<");
  });
});

describe("o satori desenha de verdade", () => {
  const assinaturaPng = [0x89, 0x50, 0x4e, 0x47];

  async function png(resposta: Response): Promise<Uint8Array> {
    expect(resposta.status).toBe(200);
    expect(resposta.headers.get("content-type")).toBe("image/png");
    return new Uint8Array(await resposta.arrayBuffer());
  }

  it("as variantes viram PNG, com cache de 60s", async () => {
    for (const v of ["aba-claro", "aba-escuro", "app"] as const) {
      const r = iconeDaMarca(PADRAO, v, 64);
      expect(r.headers.get("cache-control")).toContain("max-age=60");
      const corpo = await png(r);
      expect([...corpo.subarray(0, 4)]).toEqual(assinaturaPng);
      expect(corpo.byteLength).toBeGreaterThan(300);
    }
  }, 30_000);

  it("o ladrilho da marca configurada vira PNG", async () => {
    const corpo = await png(iconeDaMarca(COM_NOME, "app", 180));
    expect([...corpo.subarray(0, 4)]).toEqual(assinaturaPng);
  }, 30_000);

  it("o cabeçalho de e-mail (sol + escrita) vira PNG de 300 x 80", async () => {
    const corpo = await png(cabecalhoDeEmail(PADRAO));
    expect([...corpo.subarray(0, 4)]).toEqual(assinaturaPng);
    // Largura e altura reais, do IHDR (o e-mail mostra em 150 x 40).
    const v = new DataView(corpo.buffer, corpo.byteOffset);
    expect([v.getUint32(16), v.getUint32(20)]).toEqual([300, 80]);
  }, 30_000);
});

describe("o cabeçalho do e-mail decide pela marca, na hora da leitura", () => {
  const h = (m: MarcaDeSaida) => renderToStaticMarkup(desenhoDoCabecalhoDeEmail(m));

  it("padrão: o sol preto e a escrita (preto e amarelo)", () => {
    const html = h(PADRAO);
    expect(html).toContain(`src="${SOL_PRETO_DO_PRODUTO}"`);
    expect(html).toContain('fill="#E7B94F"');
    expect(html).toContain(`fill="${PRETO_DO_PRODUTO}"`);
  });

  it("marca com NOME: o nome em texto preto — e nunca o sol nem a escrita do produto", () => {
    const html = h(COM_NOME);
    expect(html).toContain("Acme CRM");
    expect(html).toContain(`color:${PRETO_DO_PRODUTO}`);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("#E7B94F");
  });

  it("marca com LOGO: também o nome — o endereço do logo nunca é buscado", () => {
    const html = h(COM_LOGO);
    expect(html).toContain("CRM ALQUIM(IA)");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("cdn.exemplo.test");
  });

  it("o nome só leva o que o satori sabe desenhar (emoji e outros alfabetos o fazem buscar fonte na rede)", () => {
    expect(nomeDesenhavel("🚀  Ótimo   CRM — Ltda. 2º")).toBe("Ótimo CRM — Ltda. 2º");
    expect(nomeDesenhavel("日本語 CRM")).toBe("CRM");
    expect(nomeDesenhavel("🚀")).toBe("");
  });

  it("os três viram PNG, e o do nome NÃO é o do produto", async () => {
    const [a, b, c] = await Promise.all(
      [PADRAO, COM_NOME, { ...COM_NOME, nome: "🚀" }].map(async (m) => {
        const r = cabecalhoDeEmail(m);
        expect(r.status).toBe(200);
        return new Uint8Array(await r.arrayBuffer());
      }),
    );
    for (const png of [a, b, c]) expect([...png!.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(Buffer.from(a!).equals(Buffer.from(b!))).toBe(false);
  }, 30_000);
});

describe("o cache do PNG pronto", () => {
  beforeEach(() => __esvaziarCacheDaImagem());

  it("a chave separa variante e marca, e não depende do endereço do logo", () => {
    expect(chaveDaImagem("email", PADRAO)).not.toBe(chaveDaImagem("app-192", PADRAO));
    expect(chaveDaImagem("email", PADRAO)).not.toBe(chaveDaImagem("email", COM_NOME));
    expect(chaveDaImagem("email", COM_LOGO)).toBe(
      chaveDaImagem("email", { ...COM_LOGO, logoUrl: "https://outro.exemplo.test/x.png" }),
    );
  });

  it("gera uma vez por minuto; passado o TTL, gera de novo", async () => {
    const agora = 1_000;
    const gerar = vi.fn(async () => new ArrayBuffer(8));
    await imagemEmCache("k", gerar, () => agora);
    await imagemEmCache("k", gerar, () => agora + TTL_DA_IMAGEM_MS - 1);
    expect(gerar).toHaveBeenCalledTimes(1);
    await imagemEmCache("k", gerar, () => agora + TTL_DA_IMAGEM_MS + 1);
    expect(gerar).toHaveBeenCalledTimes(2);
  });

  it("chaves diferentes não se misturam, e quem lança não deixa rastro", async () => {
    const a = new ArrayBuffer(1);
    const b = new ArrayBuffer(2);
    expect(await imagemEmCache("a", async () => a)).toBe(a);
    expect(await imagemEmCache("b", async () => b)).toBe(b);
    await expect(
      imagemEmCache("falha", async () => {
        throw new Error("satori caiu");
      }),
    ).rejects.toThrow("satori caiu");
    const ok = new ArrayBuffer(3);
    expect(await imagemEmCache("falha", async () => ok)).toBe(ok);
  });

  it("o teto de entradas não deixa o mapa crescer sem limite", async () => {
    for (let i = 0; i < 100; i++) await imagemEmCache(`k${i}`, async () => new ArrayBuffer(1));
    const gerar = vi.fn(async () => new ArrayBuffer(1));
    await imagemEmCache("k0", gerar); // a primeira já foi expulsa
    expect(gerar).toHaveBeenCalledTimes(1);
    await imagemEmCache("k99", gerar); // a última segue guardada
    expect(gerar).toHaveBeenCalledTimes(1);
  });
});

describe("o PNG em base64 que só o servidor usa fica fora do bundle do navegador", () => {
  const RAIZ = process.cwd();
  const varrer = (dir: string): string[] =>
    fs.readdirSync(path.join(RAIZ, dir), { withFileTypes: true }).flatMap((e) => {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) return varrer(rel);
      return /\.(ts|tsx)$/.test(e.name) ? [rel] : [];
    });

  it('nenhum componente, hook nem módulo "use client" importa `arte-do-servidor`', () => {
    const culpados = [...varrer("components"), ...varrer("hooks"), ...varrer("app"), ...varrer("lib")]
      .filter((f) => {
        const src = fs.readFileSync(path.join(RAIZ, f), "utf8");
        if (!/arte-do-servidor/.test(src)) return false;
        return (
          f.startsWith("components/") || f.startsWith("hooks/") || /^\s*["']use client["']/m.test(src)
        );
      });
    expect(culpados).toEqual([]);
  });

  it("e lib/branding não importa de components (a arte compartilhada mora em lib/branding)", () => {
    const culpados = varrer("lib/branding").filter((f) =>
      /from "@\/components\//.test(fs.readFileSync(path.join(RAIZ, f), "utf8")),
    );
    expect(culpados).toEqual([]);
  });
});

describe("a rota das variantes", () => {
  beforeEach(() => {
    __esvaziarCacheDaImagem();
    marcaDaSaida.mockReset();
    marcaDaSaida.mockResolvedValue(PADRAO);
  });

  async function pedir(variante: string): Promise<Response> {
    const { GET } = await import("@/app/icone-da-marca/[variante]/route");
    return GET(new Request(`http://x.test/icone-da-marca/${variante}`), {
      params: Promise.resolve({ variante }),
    });
  }

  it.each(["aba-escuro", "app-192", "app-512", "email"])(
    "%s responde PNG",
    async (v) => {
      const r = await pedir(v);
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toBe("image/png");
    },
    30_000,
  );

  it.each(["", "app-9999", "constructor", "__proto__", "../icon", "toString"])(
    "%j é recusada com 404 — lista fechada, nada de tamanho livre",
    async (v) => {
      const r = await pedir(v);
      expect(r.status).toBe(404);
    },
  );

  it("a imagem do e-mail muda com a marca: padrão, NOME e LOGO dão PNGs diferentes", async () => {
    const corpo = async (m: MarcaDeSaida) => {
      __esvaziarCacheDaImagem();
      marcaDaSaida.mockResolvedValue(m);
      const r = await pedir("email");
      expect(r.status).toBe(200);
      return Buffer.from(await r.arrayBuffer());
    };
    const padrao = await corpo(PADRAO);
    const nome = await corpo(COM_NOME);
    const logo = await corpo(COM_LOGO);
    expect(nome.equals(padrao)).toBe(false);
    expect(logo.equals(padrao)).toBe(false);
    // Os dois mostram o nome, mas o nome é outro ("CRM ALQUIM(IA)" x "Acme CRM").
    expect(logo.equals(nome)).toBe(false);
  }, 60_000);

  it("pedidos repetidos no minuto saem do cache: o desenho roda uma vez por (variante, marca)", async () => {
    desenhou.mockClear();
    const a = Buffer.from(await (await pedir("app-192")).arrayBuffer());
    const a2 = Buffer.from(await (await pedir("app-192")).arrayBuffer());
    expect(desenhou).toHaveBeenCalledTimes(1);
    expect(a2.equals(a)).toBe(true);

    // Outra variante e outra marca são outras chaves.
    await pedir("app-512");
    expect(desenhou).toHaveBeenCalledTimes(2);
    marcaDaSaida.mockResolvedValue(COM_NOME);
    const b = Buffer.from(await (await pedir("app-192")).arrayBuffer());
    expect(desenhou).toHaveBeenCalledTimes(3);
    expect(b.equals(a)).toBe(false);
  }, 30_000);

  it("o app-512 tem 512 px de verdade", async () => {
    const r = await pedir("app-512");
    const corpo = new Uint8Array(await r.arrayBuffer());
    const v = new DataView(corpo.buffer, corpo.byteOffset);
    expect([v.getUint32(16), v.getUint32(20)]).toEqual([512, 512]);
  }, 30_000);
});
