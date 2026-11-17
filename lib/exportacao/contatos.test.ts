// @vitest-environment node
import { describe, expect, it } from "vitest";

import { bancoFalso, type Linha } from "@/tests/helpers/postgrest-falso";

import { prepararExportacaoDeContatos } from "./contatos";

const ORG = "11111111-1111-4111-8111-111111111111";
const OUTRA_ORG = "99999999-9999-4999-8999-999999999999";
const t = (texto: string) => texto;

function contato(n: number, extra: Linha = {}): Linha {
  return {
    id: `c-${String(n).padStart(6, "0")}`,
    organization_id: ORG,
    display_name: `Contato ${n}`,
    name: `Nome ${n}`,
    phone_number: `+5511999${String(n).padStart(6, "0")}`,
    email: `c${n}@exemplo.com`,
    tags: [],
    source: "manual",
    created_at: "2026-11-01T12:00:00.000Z",
    custom_fields: {},
    is_anonymized: false,
    is_merged_into: null,
    ...extra,
  };
}

async function tudo(prep: Awaited<ReturnType<typeof prepararExportacaoDeContatos>>): Promise<string[][]> {
  const linhas: string[][] = [];
  for await (const pagina of prep.paginas()) linhas.push(...pagina);
  return linhas;
}

describe("exportação de contatos — colunas", () => {
  it("cabeçalho fixo na ordem da decisão + uma coluna por chave de campo personalizado (ordenadas)", async () => {
    const { db } = bancoFalso({
      contacts: [
        contato(1, { custom_fields: { plano: "pro", cidade: "Recife" } }),
        contato(2, { custom_fields: { aniversario: "10/10" } }),
      ],
    });
    const prep = await prepararExportacaoDeContatos(db, ORG, {}, t);
    expect(prep.cabecalho).toEqual([
      "Nome exibido",
      "Nome",
      "Telefone",
      "E-mail",
      "Etiquetas",
      "Origem",
      "Criado em",
      "aniversario",
      "cidade",
      "plano",
    ]);
  });

  it("linha: nome exibido pelo rótulo canônico, etiquetas separadas por |, campos personalizados nas colunas certas", async () => {
    const { db } = bancoFalso({
      contacts: [
        contato(1, {
          display_name: "Maria",
          name: "Maria Silva",
          tags: ["vip", "lead-quente"],
          source: "import_csv",
          custom_fields: { cidade: "Recife", filhos: 2, extra: { a: 1 } },
        }),
        contato(2, { display_name: null, name: null, phone_number: "+5511900000002", custom_fields: {} }),
      ],
    });
    const prep = await prepararExportacaoDeContatos(db, ORG, {}, t);
    const linhas = await tudo(prep);
    const col = (nome: string) => prep.cabecalho.indexOf(nome);
    expect(linhas).toHaveLength(2);
    const maria = linhas[0]!;
    expect(maria[col("Nome exibido")]).toBe("Maria");
    expect(maria[col("Nome")]).toBe("Maria Silva");
    expect(maria[col("Telefone")]).toBe("+5511999000001");
    expect(maria[col("E-mail")]).toBe("c1@exemplo.com");
    expect(maria[col("Etiquetas")]).toBe("vip|lead-quente");
    expect(maria[col("Origem")]).toBe("import_csv");
    expect(maria[col("Criado em")]).toBe("2026-11-01T12:00:00.000Z");
    expect(maria[col("cidade")]).toBe("Recife");
    expect(maria[col("filhos")]).toBe("2");
    expect(maria[col("extra")]).toBe('{"a":1}');
    // Sem nome nenhum, o rótulo cai para o telefone — a mesma regra da tela.
    const semNome = linhas[1]!;
    expect(semNome[col("Nome exibido")]).not.toBe("");
    expect(semNome[col("Nome")]).toBe("");
    expect(semNome[col("cidade")]).toBe("");
  });

  it("campo personalizado com o mesmo nome de uma coluna fixa não colide", async () => {
    const { db } = bancoFalso({ contacts: [contato(1, { custom_fields: { Telefone: "x" } })] });
    const prep = await prepararExportacaoDeContatos(db, ORG, {}, t);
    expect(new Set(prep.cabecalho.map((c) => c.toLowerCase())).size).toBe(prep.cabecalho.length);
  });

  it("os cabeçalhos passam por t()", async () => {
    const { db } = bancoFalso({ contacts: [contato(1)] });
    const prep = await prepararExportacaoDeContatos(db, ORG, {}, (s) => `[${s}]`);
    expect(prep.cabecalho[0]).toBe("[Nome exibido]");
    expect(prep.cabecalho).toContain("[E-mail]");
  });
});

describe("exportação de contatos — escopo", () => {
  it("ISOLAMENTO: só sai contato da organização, mesmo havendo outra no mesmo banco", async () => {
    const { db } = bancoFalso({
      contacts: [contato(1), contato(2, { organization_id: OUTRA_ORG, display_name: "Da Outra Org" })],
    });
    const linhas = await tudo(await prepararExportacaoDeContatos(db, ORG, {}, t));
    expect(linhas).toHaveLength(1);
    expect(JSON.stringify(linhas)).not.toContain("Da Outra Org");
  });

  it("não exporta lápide de fusão (is_merged_into)", async () => {
    const { db } = bancoFalso({
      contacts: [contato(1), contato(2, { is_merged_into: "c-000001", display_name: "Lápide" })],
    });
    const linhas = await tudo(await prepararExportacaoDeContatos(db, ORG, {}, t));
    expect(linhas).toHaveLength(1);
    expect(JSON.stringify(linhas)).not.toContain("Lápide");
  });

  it("filtros: tag, origem e busca — os mesmos da listagem", async () => {
    const { db } = bancoFalso({
      contacts: [
        contato(1, { tags: ["vip"], source: "whatsapp", display_name: "Ana Souza" }),
        contato(2, { tags: ["vip"], source: "manual", display_name: "Ana Lima" }),
        contato(3, { tags: [], source: "whatsapp", display_name: "Ana Dias" }),
        contato(4, { tags: ["vip"], source: "whatsapp", display_name: "Bruno" }),
      ],
    });
    const prep = await prepararExportacaoDeContatos(db, ORG, { tag: "vip", source: "whatsapp", search: "ana" }, t);
    const linhas = await tudo(prep);
    expect(linhas.map((l) => l[0])).toEqual(["Ana Souza"]);
  });
});

