/**
 * A chave de cifra do banco (`app.nuvemshop_oauth_key`, lida por `private.fn_oauth_key()`: GUC ou
 * `private.app_secrets`) nasce na instalação. Sem ela, segredo de webhook, token de canal oficial e
 * credencial do Google não podiam ser gravados numa instalação nova, e a tela mandava "ativar a chave no banco".
 *
 * EXECUTA `ativar_chave_de_cifra` (bash) e `Ativar-ChaveDeCifra` (Windows PowerShell 5.1) com um `docker`
 * FALSO no PATH que simula a linha de `private.app_secrets` num arquivo. Nada aqui toca em Docker ou banco.
 *
 * Trancam:
 *   1. instalação nova: gera uma chave forte, grava no banco e guarda a cópia no `.env.local`;
 *   2. reinstalação: NUNCA troca a chave do banco (trocar tornaria ilegível o que já foi cifrado);
 *   3. o banco manda: se ele já tem chave, o `.env.local` passa a ter a MESMA (a cópia que se guarda);
 *   4. máquina nova com o `.env.local` copiado: a chave dele vai para o banco vazio (backup restaurável);
 *   5. a chave nunca aparece na saída nem no argv de um processo (vai ao psql pela entrada padrão);
 *   6. o .env.local com OUTRA chave avisa (era a única cópia dela), sem imprimir nenhuma das duas;
 *   7. chave curta posta à mão no banco é trocada (o banco a recusaria ao cifrar), e falha de leitura do
 *      banco para o instalador com mensagem.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

const RAIZ = process.cwd();
const barras = (p: string) => p.replace(/\\/g, "/");
const LIB_SH = barras(join(RAIZ, "scripts/lib/instalar-env.sh"));
const LIB_PS1 = join(RAIZ, "scripts/lib/instalar-env.ps1");

const temBash = !spawnSync("bash", ["-c", "true"]).error;
const temPowerShell =
  process.platform === "win32" && !spawnSync("powershell", ["-NoProfile", "-Command", "1"]).error;

const DOCKER_FALSO = `
const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(args) + "\\n");
const banco = process.env.FAKE_BANCO;
const atual = fs.existsSync(banco) ? fs.readFileSync(banco, "utf8") : "";
if (args[0] !== "exec") process.exit(0);
const c = args.indexOf("-c");
if (c !== -1) {
  const sql = args[c + 1];
  if (process.env.FAKE_DOCKER_FALHA_LEITURA === "1") { process.stderr.write("psql: erro simulado\\n"); process.exit(3); }
  if (/select exists/i.test(sql)) { process.stdout.write(atual.length >= 32 ? "t\\n" : "f\\n"); process.exit(0); }
  if (/select value/i.test(sql)) { process.stdout.write(atual + "\\n"); process.exit(0); }
  process.exit(0);
}
if (args.includes("-i")) {
  if (process.env.FAKE_DOCKER_FALHA === "1") { process.stderr.write("psql: erro simulado\\n"); process.exit(3); }
  const sql = fs.readFileSync(0, "utf8");
  const m = /insert into private\\.app_secrets \\(name, value\\) values \\('nuvemshop_oauth_key', '((?:[^']|'')*)'\\) on conflict \\(name\\) do update set value = excluded\\.value, updated_at = now\\(\\) where length\\(private\\.app_secrets\\.value\\) < 32;/.exec(sql);
  if (!m) { process.stderr.write("sql inesperado\\n"); process.exit(4); }
  // o on conflict do SQL: grava se não há linha, e troca só a que é curta demais
  if (atual.length < 32) fs.writeFileSync(banco, m[1].replace(/''/g, "'"));
  process.exit(0);
}
process.exit(0);
`;

const pastas: string[] = [];
let dir: string;
let bin: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "crm-cifra-"));
  pastas.push(dir);
  bin = join(dir, "_bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "docker-falso.js"), DOCKER_FALSO);
  writeFileSync(
    join(bin, "docker"),
    `#!/usr/bin/env bash\nAQUI="$(cd "$(dirname "$0")" && (pwd -W 2>/dev/null || pwd))"\nexec node "$AQUI/docker-falso.js" "$@"\n`,
  );
  chmodSync(join(bin, "docker"), 0o755);
  writeFileSync(join(bin, "docker.cmd"), `@echo off\r\nnode "%~dp0docker-falso.js" %*\r\n`);
  writeFileSync(join(dir, ".env.local"), "# CRM ALQUIM(IA)\n");
});
afterAll(() => {
  for (const p of pastas) rmSync(p, { recursive: true, force: true });
});

const banco = () => join(dir, "banco.txt");
const lerBanco = () => (existsSync(banco()) ? readFileSync(banco(), "utf8") : "");
const chaveNoEnv = () =>
  /^NUVEMSHOP_OAUTH_ENCRYPTION_KEY=(.*)$/m.exec(readFileSync(join(dir, ".env.local"), "utf8"))?.[1] ?? "";
const argvs = () =>
  readFileSync(join(dir, "docker.log"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => (JSON.parse(l) as string[]).join(" "));

function ambiente(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (/^path$/i.test(k) || k.startsWith("FAKE_")) delete env[k];
  env.PATH = `${bin}${delimiter}${process.env.PATH ?? process.env.Path ?? ""}`;
  env.FAKE_DOCKER_LOG = join(dir, "docker.log");
  env.FAKE_BANCO = banco();
  return { ...env, ...extra };
}

type Sistema = "bash" | "ps1";
function ativar(sistema: Sistema, extra: Record<string, string> = {}) {
  if (sistema === "bash") {
    const r = spawnSync(
      "bash",
      ["-c", `set -euo pipefail\numask 077\nsource "$LIB"\nativar_chave_de_cifra .env.local supabase_db_teste`],
      { cwd: dir, encoding: "utf8", env: ambiente({ LIB: LIB_SH, ...extra }) },
    );
    return { status: r.status, tudo: `${r.stdout}\n${r.stderr}` };
  }
  const arquivo = join(dir, "harness.ps1");
  writeFileSync(
    arquivo,
    `﻿$ErrorActionPreference = "Stop"\n. "${LIB_PS1}"\nAtivar-ChaveDeCifra (Join-Path (Get-Location) ".env.local") "supabase_db_teste"\n`,
    "utf8",
  );
  const r = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", arquivo], {
    cwd: dir,
    encoding: "utf8",
    env: ambiente(extra),
  });
  return { status: r.status, tudo: `${r.stdout}\n${r.stderr}` };
}

const sistemas: Array<[Sistema, boolean]> = [
  ["bash", temBash],
  ["ps1", temPowerShell],
];
const T = 60_000;

for (const [sistema, disponivel] of sistemas) {
  describe.skipIf(!disponivel)(`${sistema}: chave de cifra do banco na instalação`, () => {
    it(
      "instalação nova: gera chave forte, grava no banco e no .env.local, sem imprimir e sem argv",
      () => {
        const r = ativar(sistema);
        expect(r.status, r.tudo).toBe(0);
        const chave = chaveNoEnv();
        expect(chave).toMatch(/^[0-9a-f]{64}$/);
        expect(lerBanco()).toBe(chave);
        expect(r.tudo).not.toContain(chave);
        for (const a of argvs()) expect(a).not.toContain(chave);
      },
      T,
    );

    it(
      "reinstalação: a chave do banco não muda e o .env.local continua igual",
      () => {
        expect(ativar(sistema).status).toBe(0);
        const antes = lerBanco();
        const r = ativar(sistema);
        expect(r.status, r.tudo).toBe(0);
        expect(lerBanco()).toBe(antes);
        expect(chaveNoEnv()).toBe(antes);
        expect(r.tudo).not.toMatch(/AVISO/);
      },
      T,
    );

    it(
      "o banco manda: chave diferente no .env.local é trocada pela do banco, e o banco não muda",
      () => {
        const doBanco = "b".repeat(64);
        writeFileSync(banco(), doBanco);
        writeFileSync(join(dir, ".env.local"), `# CRM ALQUIM(IA)\nNUVEMSHOP_OAUTH_ENCRYPTION_KEY=${"c".repeat(64)}\n`);
        const r = ativar(sistema);
        expect(r.status, r.tudo).toBe(0);
        expect(lerBanco()).toBe(doBanco);
        expect(chaveNoEnv()).toBe(doBanco);
        expect(r.tudo).not.toContain(doBanco);
        // a chave que estava no .env.local era a única cópia dela: o instalador avisa, sem imprimi-la
        expect(r.tudo).toMatch(/AVISO: o \.env\.local tinha OUTRA chave de cifra/);
        expect(r.tudo).not.toContain("c".repeat(64));
      },
      T,
    );

    it(
      "chave curta posta à mão no banco: é trocada pela do .env.local, e as duas ficam iguais",
      () => {
        writeFileSync(banco(), "curta-no-banco");
        const doEnv = "f".repeat(64);
        writeFileSync(join(dir, ".env.local"), `# CRM ALQUIM(IA)\nNUVEMSHOP_OAUTH_ENCRYPTION_KEY=${doEnv}\n`);
        const r = ativar(sistema);
        expect(r.status, r.tudo).toBe(0);
        expect(lerBanco()).toBe(doEnv);
        expect(chaveNoEnv()).toBe(doEnv);
        expect(r.tudo).not.toContain(doEnv);
      },
      T,
    );

    it(
      "o banco não responde à leitura: falha com mensagem e não mexe no .env.local",
      () => {
        writeFileSync(join(dir, ".env.local"), `# CRM ALQUIM(IA)\nNUVEMSHOP_OAUTH_ENCRYPTION_KEY=${"a".repeat(64)}\n`);
        const r = ativar(sistema, { FAKE_DOCKER_FALHA_LEITURA: "1" });
        expect(r.status).not.toBe(0);
        expect(r.tudo).toMatch(/chave de cifra do banco/i);
        expect(chaveNoEnv()).toBe("a".repeat(64));
        expect(r.tudo).not.toContain("a".repeat(64));
      },
      T,
    );

    it(
      "máquina nova com o .env.local copiado: a chave dele vai para o banco vazio",
      () => {
        const copiada = "d".repeat(40) + "'x" + "e".repeat(10);
        writeFileSync(join(dir, ".env.local"), `# CRM ALQUIM(IA)\nNUVEMSHOP_OAUTH_ENCRYPTION_KEY=${copiada}\n`);
        const r = ativar(sistema);
        expect(r.status, r.tudo).toBe(0);
        expect(lerBanco()).toBe(copiada);
        expect(chaveNoEnv()).toBe(copiada);
      },
      T,
    );

    it(
      "chave curta demais no .env.local (menos de 32) é trocada por uma forte",
      () => {
        writeFileSync(join(dir, ".env.local"), `# CRM ALQUIM(IA)\nNUVEMSHOP_OAUTH_ENCRYPTION_KEY=curta\n`);
        const r = ativar(sistema);
        expect(r.status, r.tudo).toBe(0);
        expect(chaveNoEnv()).toMatch(/^[0-9a-f]{64}$/);
        expect(lerBanco()).toBe(chaveNoEnv());
      },
      T,
    );

    it(
      "o banco recusa a gravação: falha com mensagem, sem imprimir a chave",
      () => {
        const r = ativar(sistema, { FAKE_DOCKER_FALHA: "1" });
        expect(r.status).not.toBe(0);
        expect(r.tudo).toMatch(/chave de cifra/i);
        const chave = chaveNoEnv();
        if (chave) expect(r.tudo).not.toContain(chave);
      },
      T,
    );
  });
}

const LIB_BACKUP_SH = barras(join(RAIZ, "scripts/lib/backup.sh"));
const LIB_BACKUP_PS1 = join(RAIZ, "scripts/lib/backup.ps1");

/** O aviso do restaurar: compara a chave do .env.local com a do banco, sem imprimir nenhuma. */
function avisarNoRestaurar(sistema: Sistema) {
  if (sistema === "bash") {
    const r = spawnSync(
      "bash",
      ["-c", `set -euo pipefail\numask 077\nsource "$LIB"\navisar_chave_de_cifra_divergente .env.local`],
      { cwd: dir, encoding: "utf8", env: ambiente({ LIB: LIB_BACKUP_SH }) },
    );
    return { status: r.status, tudo: `${r.stdout}\n${r.stderr}` };
  }
  const arquivo = join(dir, "harness-restaurar.ps1");
  writeFileSync(
    arquivo,
    `﻿$ErrorActionPreference = "Stop"\n. "${LIB_BACKUP_PS1}"\nAvisar-ChaveDeCifraDivergente (Join-Path (Get-Location) ".env.local")\n`,
    "utf8",
  );
  const r = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", arquivo], {
    cwd: dir,
    encoding: "utf8",
    env: ambiente({}),
  });
  return { status: r.status, tudo: `${r.stdout}\n${r.stderr}` };
}

