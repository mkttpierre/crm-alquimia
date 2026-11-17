/**
 * O trecho do instalador que mexe no `.env.local` e no `supabase/config.toml`, EXECUTADO de verdade
 * (bash e PowerShell) num diretório temporário. Sem Docker, sem Supabase.
 *
 * Trancam três defeitos que só apareceriam na máquina de quem instala:
 *   1. a porta escolhida na primeira execução sumia na segunda (variável não persistia);
 *   2. o `.env.local`, com todos os segredos, nascia legível por qualquer usuário (0644);
 *   3. o segredo ia no argv de um processo (`awk -v`), visível em `ps`.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

const RAIZ = process.cwd();
const barras = (p: string) => p.replace(/\\/g, "/");
const LIB_SH = barras(join(RAIZ, "scripts/lib/instalar-env.sh"));
const LIB_PS1 = join(RAIZ, "scripts/lib/instalar-env.ps1");
const CONFIG_TOML = join(RAIZ, "supabase/config.toml");

const temBash = !spawnSync("bash", ["-c", "true"]).error;
const temPowerShell =
  process.platform === "win32" && !spawnSync("powershell", ["-NoProfile", "-Command", "1"]).error;

const pastas: string[] = [];
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "crm-instalar-"));
  pastas.push(dir);
});
afterAll(() => {
  for (const p of pastas) rmSync(p, { recursive: true, force: true });
});

function bash(script: string, env: Record<string, string> = {}) {
  const limpo = { ...process.env };
  for (const k of Object.keys(limpo)) if (k.startsWith("CRM_ALQUIMIA_")) delete limpo[k];
  const r = spawnSync("bash", ["-c", `set -euo pipefail\numask 077\nsource "$LIB"\n${script}`], {
    cwd: dir,
    encoding: "utf8",
    env: { ...limpo, LIB: LIB_SH, ...env },
  });
  return { saida: r.stdout.trim(), erro: r.stderr.trim(), status: r.status };
}

function powershell(corpo: string, env: Record<string, string> = {}) {
  const limpo = { ...process.env };
  for (const k of Object.keys(limpo)) if (k.startsWith("CRM_ALQUIMIA_")) delete limpo[k];
  const arquivo = join(dir, "harness.ps1");
  writeFileSync(arquivo, `﻿$ErrorActionPreference = "Stop"\n. "${LIB_PS1}"\n${corpo}\n`, "utf8");
  const r = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", arquivo], {
    cwd: dir,
    encoding: "utf8",
    env: { ...limpo, ...env },
  });
  return { saida: r.stdout.trim(), erro: r.stderr.trim(), status: r.status };
}

const original = readFileSync(CONFIG_TOML, "utf8").replace(/\r\n/g, "\n");

describe.skipIf(!temBash)("bash: scripts/lib/instalar-env.sh executado", () => {
  it("a porta escolhida na primeira execução PERSISTE e a segunda, sem a variável, a mantém", () => {
    const passo = `porta_resolvida .env.local CRM_ALQUIMIA_PORTA_APP 3000`;
    // 1ª execução: variável do ambiente + gravação (como o instalador faz)
    const um = bash(`: > .env.local\nP="$(${passo})"\ndefinir_env .env.local CRM_ALQUIMIA_PORTA_APP "$P" sempre\necho "$P"`, {
      CRM_ALQUIMIA_PORTA_APP: "3100",
    });
    expect(um.saida).toBe("3100");
    expect(readFileSync(join(dir, ".env.local"), "utf8")).toContain("CRM_ALQUIMIA_PORTA_APP=3100");
    // 2ª execução SEM a variável: lê do arquivo
    expect(bash(passo).saida).toBe("3100");
    // 3ª: a variável de novo manda e regrava
    const tres = bash(`P="$(${passo})"\ndefinir_env .env.local CRM_ALQUIMIA_PORTA_APP "$P" sempre\necho "$P"`, {
      CRM_ALQUIMIA_PORTA_APP: "3200",
    });
    expect(tres.saida).toBe("3200");
    expect(bash(passo).saida).toBe("3200");
    // sem nada em lugar nenhum: o padrão
    expect(bash(`porta_resolvida .env.local CRM_ALQUIMIA_PORTA_WORKER 8787`).saida).toBe("8787");
  });

  it("porta que não é número de 1 a 65535 falha com mensagem", () => {
    for (const ruim of ["abc", "0", "70000", "30 00"]) {
      const r = bash(`porta_resolvida .env.local CRM_ALQUIMIA_PORTA_APP 3000`, { CRM_ALQUIMIA_PORTA_APP: ruim });
      expect(r.status, ruim).not.toBe(0);
      expect(r.erro, ruim).toContain("CRM_ALQUIMIA_PORTA_APP");
    }
  });

  it("o .env.local termina com modo 600 (arquivo novo e depois de reescrito)", () => {
    const r = bash(
      `: > .env.local\ndefinir_env .env.local A 1 sempre\ndefinir_env .env.local B 2 sempre\ndefinir_env .env.local A 3 sempre\nstat -c %a .env.local`,
    );
    expect(r.status).toBe(0);
    expect(r.saida).toBe("600");
    // e se o arquivo veio com 644 de fora, `definir_env` o aperta
    chmodSync(join(dir, ".env.local"), 0o644);
    expect(bash(`definir_env .env.local C 4 sempre\nstat -c %a .env.local`).saida).toBe("600");
  });

  it("segredo: se_vazio mantém, sempre troca, e caracteres especiais saem inteiros", () => {
    const especial = `a&b\\c$d"e'f=g/h+i`;
    const r = bash(
      `: > .env.local\n` +
        `definir_env .env.local SEGREDO "$ESPECIAL" se_vazio\n` +
        `definir_env .env.local SEGREDO outro se_vazio\n` +
        `valor_do_env .env.local SEGREDO\n` +
        `definir_env .env.local SEGREDO novo sempre\n` +
        `valor_do_env .env.local SEGREDO`,
      { ESPECIAL: especial },
    );
    expect(r.saida.split("\n")).toEqual([especial, "novo"]);
  });

  it("o valor do segredo NUNCA vai no argv de um processo (awk lê do ambiente)", () => {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const awkReal = spawnSync("bash", ["-c", "command -v awk"], { encoding: "utf8" }).stdout.trim();
    writeFileSync(join(bin, "awk"), `#!/usr/bin/env bash\nprintf '%s\\n' "$@" >> "${barras(join(dir, "argv.log"))}"\nexec "${awkReal}" "$@"\n`);
    chmodSync(join(bin, "awk"), 0o755);
    const SEGREDO = "segredo-que-nao-pode-aparecer-no-ps-123";
    const r = bash(
      'BINU="$(cygpath -u "$BIN" 2>/dev/null || printf %s "$BIN")"\nexport PATH="$BINU:$PATH"\n' +
        `: > .env.local\ndefinir_env .env.local K velho sempre\ndefinir_env .env.local K "${SEGREDO}" sempre\nvalor_do_env .env.local K`,
      { BIN: barras(bin) },
    );
    expect(r.saida).toBe(SEGREDO);
    const argv = readFileSync(join(dir, "argv.log"), "utf8");
    expect(argv.length).toBeGreaterThan(0); // o awk falso foi de fato usado
    expect(argv).not.toContain(SEGREDO);
  });

  it("ajustar_config_toml: portas padrão não mudam o arquivo; trocar e voltar é idempotente", () => {
    const alvo = join(dir, "config.toml");
    copyFileSync(CONFIG_TOML, alvo);
    const lido = () => readFileSync(alvo, "utf8").replace(/\r\n/g, "\n");

    bash(`ajustar_config_toml config.toml 54321 54322 3000`);
    expect(lido()).toBe(original);

    bash(`ajustar_config_toml config.toml 55321 55322 3100`);
    const trocado = lido();
    expect(trocado).toMatch(/^\[api\]\nenabled = true\nport = 55321$/m);
    expect(trocado).toMatch(/^port = 55322$/m);
    expect(trocado).toMatch(/^shadow_port = 55320$/m);
    expect(trocado).toMatch(/^port = 55329$/m);
    expect(trocado).toContain('site_url = "http://localhost:3100"');
    expect(trocado).toContain('"http://localhost:3100/auth/confirm"');
    expect(trocado).not.toContain("localhost:3000");

    bash(`ajustar_config_toml config.toml 54321 54322 3000`);
    expect(lido()).toBe(original);
  });
});

describe.skipIf(!temPowerShell)("PowerShell: scripts/lib/instalar-env.ps1 executado", () => {
  it("a porta escolhida PERSISTE e a segunda execução, sem a variável, a mantém", () => {
    const comando = `$a = Porta-Resolvida (Join-Path $PWD ".env.local") "CRM_ALQUIMIA_PORTA_APP" "3000"; Definir-NoEnv (Join-Path $PWD ".env.local") "CRM_ALQUIMIA_PORTA_APP" $a "sempre"; Write-Output $a`;
    expect(powershell(comando, { CRM_ALQUIMIA_PORTA_APP: "3100" }).saida).toBe("3100");
    expect(powershell(comando).saida).toBe("3100");
    expect(powershell(comando, { CRM_ALQUIMIA_PORTA_APP: "3200" }).saida).toBe("3200");
    expect(powershell(comando).saida).toBe("3200");
  });

  it("porta inválida lança erro", () => {
    for (const ruim of ["abc", "0", "70000"]) {
      const r = powershell(`Porta-Resolvida (Join-Path $PWD ".env.local") "CRM_ALQUIMIA_PORTA_APP" "3000"`, {
        CRM_ALQUIMIA_PORTA_APP: ruim,
      });
      expect(r.status, ruim).not.toBe(0);
    }
  });

  it("se_vazio mantém, sempre troca, e o valor sai inteiro", () => {
    const r = powershell(
      `$e = Join-Path $PWD ".env.local"\n` +
        `Definir-NoEnv $e "S" 'a&b$c"d' "se_vazio"\nDefinir-NoEnv $e "S" "outro" "se_vazio"\nWrite-Output (Valor-DoEnv $e "S")\n` +
        `Definir-NoEnv $e "S" "novo" "sempre"\nWrite-Output (Valor-DoEnv $e "S")`,
    );
    expect(r.saida.split(/\r?\n/)).toEqual(['a&b$c"d', "novo"]);
  });

  it("o .env.local não tem BOM e só o dono tem acesso", () => {
    const r = powershell(
      `$e = Join-Path $PWD ".env.local"\n[System.IO.File]::WriteAllText($e, "", (New-Object System.Text.UTF8Encoding($false)))\nRestringir-ArquivoAoDono $e\nDefinir-NoEnv $e "A" "1" "sempre"\nicacls $e`,
    );
    expect(r.status).toBe(0);
    expect(r.saida).not.toMatch(/Everyone|BUILTIN\\Users|Authenticated Users|Todos/i);
    const bytes = readFileSync(join(dir, ".env.local"));
    expect(bytes[0]).not.toBe(0xef);
    expect(bytes.toString("utf8")).toBe("A=1\n");
  });

  it("Ajustar-ConfigToml: padrão não muda; trocar e voltar é idempotente", () => {
    const alvo = join(dir, "config.toml");
    copyFileSync(CONFIG_TOML, alvo);
    const lido = () => readFileSync(alvo, "utf8").replace(/\r\n/g, "\n");
    powershell(`Ajustar-ConfigToml (Join-Path $PWD "config.toml") "54321" "54322" "3000"`);
    expect(lido()).toBe(original);
    powershell(`Ajustar-ConfigToml (Join-Path $PWD "config.toml") "55321" "55322" "3100"`);
    const trocado = lido();
    expect(trocado).toMatch(/^port = 55321$/m);
    expect(trocado).toMatch(/^shadow_port = 55320$/m);
    expect(trocado).toContain('site_url = "http://localhost:3100"');
    powershell(`Ajustar-ConfigToml (Join-Path $PWD "config.toml") "54321" "54322" "3000"`);
    expect(lido()).toBe(original);
  });
});