describe("exportação de contatos — busca", () => {
  it("curinga do LIKE na busca (% e _) é texto, não coringa: a vírgula não injeta condição no or()", async () => {
    const { db, consultas } = bancoFalso({
      contacts: [
        contato(1, { display_name: "Promo 100% off" }),
        contato(2, { display_name: "Promoção 1000 off" }),
        contato(3, { display_name: "Silva, Maria" }),
      ],
    });
    const porPorcento = await tudo(await prepararExportacaoDeContatos(db, ORG, { search: "100%" }, t));
    expect(porPorcento.map((l) => l[0])).toEqual(["Promo 100% off"]);
    const filtro = consultas.map((c) => c.filtros.join(" ")).join(" ");
    expect(filtro).toContain("\\%");

    // A vírgula vira espaço: "Silva, Maria" vira o termo "Silva  Maria" e não abre uma condição nova no or().
    const porVirgula = await prepararExportacaoDeContatos(db, ORG, { search: "Silva, Maria" }, t);
    await tudo(porVirgula);
    for (const c of consultas.filter((c) => c.filtros.some((f) => f.startsWith("or:")))) {
      for (const f of c.filtros.filter((f) => f.startsWith("or:"))) {
        expect(f.split(",").every((cond) => /^(or:)?[a-z_]+\.(ilike|cs|eq)\./.test(cond))).toBe(true);
      }
    }
  });
});

describe("exportação de contatos — sigilo e LGPD", () => {
  it("nunca pede CPF, nascimento, consentimento nem identificadores técnicos ao banco", async () => {
    const { db, consultas } = bancoFalso({ contacts: [contato(1)] });
    await tudo(await prepararExportacaoDeContatos(db, ORG, {}, t));
    for (const c of consultas) {
      expect(c.colunas).not.toMatch(/cpf|birthdate|consent|wa_|source_metadata/i);
    }
  });

  it("contato anonimizado sai anonimizado: nome do banco, nada de dado pessoal, nem campos personalizados que sobraram", async () => {
    const { db } = bancoFalso({
      contacts: [
        contato(1, {
          display_name: "Cliente Anonimizado #7",
          name: "Cliente Anonimizado #7",
          phone_number: null,
          email: null,
          tags: [],
          is_anonymized: true,
          custom_fields: { endereco: "Rua Secreta 10" },
        }),
      ],
    });
    const prep = await prepararExportacaoDeContatos(db, ORG, {}, t);
    const linhas = await tudo(prep);
    expect(linhas[0]![0]).toBe("Cliente Anonimizado #7");
    expect(JSON.stringify(linhas)).not.toContain("Rua Secreta");
    expect(prep.cabecalho).not.toContain("endereco");
  });
});

describe("exportação de contatos — volume", () => {
  it("lê MAIS de 1.000 contatos (o PostgREST corta em 1.000) com .range() em páginas", async () => {
    const todos = Array.from({ length: 2500 }, (_, i) => contato(i + 1));
    const { db, consultas } = bancoFalso({ contacts: todos });
    const prep = await prepararExportacaoDeContatos(db, ORG, {}, t);
    const linhas = await tudo(prep);
    expect(linhas).toHaveLength(2500);
    // Sem repetir nem pular: cada telefone aparece uma vez.
    expect(new Set(linhas.map((l) => l[2])).size).toBe(2500);
    const faixas = consultas.filter((c) => c.faixa).map((c) => c.faixa);
    expect(faixas).toContainEqual([1000, 1999]);
    expect(faixas).toContainEqual([2000, 2999]);
    // Ordem total por id: sem ela, páginas repetem ou pulam linhas.
    expect(consultas.filter((c) => c.faixa).every((c) => c.ordem.includes("id"))).toBe(true);
  });

  it("entrega página por página (não junta a base inteira numa lista só)", async () => {
    const todos = Array.from({ length: 2500 }, (_, i) => contato(i + 1));
    const { db } = bancoFalso({ contacts: todos });
    const prep = await prepararExportacaoDeContatos(db, ORG, {}, t);
    const tamanhos: number[] = [];
    for await (const pagina of prep.paginas()) tamanhos.push(pagina.length);
    expect(tamanhos).toEqual([1000, 1000, 500]);
  });

  it("base vazia: só cabeçalho", async () => {
    const { db } = bancoFalso({ contacts: [] });
    const prep = await prepararExportacaoDeContatos(db, ORG, {}, t);
    expect(await tudo(prep)).toEqual([]);
    expect(prep.cabecalho).toHaveLength(7);
  });

  it("erro do banco na descoberta das colunas rejeita antes de qualquer byte", async () => {
    const { db } = bancoFalso({ contacts: [contato(1)] }, { falharEm: "contacts" });
    await expect(prepararExportacaoDeContatos(db, ORG, {}, t)).rejects.toThrow("banco caiu");
  });
});