for (const [sistema, disponivel] of sistemas) {
  describe.skipIf(!disponivel)(`${sistema}: o restaurar avisa quando a chave do .env.local não é a do banco`, () => {
    it(
      "chave diferente: avisa, sem mostrar nenhuma das duas; igual ou ausente: não avisa",
      () => {
        const doBanco = "b".repeat(64);
        const doEnv = "c".repeat(64);
        writeFileSync(banco(), doBanco);
        writeFileSync(join(dir, ".env.local"), `# CRM ALQUIM(IA)\nNUVEMSHOP_OAUTH_ENCRYPTION_KEY=${doEnv}\n`);
        let r = avisarNoRestaurar(sistema);
        expect(r.status, r.tudo).toBe(0);
        expect(r.tudo).toMatch(/AVISO: a chave de cifra do \.env\.local/);
        expect(r.tudo).not.toContain(doBanco);
        expect(r.tudo).not.toContain(doEnv);

        writeFileSync(join(dir, ".env.local"), `# CRM ALQUIM(IA)\nNUVEMSHOP_OAUTH_ENCRYPTION_KEY=${doBanco}\n`);
        r = avisarNoRestaurar(sistema);
        expect(r.status, r.tudo).toBe(0);
        expect(r.tudo).not.toMatch(/AVISO/);

        writeFileSync(join(dir, ".env.local"), "# CRM ALQUIM(IA)\n");
        r = avisarNoRestaurar(sistema);
        expect(r.status, r.tudo).toBe(0);
        expect(r.tudo).not.toMatch(/AVISO/);
      },
      T,
    );
  });
}

