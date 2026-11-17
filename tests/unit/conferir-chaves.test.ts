import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

/**
 * O ajudante que os dois instaladores usam para conferir se o Supabase de pé recebeu as chaves desta instalação
 * (scripts/lib/conferir-chaves.mjs). Aqui, só a leitura do `docker inspect` do Auth e do Kong: o texto literal
 * `env(NOME)` que a CLI deixa passar quando a variável falta reprova; uma chamada `getenv(`/`setenv(` qualquer, que
 * pode estar no comando de um contêiner, não.
 */
const AJUDANTE = path.join(process.cwd(), "scripts", "lib", "conferir-chaves.mjs");
const pasta = mkdtempSync(path.join(tmpdir(), "conferir-chaves-"));
const chaves = path.join(pasta, "signing_keys.json");
writeFileSync(chaves, JSON.stringify([{ kty: "EC", kid: "kid-desta-instalacao", d: "d-falsa", crv: "P-256", x: "x", y: "y" }]));
afterAll(() => rmSync(pasta, { recursive: true, force: true }));

const SECRETA = "sb_" + "secret_" + "ab".repeat(32);
function conferir(servico: "auth" | "kong", config: unknown) {
  const r = spawnSync("node", [AJUDANTE, servico, chaves], {
    input: JSON.stringify(config),
    encoding: "utf8",
    env: { ...process.env, CRM_ALQUIMIA_JWT_SECRET: "c0de".repeat(16), CRM_ALQUIMIA_SECRET_KEY: SECRETA, CRM_ALQUIMIA_PUBLISHABLE_KEY: "" },
  });
  return { codigo: r.status, motivo: r.stdout.trim() };
}

describe("conferir-chaves: o texto literal env(...) nos contêineres do Supabase", () => {
  it("Kong com getenv( e setenv( no comando (Lua, shell) passa", () => {
    const kong = { Cmd: [`local s = os.getenv("KONG_X"); setenv("Y", "1"); headers.apikey == '${SECRETA}'`] };
    expect(conferir("kong", kong)).toEqual({ codigo: 0, motivo: "" });
  });

  it("Kong com o texto literal env(CRM_ALQUIMIA_SECRET_KEY) reprova", () => {
    const kong = { Cmd: ["headers.apikey == 'env(CRM_ALQUIMIA_SECRET_KEY)' and 'Bearer x'"] };
    expect(conferir("kong", kong)).toEqual({ codigo: 1, motivo: "texto-env" });
  });

  it("Auth com getenv( no ambiente passa; com env(CRM_ALQUIMIA_JWT_SECRET) como segredo reprova", () => {
    expect(conferir("auth", { Env: ["GOTRUE_JWT_SECRET=" + "c0de".repeat(16), "WRAPPER=getenv(HOME)"] })).toEqual({ codigo: 0, motivo: "" });
    expect(conferir("auth", { Env: ["GOTRUE_JWT_SECRET=env(CRM_ALQUIMIA_JWT_SECRET)"] })).toEqual({ codigo: 1, motivo: "texto-env" });
  });
});

describe("instaladores: o texto do reinício não promete o que não é exato (R5-2)", () => {
  it("nenhuma mensagem diz que 'todo mundo entra de novo'", async () => {
    const { readFileSync } = await import("node:fs");
    for (const arq of ["scripts/instalar.ps1", "scripts/instalar.sh"]) {
      expect(readFileSync(path.join(process.cwd(), arq), "utf8"), arq).not.toContain("todo mundo entra de novo");
    }
  });
});
