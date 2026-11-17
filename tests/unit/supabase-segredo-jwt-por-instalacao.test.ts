import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Sem `[auth] jwt_secret`, a CLI do Supabase assina as chaves anon e service_role com o segredo de
 * demonstração dela, público e igual em toda instalação: quem estivesse na mesma rede chamaria a API
 * (porta 54321) com a service_role conhecida e leria e escreveria tudo. O config lê o segredo de
 * `env(CRM_ALQUIMIA_JWT_SECRET)`, o instalador gera um por instalação e o exporta para a CLI.
 *
 * O banco (54322) continua com a senha padrão da CLI, que não se troca por aqui: os avisos dizem isso.
 */
const ler = (arquivo: string) => readFileSync(path.join(process.cwd(), arquivo), "utf8");

describe("segredo do JWT do Supabase por instalação", () => {
  it("o config.toml lê o segredo do ambiente, dentro de [auth]", () => {
    const toml = ler("supabase/config.toml");
    const auth = toml.slice(toml.indexOf("\n[auth]\n"), toml.indexOf("\n[auth.", toml.indexOf("\n[auth]\n") + 1));
    expect(auth).toMatch(/^jwt_secret = "env\(CRM_ALQUIMIA_JWT_SECRET\)"$/m);
  });

  it("o instalador bash gera (se vazio) e exporta os segredos da CLI antes do primeiro comando dela, por uma função só", () => {
    const sh = ler("scripts/instalar.sh");
    const gera = sh.indexOf('definir CRM_ALQUIMIA_JWT_SECRET "$(segredo_hex)" se_vazio');
    const exporta = sh.indexOf('exportar_segredos_da_cli "$ENV_LOCAL"');
    const primeiroStatus = sh.indexOf("if supabase_crm status");
    expect(gera).toBeGreaterThan(0);
    expect(exporta).toBeGreaterThan(gera);
    expect(primeiroStatus).toBeGreaterThan(exporta);
    // sem o export avulso que repetia o da função
    expect(sh).not.toMatch(/^export CRM_ALQUIMIA_JWT_SECRET=/m);
    expect(ler("scripts/lib/instalar-env.sh")).toMatch(/^exportar_segredos_da_cli\(\) \{/m);
  });

  it("o instalador PowerShell faz o mesmo", () => {
    const ps = ler("scripts/instalar.ps1");
    const gera = ps.search(/foreach \(\$nome in @\([^)]*"CRM_ALQUIMIA_JWT_SECRET"\)\) \{\s*if \(\(Valor-Atual \$nome\) -eq ""\) \{ Definir \$nome \(Segredo-Hex\)/);
    const exporta = ps.indexOf("Exportar-SegredosDaCli $EnvCaminho");
    const primeiroStatus = ps.indexOf("Supabase status");
    expect(gera).toBeGreaterThan(0);
    expect(exporta).toBeGreaterThan(gera);
    expect(primeiroStatus).toBeGreaterThan(exporta);
    expect(ps).not.toMatch(/^\$env:CRM_ALQUIMIA_JWT_SECRET = /m);
    expect(ler("scripts/lib/instalar-env.ps1")).toMatch(/^function Exportar-SegredosDaCli\(/m);
  });

  it("o .env.example documenta a variável vazia (o instalador a preenche)", () => {
    expect(ler(".env.example")).toMatch(/^CRM_ALQUIMIA_JWT_SECRET=$/m);
  });

  it("o CI, descartável, tira o jwt_secret do config: todo comando da CLI usa o segredo de demonstração dela, sem depender do ambiente do passo", () => {
    const e2e = ler(".github/workflows/e2e.yml");
    const inicio = e2e.indexOf("- name: Subir Supabase local");
    const passo = e2e.slice(inicio, e2e.indexOf("supabase start", inicio));
    expect(passo).toContain("sed -i '/^jwt_secret = /d' supabase/config.toml");
  });

  it("gerar-env-e2e.sh exporta do .env.local os mesmos segredos que o instalador dá à CLI (os que a sessão não tem) antes do primeiro comando dela", () => {
    const s = ler("scripts/gerar-env-e2e.sh");
    const laco = s.indexOf("for chave in CRM_ALQUIMIA_JWT_SECRET CRM_ALQUIMIA_PUBLISHABLE_KEY CRM_ALQUIMIA_SECRET_KEY; do");
    expect(laco).toBeGreaterThan(-1);
    expect(s).toMatch(/if \[ -z "\$\{!chave:-\}" \] && \[ -f \.env\.local \]/);
    expect(s.indexOf("$SUPABASE status")).toBeGreaterThan(laco);
    // a mesma lista do instalador
    expect(ler("scripts/lib/instalar-env.sh")).toContain('CHAVES_DA_CLI="CRM_ALQUIMIA_JWT_SECRET CRM_ALQUIMIA_PUBLISHABLE_KEY CRM_ALQUIMIA_SECRET_KEY"');
  });

  // A CLI lê sozinha o supabase/.env (que o instalador grava), e sem a chave de assinatura o start falha:
  // subir à mão não volta mais, em silêncio, às chaves públicas.
  it("o README e o SECURITY dizem que subir o Supabase à mão usa as chaves desta instalação e falha sem a chave de assinatura", () => {
    expect(ler("README.md")).toMatch(/a CLI lê as chaves desta instalação do `supabase\/\.env`/);
    expect(ler("SECURITY.md")).toMatch(/Sem o arquivo, o `supabase start` falha/);
  });

  it("os avisos dizem o risco real do banco na rede: qualquer pessoa lê e altera tudo", () => {
    for (const arq of ["README.md", "SECURITY.md", "scripts/instalar.sh", "scripts/instalar.ps1"]) {
      expect(ler(arq), arq).toMatch(/qualquer pessoa nela (lê e altera|abre o banco)/);
    }
  });
});
