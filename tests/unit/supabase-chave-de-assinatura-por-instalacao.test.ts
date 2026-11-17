import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * A CLI do Supabase (2.120) assina as sessões do Auth com uma chave ES256 que vem DENTRO dela, igual em toda
 * instalação, e a mesma chave confere os tokens no PostgREST e no admin do Auth. Quem a tira do binário
 * monta um token `service_role` válido em qualquer instalação que não tenha a sua. E o Kong da CLI troca a
 * chave secreta nova (`sb_secret_...`) padrão, também pública, pelo token `service_role` desta instalação.
 *
 * Por isso a instalação tem, só dela: o segredo do JWT (`env(CRM_ALQUIMIA_JWT_SECRET)`), a chave de
 * assinatura em `supabase/signing_keys.json` (gerada pela própria CLI) e as chaves `sb_publishable_`/
 * `sb_secret_` (`env(CRM_ALQUIMIA_PUBLISHABLE_KEY)`/`env(CRM_ALQUIMIA_SECRET_KEY)`). Com `signing_keys_path`,
 * a CLI deixa de pôr a chave dela e o segredo HS256 no conjunto que o PostgREST aceita.
 */
const ler = (arquivo: string) => readFileSync(path.join(process.cwd(), arquivo), "utf8");
const linhasSemComentario = (arquivo: string) =>
  ler(arquivo)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

function secaoAuth(): string {
  const toml = ler("supabase/config.toml");
  const inicio = toml.indexOf("\n[auth]\n");
  return toml.slice(inicio, toml.indexOf("\n[auth.", inicio + 1));
}

