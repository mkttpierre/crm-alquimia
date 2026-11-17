/**
 * Backup e restauração (`scripts/backup.*`, `scripts/restaurar.*`): checagens ESTÁTICAS. A prova de
 * comportamento está em `backup-restauracao-executavel.test.ts` (que executa os scripts com um docker falso).
 * Aqui ficam as regras de forma que, erradas, só se descobrem na máquina de quem usa:
 *   - o `.ps1` precisa parsear no Windows PowerShell 5.1 e ter BOM;
 *   - o `.sh` e o `.ps1` precisam fazer a mesma coisa (mesmos contêineres, mesmas opções do pg_dump, mesma retenção);
 *   - nenhum script lê, imprime ou passa por argumento o `.env.local`;
 *   - o que o README promete existe.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = process.cwd();
const ler = (arquivo: string) => readFileSync(join(RAIZ, arquivo), "utf8");
const semComentario = (texto: string) =>
  texto
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n");

const SH = ["scripts/backup.sh", "scripts/restaurar.sh", "scripts/lib/backup.sh", "scripts/lib/instalar-env.sh", "scripts/instalar.sh"];
const PS1 = ["scripts/backup.ps1", "scripts/restaurar.ps1", "scripts/lib/backup.ps1", "scripts/lib/instalar-env.ps1", "scripts/instalar.ps1"];

describe("PowerShell 5.1", () => {
  it.each(PS1)("%s começa com BOM e não usa &&, ||, ternário nem coalescência nula", (arquivo) => {
    const texto = ler(arquivo);
    expect(texto.charCodeAt(0)).toBe(0xfeff);
    const codigo = semComentario(texto);
    expect(codigo).not.toContain("&&");
    expect(codigo).not.toContain("||");
    expect(codigo).not.toMatch(/\?\?/);
    expect(codigo).not.toMatch(/\?\./);
  });
});

describe("bash", () => {
  it.each(SH)("%s passa na checagem de sintaxe do bash", (arquivo) => {
    const r = spawnSync("bash", ["-n", join(RAIZ, arquivo)], { encoding: "utf8" });
    if (r.error) return;
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it("backup.sh e restaurar.sh usam set -euo pipefail e umask 077", () => {
    for (const a of ["scripts/backup.sh", "scripts/restaurar.sh"]) {
      const t = ler(a);
      expect(t).toContain("set -euo pipefail");
      expect(t).toMatch(/^umask 077$/m);
    }
  });

  it("não usa mapfile (o bash 3.2 do macOS não tem)", () => {
    for (const a of ["scripts/backup.sh", "scripts/restaurar.sh", "scripts/lib/backup.sh"]) {
      expect(semComentario(ler(a))).not.toMatch(/\bmapfile\b|\breadarray\b/);
    }
  });
});

describe("o .sh e o .ps1 fazem a mesma coisa", () => {
  const sh = ler("scripts/lib/backup.sh");
  const ps1 = ler("scripts/lib/backup.ps1");

  it("os mesmos contêineres do Supabase local e a mesma retenção", () => {
    for (const t of [sh, ps1]) {
      expect(t).toContain("supabase_db_");
      expect(t).toContain("supabase_storage_");
    }
    // o projeto (sufixo dos contêineres) vem do .env.local da instalação, padrão crm-alquimia (instalar-env.*)
    expect(sh).toContain('BACKUP_PROJETO="$(projeto_da_instalacao .env.local)"');
    expect(ps1).toContain("Projeto-DaInstalacao");
    expect(sh).toContain("BACKUP_MANTER=14");
    expect(ps1).toContain("BackupManter = 14");
  });

  it("o mesmo pg_dump (só dados de public, auth e storage, sem as tabelas de versão do Supabase)", () => {
    for (const t of [sh, ps1]) {
      for (const opcao of [
        "--data-only",
        "--schema=public",
        "--schema=auth",
        "--schema=storage",
        "--exclude-table-data=auth.schema_migrations",
        "--exclude-table-data=storage.migrations",
        "--no-owner",
      ]) {
        expect(t, opcao).toContain(opcao);
      }
    }
  });

  it("a restauração é uma transação só, com ON_ERROR_STOP, nos dois", () => {
    for (const t of [sh, ps1]) {
      expect(t).toContain("--single-transaction");
      expect(t).toContain("ON_ERROR_STOP=1");
      expect(t).toContain("restaurar-preludio.sql");
    }
  });

  it("o prelúdio esvazia só as tabelas de dados e preserva o controle de versão do Supabase", () => {
    const sql = ler("scripts/restaurar-preludio.sql");
    expect(sql).toContain("session_replication_role = replica");
    expect(sql).toMatch(/TRUNCATE TABLE/);
    expect(sql).toContain("schema_migrations");
    expect(sql).toContain("tablename <> 'migrations'");
    expect(sql).not.toMatch(/DROP\s+(SCHEMA|TABLE|FUNCTION)/i);
  });

  it("o prelúdio põe lock_timeout: não fica esperando para sempre um serviço que segura a tabela", () => {
    expect(ler("scripts/restaurar-preludio.sql")).toMatch(/^SET lock_timeout = '60s';$/m);
  });

  it("restaurar.ps1: do stop em diante tudo está dentro de try { } finally { Religar-Servicos } (Ctrl+C e erro terminante religam)", () => {
    const t = ler("scripts/restaurar.ps1");
    const iTry = t.search(/^try \{$/m);
    const iStop = t.indexOf("stop app worker scheduler");
    const iFinally = t.search(/^\} finally \{$/m);
    expect(iTry).toBeGreaterThan(0);
    expect(iTry).toBeLessThan(iStop);
    expect(iFinally).toBeGreaterThan(t.indexOf("Restaurar-DoBackup"));
    expect(t.slice(iFinally, iFinally + 200)).toContain("Religar-Servicos");
    // sem a função Terminar, que dependia de cada saída lembrar de religar
    expect(t).not.toMatch(/function Terminar/);
  });
});

describe("segredos", () => {
  const todos = ["scripts/backup.sh", "scripts/restaurar.sh", "scripts/lib/backup.sh", "scripts/backup.ps1", "scripts/restaurar.ps1", "scripts/lib/backup.ps1"];

  it("nenhum script de backup lê ou imprime o conteúdo do .env.local", () => {
    for (const a of todos) {
      const codigo = semComentario(ler(a));
      expect(codigo, a).not.toMatch(/\b(cat|type|Get-Content|source)\b[^\n]*\.env/);
      expect(codigo, a).not.toMatch(/valor_do_env|Valor-DoEnv|definir_env|Definir-NoEnv/);
      expect(codigo, a).not.toMatch(/set -x|Set-PSDebug|Start-Transcript/);
      expect(codigo, a).not.toMatch(/PGPASSWORD|--password|-W\b/);
    }
  });

  it("a restauração nunca apaga volume nem derruba o Supabase (docker compose down, -v, volume rm, --no-backup)", () => {
    for (const a of todos) {
      const codigo = semComentario(ler(a));
      expect(codigo, a).not.toMatch(/compose[^\n]*\bdown\b|volume rm|--no-backup|\bsupabase\b[^\n]*\bstop\b/);
    }
  });
});

describe("pasta backups/ e documentação", () => {
  it("backups/ está no .gitignore", () => {
    expect(ler(".gitignore").split("\n").map((l) => l.trim())).toContain("backups/");
  });

  it("o README tem a seção Backup e restauração com os dois comandos, a confirmação e os avisos", () => {
    const readme = ler("README.md");
    const i = readme.indexOf("## Backup e restauração");
    expect(i).toBeGreaterThan(0);
    const secao = readme.slice(i);
    expect(secao).toContain("scripts/backup.sh");
    expect(secao).toContain("scripts\\backup.ps1");
    expect(secao).toContain("scripts/restaurar.sh");
    expect(secao).toContain("scripts\\restaurar.ps1");
    expect(secao).toContain("RESTAURAR");
    expect(secao).toContain("14");
    expect(secao).toMatch(/WhatsApp/);
    expect(secao).toMatch(/\.env\.local/);
    expect(secao).toMatch(/mesma versão/);
  });

  it("o README conta o que a restauração faz de verdade", () => {
    const readme = ler("README.md");
    const i = readme.indexOf("## Backup e restauração");
    const secao = readme.slice(i, readme.indexOf("\n## ", i + 5));
    // I4: worker e agendador ficam parados; como religar
    expect(secao).toContain("docker compose -p crm-alquimia --env-file .env.local start worker scheduler");
    expect(secao).toMatch(/de novo|em dobro/i);
    // I3: recusa backup de outra versão e backup sem registro de versão
    expect(secao).toMatch(/versao\.txt/);
    // M3: o Storage é apagado antes de recopiar; a promessa falsa sai
    expect(secao).toMatch(/apaga/i);
    expect(secao).not.toMatch(/Nada é apagado em caso de erro/);
    // M8: sem backup de segurança, sem restauração
    expect(secao).toMatch(/backup de segurança/i);
    // M2: sem .env.local não roda
    expect(secao).toMatch(/sem o `\.env\.local`|sem \.env\.local/i);
  });
});

describe("permissão do .env.local (menores da revisão da instalação)", () => {
  const ps1 = ler("scripts/instalar.ps1");
  const lib = ler("scripts/lib/instalar-env.ps1");
  const sh = ler("scripts/instalar.sh");

  it("instalar.ps1 restringe o .env.local ao dono SEMPRE, também quando o arquivo já existia", () => {
    // a chamada está fora do `if (-not (Test-Path $EnvCaminho)) { ... }` (sem recuo)
    expect(ps1).toMatch(/^Restringir-ArquivoAoDono \$EnvCaminho$/m);
    const bloco = ps1.slice(ps1.indexOf("if (-not (Test-Path $EnvCaminho)) {"), ps1.indexOf("Restringir-ArquivoAoDono $EnvCaminho"));
    expect(bloco).toContain("}");
    expect(bloco).not.toContain("Restringir-ArquivoAoDono");
  });

  it("Restringir-ArquivoAoDono confere o código de saída do icacls e avisa", () => {
    const corpo = lib.slice(lib.indexOf("function Restringir-ArquivoAoDono"));
    expect(corpo).toContain("$LASTEXITCODE -ne 0");
    expect(corpo).toContain("Escrever-Aviso");
  });

  it("instalar.sh chama o icacls (Git Bash no Windows) depois da última escrita do .env.local", () => {
    expect(sh).toContain('restringir_acl_windows "$ENV_LOCAL"');
    expect(sh.lastIndexOf('restringir_acl_windows "$ENV_LOCAL"')).toBeGreaterThan(sh.lastIndexOf("definir UPSTASH_REDIS_REST_TOKEN"));
    expect(sh.lastIndexOf('restringir_acl_windows "$ENV_LOCAL"')).toBeGreaterThan(sh.lastIndexOf("DISPARO_REAL_LIBERADO=\\n"));
  });
});