describe("o instalador ativa a chave depois do schema e o backup avisa onde ela mora", () => {
  const ler = (a: string) => readFileSync(join(RAIZ, a), "utf8");

  it("instalar.sh chama ativar_chave_de_cifra depois do baseline, com o contêiner do banco", () => {
    const s = ler("scripts/instalar.sh");
    const i = s.indexOf('ativar_chave_de_cifra "$ENV_LOCAL" "$DB_CONTAINER"');
    expect(i).toBeGreaterThan(-1);
    expect(i).toBeGreaterThan(s.indexOf("/tmp/baseline.sql >/dev/null"));
  });

  it("instalar.ps1 chama Ativar-ChaveDeCifra depois do baseline, com o contêiner do banco", () => {
    const s = ler("scripts/instalar.ps1");
    const i = s.indexOf("Ativar-ChaveDeCifra $EnvCaminho $DbContainer");
    expect(i).toBeGreaterThan(-1);
    expect(i).toBeGreaterThan(s.indexOf("-f /tmp/baseline.sql"));
  });

  it("backup.sh e backup.ps1 dizem que a chave de cifra está no .env.local (que o backup não leva)", () => {
    for (const a of ["scripts/backup.sh", "scripts/backup.ps1"]) expect(ler(a), a).toMatch(/chave de cifra/i);
  });

  it("restaurar.sh e restaurar.ps1 mandam copiar o .env.local ANTES de instalar, como o README", () => {
    // A ordem contrária (instalar e depois copiar o .env.local) dá ao banco novo outra chave, e os
    // segredos cifrados do backup não abrem. O cabeçalho e a mensagem de erro dizem a mesma coisa.
    for (const a of ["scripts/restaurar.sh", "scripts/restaurar.ps1"]) {
      const s = ler(a);
      expect(s.match(/\.env\.local[^\n]*ANTES de (rodar|instalar)/g)?.length ?? 0, a).toBeGreaterThanOrEqual(2);
      expect(s, a).not.toMatch(/copie o seu \.env\.local de volta/);
      expect(s, a).not.toMatch(/numa máquina nova, rode antes/);
    }
    // e, antes de pedir a confirmação, os dois chamam o aviso de chave divergente
    const sh = ler("scripts/restaurar.sh");
    expect(sh.indexOf("avisar_chave_de_cifra_divergente .env.local")).toBeGreaterThan(sh.indexOf("conferir_versao_do_backup"));
    expect(sh.indexOf("avisar_chave_de_cifra_divergente .env.local")).toBeLessThan(sh.indexOf("RESTAURAR e aperte Enter"));
    const ps = ler("scripts/restaurar.ps1");
    expect(ps.indexOf("Avisar-ChaveDeCifraDivergente")).toBeGreaterThan(ps.indexOf("Conferir-VersaoDoBackup $Raiz"));
    expect(ler("README.md")).toMatch(/copie o `\.env\.local` para a pasta do CRM nela \*\*antes\*\* de instalar/);
  });
});
