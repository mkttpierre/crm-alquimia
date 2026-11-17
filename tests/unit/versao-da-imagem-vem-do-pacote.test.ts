import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { versaoInstalada } from "@/lib/system/versao-instalada";
import { version as VERSAO_DO_PACOTE } from "@/package.json";

/**
 * A versão que a imagem carrega (`APP_VERSION`) vem do `package.json` da pasta instalada, nunca de um número
 * fixo no compose. Um padrão fixo (`${APP_VERSION:-1.0.0}`) fazia toda instalação pelo compose dizer a mesma
 * versão para sempre: depois da primeira release nova, a tela de Atualização e o `/api/v1/health` mentiam.
 */
const ler = (arquivo: string) => readFileSync(path.join(process.cwd(), arquivo), "utf8");

describe("a versão da imagem vem do package.json", () => {
  it("o compose não tem versão fixa: sem APP_VERSION, o argumento vai vazio", () => {
    const compose = ler("docker-compose.yml");
    const usos = [...compose.matchAll(/APP_VERSION:\s*(\S+)/g)].map((m) => m[1]);
    expect(usos.length).toBeGreaterThanOrEqual(3);
    for (const uso of usos) expect(uso).toBe("${APP_VERSION:-}");
  });

  it("o instalador bash grava e exporta APP_VERSION a partir do package.json antes de construir", () => {
    const sh = ler("scripts/instalar.sh");
    const grava = sh.indexOf('definir_env "$ENV_LOCAL" APP_VERSION "$VERSAO_DO_PACOTE" sempre');
    const exporta = sh.indexOf('export APP_VERSION="$VERSAO_DO_PACOTE"');
    const build = sh.indexOf("compose_crm \"$PROJETO\" build");
    expect(grava).toBeGreaterThan(0);
    expect(exporta).toBeGreaterThan(0);
    expect(build).toBeGreaterThan(exporta);
    expect(sh).toMatch(/VERSAO_DO_PACOTE="\$\(node -e "[^"]*require\('\.\/package\.json'\)\.version/);
  });

  it("o instalador PowerShell faz o mesmo", () => {
    const ps = ler("scripts/instalar.ps1");
    const grava = ps.indexOf('Definir-NoEnv $EnvCaminho "APP_VERSION" $VersaoDoPacote "sempre"');
    const exporta = ps.indexOf("$env:APP_VERSION = $VersaoDoPacote");
    const build = ps.indexOf("Compose-Crm $Projeto build");
    expect(grava).toBeGreaterThan(0);
    expect(exporta).toBeGreaterThan(0);
    expect(build).toBeGreaterThan(exporta);
  });

  it("o /health responde a mesma versão que a tela (vazio ou 'dev' caem no package.json)", () => {
    expect(ler("app/api/v1/health/route.ts")).toMatch(/version:\s*versaoInstalada\(null\)/);
    expect(versaoInstalada(null, "")).toBe(VERSAO_DO_PACOTE);
    expect(versaoInstalada(null, "dev")).toBe(VERSAO_DO_PACOTE);
    expect(versaoInstalada(null, "9.9.9")).toBe("9.9.9");
  });
});
