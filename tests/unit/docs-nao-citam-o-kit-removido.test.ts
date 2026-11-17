import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Esta versão instala local pelo `scripts/instalar.*` com o `docker-compose.yml` da raiz. O kit de VPS
 * (`setup-kit/` e os scripts dele), os composes de produção e a publicação de imagens saíram. Documento que manda
 * alguém para eles leva a um comando quebrado — e quem contribui com agente lê `.md` como regra.
 *
 * Varre:
 *   - TODO `.md` rastreado, menos a história declarada em `HISTORIA` (não é regra viva);
 *   - os modelos de e-mail em `supabase/templates/*.html` (a tela de login manda a pessoa para eles);
 *   - os textos de tela: `app/`, `components/`, `hooks/` e `lib/i18n/`, SEM comentários (comentário de código
 *     não chega a quem usa o sistema; string e JSX chegam).
 * Migrations e `baseline.sql` ficam fora: comentário de SQL aplicado é imutável.
 */
const RAIZ = path.resolve(__dirname, "../..");

/** Nomes de arquivo que não existem mais nesta versão: citados em qualquer lugar varrido, reprovam. */
const PROIBIDOS = [
  "setup-kit/",
  "docker-compose.prod.yml",
  "docker-compose.traefik.yml",
  "docker-compose.build.yml",
  "publish-image.yml",
];

/** O kit e os scripts dele, com ou sem caminho (`setup-kit` sem barra, `update.sh` solto). */
const NOMES_DO_KIT = /\bsetup-kit\b|(?<![\w-])(?:update|agent|install|restore|marca-emails)\.sh\b/;

/**
 * O kit em PROSA, sem nome de script ("o kit self-host recebe", "o stack de produção do kit"). "Kit" sozinho
 * não entra: o produto tem "kit visual" e o "kit" de oferta do motor de disparo. Linha que diz que o kit
 * saiu (removido, não há) não manda ninguém a ele e passa.
 */
const KIT_EM_PROSA = /\bkit self-host\b|\bkit de (?:instala[çc][ãa]o|vps)\b|\b(?:stack de produção|update) do kit\b/i;
const DIZ_QUE_SAIU = /removid|não há|no hay|no forman parte|not part of/i;

/**
 * História e planejamento: descrevem o que foi medido ou o que SERIA construído, e não mandam ninguém rodar nada.
 * Lista explícita; entrada nova precisa do mesmo argumento.
 */
const HISTORIA = [
  "docs/testing/", // mapa de jornadas e handoffs: achados medidos numa VPS da origem
  "docs/design/", // documentos de desenho de ondas já entregues
  "docs/stories/", // épicos e histórias de planejamento
  "docs/specs/", // especificações (o que seria construído)
  "docs/architecture/", // mapas de arquitetura gerados (README e .json)
  "supabase/migrations/", // MANIFEST: o porquê de cada migration aplicada
];

/** `scripts/<arquivo>.<ext>` citado: o arquivo tem de existir. */
const CAMINHO_DE_SCRIPT = /(?<![\w./-])scripts\/[\w./-]+\.(?:sh|ps1|ts|mjs|js|sql|py)\b/g;

const PLANEJAMENTO = ["docs/specs/", "docs/stories/"];

/** O runbook cita o script e, na mesma frase, diz que ele ainda não existe (aceito também no outro gate de docs). */
const PONTEIROS_ACEITOS = new Set(["docs/runbooks/ai-credentials-rotation.md::scripts/rotate-ai-cred-aes-key.ts"]);

function rastreados(...padroes: string[]): string[] {
  const saida = execFileSync("git", ["ls-files", "-z", "--", ...padroes], { cwd: RAIZ, encoding: "utf8" });
  return saida.split("\0").filter((f) => f && fs.existsSync(path.join(RAIZ, f)));
}
const mdRastreados = () => rastreados("*.md");