describe("chave de assinatura das sessões por instalação", () => {
  it("o config.toml aponta para a chave desta instalação e lê as chaves novas da API do ambiente", () => {
    const auth = secaoAuth();
    expect(auth).toMatch(/^signing_keys_path = "\.\/signing_keys\.json"$/m);
    expect(auth).toMatch(/^publishable_key = "env\(CRM_ALQUIMIA_PUBLISHABLE_KEY\)"$/m);
    expect(auth).toMatch(/^secret_key = "env\(CRM_ALQUIMIA_SECRET_KEY\)"$/m);
    expect(auth).toMatch(/^jwt_secret = "env\(CRM_ALQUIMIA_JWT_SECRET\)"$/m);
  });

  // Cópias feitas à mão (.bak, .old, .novo) têm a mesma chave privada: o padrão cobre o nome e as variações.
  const COPIAS = ["supabase/signing_keys.json", "supabase/signing_keys.json.bak", "supabase/signing_keys.old.json", "supabase/signing_keys"];

  it("a chave (e cópias dela), o arquivo de ambiente da CLI e o marcador de reinício ficam fora do git", () => {
    const r = spawnSync("git", ["check-ignore", "--no-index", ...COPIAS, "supabase/.env", "supabase/.env.pendente"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(r.status, r.stderr).toBe(0);
    const ignorados = r.stdout.split(/\r?\n/).filter(Boolean);
    for (const c of [...COPIAS, "supabase/.env", "supabase/.env.pendente"]) expect(ignorados, c).toContain(c);
  });

  it("a chave (e cópias dela) e o arquivo de ambiente da CLI ficam fora da imagem", () => {
    const di = linhasSemComentario(".dockerignore");
    for (const p of ["supabase/signing_keys*", "supabase/.env", "supabase/.env.*"]) expect(di, p).toContain(p);
  });

  it("o .env.example documenta as duas chaves novas vazias (o instalador as preenche)", () => {
    const ex = ler(".env.example");
    expect(ex).toMatch(/^CRM_ALQUIMIA_PUBLISHABLE_KEY=$/m);
    expect(ex).toMatch(/^CRM_ALQUIMIA_SECRET_KEY=$/m);
  });

  it("o CI, descartável, sobe no modo de demonstração: os sed do passo, aplicados ao config.toml real, tiram as quatro linhas e mais nada", () => {
    const e2e = ler(".github/workflows/e2e.yml");
    const inicio = e2e.indexOf("- name: Subir Supabase local");
    const passo = e2e.slice(inicio, e2e.indexOf("supabase start", inicio));
    const seds = passo
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith("sed -i "));
    expect(seds.length).toBeGreaterThan(3);
    const pasta = mkdtempSync(path.join(tmpdir(), "ci-config-"));
    try {
      const copia = path.join(pasta, "config.toml");
      const original = ler("supabase/config.toml");
      writeFileSync(copia, original);
      const script = seds.map((l) => l.replace(/ supabase\/config\.toml$/, " config.toml")).join("\n");
      const r = spawnSync("bash", ["-c", script], { cwd: pasta, encoding: "utf8" });
      expect(r.status, r.stderr).toBe(0);
      const depois = readFileSync(copia, "utf8");
      const auth = (t: string) => {
        const i = t.indexOf("\n[auth]\n");
        return t.slice(i, t.indexOf("\n[auth.", i + 1));
      };
      for (const campo of ["signing_keys_path", "publishable_key", "secret_key", "jwt_secret"]) {
        expect(auth(original), campo).toMatch(new RegExp(`^${campo} = `, "m"));
        expect(auth(depois), campo).not.toMatch(new RegExp(`^${campo} = `, "m"));
      }
      // nenhum env(...) sobra: start, status e gerar-env-e2e.sh concordam sem depender do ambiente de cada passo
      expect(depois).not.toContain("env(CRM_ALQUIMIA_");
      // o resto fica: só somem as quatro linhas e mudam as duas que o CI liga de volta
      const linhasDepois = new Set(depois.split("\n"));
      for (const l of original.split("\n").filter((x) => !linhasDepois.has(x))) {
        expect(l).toMatch(/^(signing_keys_path|publishable_key|secret_key|jwt_secret) = |^enable_confirmations = false$|^enabled = false$/);
      }
    } finally {
      rmSync(pasta, { recursive: true, force: true });
    }
  });

  it("nenhum passo do CI depende do segredo do JWT no ambiente", () => {
    expect(ler(".github/workflows/e2e.yml")).not.toMatch(/CRM_ALQUIMIA_JWT_SECRET:/);
  });

  it("README e SECURITY descrevem o modelo de chaves e dizem que a chave de assinatura não entra no backup", () => {
    for (const arq of ["README.md", "SECURITY.md"]) {
      // a prosa quebra linha e marca negrito onde quiser: compara o texto corrido
      const t = ler(arq).replace(/\*\*/g, "").replace(/\s+/g, " ");
      expect(t, arq).toContain("supabase/signing_keys.json");
      expect(t, arq).toMatch(/n.o entra no backup/);
      expect(t, arq).toMatch(/sess.es caem/);
      // o supabase/.env é cópia de três valores do .env.local: quem guarda um guarda o outro
      expect(t, arq).toMatch(/`\.env\.local` e o `supabase\/\.env`[^.]{0,80}junt/);
    }
    // o SECURITY diz por que a sb_secret_ padrão da CLI não pode valer
    expect(ler("SECURITY.md")).toMatch(/sb_secret_/);
  });

  it("CHANGELOG, Atualizar (zip) e Problemas comuns contam o modelo de chaves como ele é", () => {
    const corrido = (arq: string) => ler(arq).replace(/\*\*/g, "").replace(/\s+/g, " ");
    const seguranca = corrido("CHANGELOG.md").slice(corrido("CHANGELOG.md").indexOf("### Segurança"));
    expect(seguranca).toContain("supabase/signing_keys.json");
    expect(seguranca).toMatch(/sb_secret_/);
    const readme = ler("README.md").split(/\r?\n/);
    const atualizar = readme.find((l) => l.startsWith("| Atualizar para uma versão nova")) ?? "";
    for (const arq of ["`.env.local`", "`supabase/.env`", "`supabase/signing_keys.json`"]) expect(atualizar, arq).toContain(arq);
    // apagou o supabase/.env: o app leva 401; apagou a chave: o start falha (são linhas diferentes)
    const problema401 = readme.find((l) => l.includes("(erro 401)")) ?? "";
    expect(problema401).toContain("`supabase/.env`");
    expect(problema401).not.toContain("signing_keys.json");
    expect(readme.some((l) => l.startsWith("|") && l.includes("failed to read signing keys"))).toBe(true);
  });
});

describe("resíduos de texto", () => {
  it("nenhum script cita o caminho do config sem a barra", () => {
    for (const arq of ["scripts/instalar.ps1", "scripts/lib/instalar-env.ps1", "scripts/instalar.sh", "scripts/lib/instalar-env.sh"]) {
      expect(ler(arq), arq).not.toContain("supabaseconfig.toml");
    }
  });

  it("o CONTRIBUTING explica o portão de telefone e o que fazer num falso positivo", () => {
    const c = ler("CONTRIBUTING.md");
    expect(c).toContain("sem-dado-de-operacao");
    expect(c).toMatch(/falso positivo/i);
    expect(c).toContain("REGRAS_ISENTAS_POR_ARQUIVO");
  });
});
