import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * O `Dockerfile.worker` faz `COPY . .`, e o instalador constrói as imagens na pasta do CRM, onde também
 * moram os backups do banco (contatos, conversas, hashes de senha) e os logs. O que o `.dockerignore`
 * não exclui vira camada da imagem: fica fora da permissão "só o dono" da pasta, sobrevive à rotação
 * dos backups e vai junto num `docker save`. Além disso, todo backup novo invalidaria o cache do build.
 */
const linhas = readFileSync(path.join(process.cwd(), ".dockerignore"), "utf8")
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"));

describe(".dockerignore mantém dado local fora da imagem", () => {
  it.each([
    "backups/",
    "logs/",
    "*.sql.gz",
    "*.dump",
    ".trava-backup*",
    ".env",
    ".env.*",
    ".mazyos/",
    ".alethe/",
    "supabase/.temp/",
    // O `supabase start` cria estes depois do build: no contexto, a reinstalação perdia o cache do `COPY . .`
    // e recompilava o app inteiro (mais 2,7 GB na VM do Docker).
    "supabase/.branches/",
    "supabase/.supabase-snapshots/",
    ".supabase-snapshots/",
    "supabase/snippets/",
    "supabase/functions/",
    // O que o instalador cria e tira dali durante o `start` e o ajuste do config.
    "supabase/.migracoes-fora/",
    "supabase/config.toml.novo",
    // Segredos desta instalação: a chave que assina as sessões e o ambiente que a CLI lê.
    "supabase/signing_keys*",
    "supabase/.env",
    "supabase/.env.*",
    "*.tsbuildinfo",
    "node_modules",
    ".next",
  ])("exclui %s", (padrao) => {
    expect(linhas).toContain(padrao);
  });

  it("só o modelo de ambiente volta para o contexto", () => {
    const reincluidos = linhas.filter((l) => l.startsWith("!"));
    expect(reincluidos).toEqual(["!.env.example"]);
  });
});