/** Tira comentários de TS/TSX (bloco, JSX `{/* *\/}` e linha), preservando as quebras para o número da linha. */
function semComentariosTs(fonte: string): string {
  return fonte
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

function achadosDoKit(arquivos: string[], limpar: (f: string) => string = (f) => f): string[] {
  const achados: string[] = [];
  for (const f of arquivos) {
    const linhas = limpar(fs.readFileSync(path.join(RAIZ, f), "utf8")).split("\n");
    linhas.forEach((linha, i) => {
      for (const p of PROIBIDOS) if (linha.includes(p)) achados.push(`${f}:${i + 1} ${p}`);
      const m = NOMES_DO_KIT.exec(linha);
      if (m && !PROIBIDOS.some((p) => linha.includes(p))) achados.push(`${f}:${i + 1} ${m[0]}`);
      const prosa = KIT_EM_PROSA.exec(linha);
      if (prosa && !DIZ_QUE_SAIU.test(linha)) achados.push(`${f}:${i + 1} ${prosa[0]}`);
    });
  }
  return achados;
}

describe("documentação não cita o kit removido", () => {
  const arquivos = mdRastreados();
  const vivos = arquivos.filter((f) => !HISTORIA.some((h) => f.startsWith(h)));

  it("controle: a varredura enxerga os .md e o padrão reconhece cada nome do kit", () => {
    expect(arquivos.length).toBeGreaterThan(50);
    expect(arquivos).toContain("README.md");
    expect(vivos).toContain("CLAUDE.md");
    for (const nome of ["setup-kit", "setup-kit/x", "update.sh", "agent.sh", "install.sh", "restore.sh", "marca-emails.sh"]) {
      expect(NOMES_DO_KIT.test(`rode o ${nome} agora`), nome).toBe(true);
    }
    for (const frase of ["o kit self-host recebe as mudanças", "kit de instalação com 1 comando", "O stack de produção do kit inclui"]) {
      expect(KIT_EM_PROSA.test(frase), frase).toBe(true);
    }
    for (const ok of ["kit visual da Agenda", "links do kit e do de cima", "removido com o kit de instalação"]) {
      expect(KIT_EM_PROSA.test(ok) && !DIZ_QUE_SAIU.test(ok), ok).toBe(false);
    }
    // O que existe nesta versão não casa.
    for (const ok of ["scripts/instalar.sh", "test-update-com-dados.sh", "pnpm install", "agente.sh"]) {
      expect(NOMES_DO_KIT.test(ok), ok).toBe(false);
    }
  });

  it("nenhum .md vivo cita o kit, os scripts dele, os composes de produção nem publish-image.yml", () => {
    expect(achadosDoKit(vivos)).toEqual([]);
  });

  it("os .md de história também não citam os composes de produção nem publish-image.yml", () => {
    const historia = arquivos.filter((f) => HISTORIA.some((h) => f.startsWith(h)));
    const achados: string[] = [];
    for (const f of historia) {
      fs.readFileSync(path.join(RAIZ, f), "utf8")
        .split("\n")
        .forEach((linha, i) => {
          for (const p of PROIBIDOS) if (linha.includes(p)) achados.push(`${f}:${i + 1} ${p}`);
        });
    }
    expect(achados).toEqual([]);
  });

  it("os modelos de e-mail (supabase/templates) não mandam rodar script do kit", () => {
    const modelos = rastreados("supabase/templates/*.html");
    expect(modelos).toContain("supabase/templates/confirmation.html");
    expect(achadosDoKit(modelos)).toEqual([]);
  });

  it("os textos de tela (app, components, hooks, lib/i18n) não citam o kit", () => {
    const fontes = rastreados("app", "components", "hooks", "lib/i18n").filter(
      (f) => /\.(?:tsx?|mjs)$/.test(f) && !/\.test\.tsx?$/.test(f),
    );
    expect(fontes).toContain("lib/i18n/dicionario.ts");
    // Controle do limpador: comentário sai, string fica.
    expect(semComentariosTs('// rode o update.sh\nconst a = "x";')).not.toMatch(NOMES_DO_KIT);
    expect(semComentariosTs('const a = "rode o update.sh";')).toMatch(NOMES_DO_KIT);
    expect(achadosDoKit(fontes, semComentariosTs)).toEqual([]);
  });

  it("as mensagens dos scripts (scripts/, sem comentários) não mandam para o kit", () => {
    const fontes = rastreados("scripts").filter((f) => /\.(?:ts|mjs|sh|ps1)$/.test(f));
    expect(fontes).toContain("scripts/lib/gate-ativacao.ts");
    expect(fontes).toContain("scripts/test-db.sh");
    // .sh e .ps1: só a linha que não abre com # (comentário de shell e de PowerShell).
    const semComentariosShell = (fonte: string) =>
      fonte
        .split("\n")
        .map((l) => (l.trimStart().startsWith("#") ? "" : l))
        .join("\n");
    const achados = fontes.flatMap((f) =>
      achadosDoKit([f], /\.(?:sh|ps1)$/.test(f) ? semComentariosShell : semComentariosTs),
    );
    expect(achados).toEqual([]);
  });

  it("todo caminho scripts/... citado existe", () => {
    const achados: string[] = [];
    for (const f of arquivos) {
      // Planejamento e histórico descrevem o que SERIA construído (mesmo recorte do gate
      // `documentacao-aponta-para-o-que-existe`); os nomes do kit acima valem para eles também.
      if (PLANEJAMENTO.some((p) => f.startsWith(p))) continue;
      const linhas = fs.readFileSync(path.join(RAIZ, f), "utf8").split("\n");
      linhas.forEach((linha, i) => {
        for (const m of linha.matchAll(CAMINHO_DE_SCRIPT)) {
          if (PONTEIROS_ACEITOS.has(`${f}::${m[0]}`)) continue;
          if (!fs.existsSync(path.join(RAIZ, m[0]))) achados.push(`${f}:${i + 1} ${m[0]}`);
        }
      });
    }
    expect(achados).toEqual([]);
  });
});
