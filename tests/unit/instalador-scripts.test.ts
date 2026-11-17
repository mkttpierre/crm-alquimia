/**
 * Os scripts da instalação local de um comando (`scripts/instalar.*`, `scripts/parar.*`).
 *
 * ESTÁTICOS: nada aqui roda Docker nem o instalador (a prova de execução é a instalação numa pasta
 * limpa). Trancam o que, errado, só se descobre na máquina de outra pessoa:
 *   - o `.ps1` precisa parsear no Windows PowerShell 5.1 (sem `&&`, `||`, ternário nem `??`);
 *   - o `.sh` e o `.ps1` precisam gravar as MESMAS chaves no `.env.local`;
 *   - nenhum segredo vai para a tela, e o `supabase start` (que imprime as chaves) é descartado;
 *   - parar nunca apaga dados.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = process.cwd();
const ler = (arquivo: string) => readFileSync(join(RAIZ, arquivo), "utf8");

const sh = ler("scripts/instalar.sh");
const ps1 = ler("scripts/instalar.ps1");
const pararSh = ler("scripts/parar.sh");
const pararPs1 = ler("scripts/parar.ps1");

/** Remove comentários de linha inteira e o que vem depois de ` #` solto (aproximação suficiente aqui). */
const semComentario = (texto: string) =>
  texto
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n");

describe("PowerShell 5.1: instalar.ps1 e parar.ps1", () => {
  for (const [nome, texto] of [
    ["instalar.ps1", ps1],
    ["parar.ps1", pararPs1],
  ] as const) {
    const codigo = semComentario(texto);

    it(`${nome} não usa && nem || (só existem a partir do PowerShell 7)`, () => {
      expect(codigo).not.toContain("&&");
      expect(codigo).not.toContain("||");
    });

    it(`${nome} não usa ternário nem coalescência nula`, () => {
      expect(codigo).not.toMatch(/\?\?/);
      expect(codigo).not.toMatch(/\$\w+\s*\?\s*\S+\s*:\s*\S+/);
      expect(codigo).not.toMatch(/\?\./);
    });

    it(`${nome} começa com BOM UTF-8 (o 5.1 lê arquivo sem BOM como ANSI e estraga os acentos)`, () => {
      expect(texto.charCodeAt(0)).toBe(0xfeff);
    });
  }

  it("instalar.ps1 confere o código de saída dos comandos nativos", () => {
    expect(ps1).toContain("$LASTEXITCODE");
    expect(ps1).toContain('$ErrorActionPreference = "Continue"');
  });
});

describe("bash: instalar.sh e parar.sh", () => {
  it.each(["scripts/instalar.sh", "scripts/parar.sh"])("%s passa na checagem de sintaxe do bash", (arquivo) => {
    const r = spawnSync("bash", ["-n", join(RAIZ, arquivo)], { encoding: "utf8" });
    if (r.error) return; // sem bash na máquina que roda o teste: nada a conferir
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it("usa set -euo pipefail e devolve a pasta de migrations mesmo se morrer no meio", () => {
    expect(sh).toContain("set -euo pipefail");
    // O trap é o ao_sair, que devolve as migrations antes de qualquer outra coisa.
    expect(sh).toContain("trap ao_sair EXIT");
    expect(sh).toContain(["ao_sair() {", "  local codigo=$?", "  restaurar_migracoes", ""].join("\n"));
  });
});

describe("instalar.sh e instalar.ps1 fazem a mesma coisa", () => {
  const chavesDoSh = [...sh.matchAll(/^definir ([A-Z][A-Z0-9_]+) /gm)].map((m) => m[1]!);
  const chavesDoPs1 = [...ps1.matchAll(/^Definir "([A-Z][A-Z0-9_]+)"/gm)].map((m) => m[1]!);

  // Os segredos: no .sh um `definir X "$(segredo_*)"` por linha; no .ps1 uma lista percorrida por laço.
  const segredosDoSh = [...sh.matchAll(/^definir ([A-Z][A-Z0-9_]+) "\$\(segredo_(?:hex|base64)\)"/gm)].map((m) => m[1]!);
  const listasDoPs1 = [...ps1.matchAll(/foreach \(\$nome in @\(([^)]*)\)\) \{\s*\n\s*if \(\(Valor-Atual \$nome\) -eq ""\)/g)]
    .flatMap((m) => [...m[1]!.matchAll(/"([A-Z][A-Z0-9_]+)"/g)].map((x) => x[1]!));

  it("as chaves derivadas gravadas são as mesmas", () => {
    const derivadasSh = chavesDoSh.filter((c) => !segredosDoSh.includes(c)).sort();
    expect(derivadasSh.length).toBeGreaterThan(8);
    expect([...new Set(chavesDoPs1)].sort()).toEqual([...new Set(derivadasSh)].sort());
  });

  it("os segredos gerados são os mesmos", () => {
    expect(segredosDoSh.length).toBeGreaterThan(8);
    expect([...listasDoPs1].sort()).toEqual([...segredosDoSh].sort());
  });

  it("cobre tudo o que lib/env.ts exige em produção e o que o compose pede", () => {
    const todas = new Set([...chavesDoSh, "UPSTASH_REDIS_REST_TOKEN"]);
    for (const exigida of [
      "NEXT_PUBLIC_SUPABASE_URL",
      "NEXT_PUBLIC_SUPABASE_ANON_KEY",
      "SUPABASE_SERVICE_ROLE_KEY",
      "SUPABASE_DB_URL",
      "INTERNAL_SECRET",
      "CPF_ENCRYPTION_KEY",
      "WAHA_BYO_ENCRYPTION_KEY",
      "AI_CRED_AES_KEY",
      "UPSTASH_REDIS_REST_URL",
      "UPSTASH_REDIS_REST_TOKEN",
      "EVOLUTION_API_BASE_URL",
      "EVOLUTION_API_KEY",
      "EVOLUTION_WEBHOOK_TOKEN",
      "EVOLUTION_WEBHOOK_GLOBAL",
      "EVOLUTION_DB_PASSWORD",
      "SRH_TOKEN",
    ]) {
      expect(todas.has(exigida), `instalar.sh não grava ${exigida}`).toBe(true);
    }
  });

  it("os dois mantêm o segredo que já existe e deixam o envio real desligado", () => {
    expect(sh).toContain("se_vazio");
    expect(ps1).toContain('-eq ""');
    expect(sh).toMatch(/DISPARO_REAL_LIBERADO=\\n/);
    expect(ps1).toContain('Definir "DISPARO_REAL_LIBERADO" ""');
    expect(sh).not.toMatch(/definir DISPARO_REAL_LIBERADO "sim"/);
    expect(ps1).not.toMatch(/Definir "DISPARO_REAL_LIBERADO" "sim"/);
  });

  it("os dois aplicam o baseline, reiniciam o Realtime e esperam /login e o healthz do worker", () => {
    for (const texto of [sh, ps1]) {
      expect(texto).toContain("baseline.sql");
      expect(texto).toContain("supabase_realtime_");
      expect(texto).toContain("/login");
      expect(texto).toContain("/healthz");
      expect(texto).toContain("/signup");
      expect(texto).toContain("--env-file .env.local");
    }
  });
});

describe("o .env.local só é legível pelo dono e as portas persistem", () => {
  it("instalar.sh roda sob umask 077, aperta o .env.local no fim e usa as funções testadas de lib/", () => {
    expect(sh).toMatch(/^umask 077$/m);
    expect(sh).toContain("source scripts/lib/instalar-env.sh");
    expect(sh.lastIndexOf('chmod 600 "$ENV_LOCAL"')).toBeGreaterThan(sh.lastIndexOf("definir UPSTASH_REDIS_REST_TOKEN"));
    expect(sh).toContain("porta_resolvida");
  });

  it("instalar.ps1 restringe o .env.local ao dono e resolve as portas pela mesma regra", () => {
    expect(ps1).toContain("Restringir-ArquivoAoDono");
    expect(ps1).toContain("Porta-Resolvida");
    expect(ps1).toContain('. (Join-Path $PSScriptRoot "lib\\instalar-env.ps1")');
  });

  it("os dois gravam as portas escolhidas no .env.local", () => {
    for (const v of ["APP", "WORKER", "EVOLUTION", "SUPABASE_API", "SUPABASE_DB"]) {
      expect(sh).toContain(`definir_env "$ENV_LOCAL" CRM_ALQUIMIA_PORTA_${v} `);
      expect(ps1).toContain(`Definir-NoEnv $EnvCaminho "CRM_ALQUIMIA_PORTA_${v}"`);
    }
  });

  it("o segredo não vai no argv: nenhum awk com -v recebe valor de .env.local", () => {
    const lib = ler("scripts/lib/instalar-env.sh");
    expect(lib).toContain('ENVIRON["CRM_VALOR_DO_ENV"]');
    expect(lib).not.toMatch(/awk[^\n]*-v v=/);
    expect(sh).not.toMatch(/awk[^\n]*-v v=/);
  });

  it("o navegador usa localhost e os contêineres host.docker.internal (SUPABASE_URL_INTERNA)", () => {
    expect(sh).toContain('definir NEXT_PUBLIC_SUPABASE_URL "http://localhost:${PORTA_API}" sempre');
    expect(sh).toContain('definir SUPABASE_URL_INTERNA "http://host.docker.internal:${PORTA_API}" sempre');
    expect(ps1).toContain('Definir "NEXT_PUBLIC_SUPABASE_URL" "http://localhost:$PortaApi" "sempre"');
    expect(ps1).toContain('Definir "SUPABASE_URL_INTERNA" "http://host.docker.internal:$PortaApi" "sempre"');
  });
});

describe("nenhum segredo vai para a tela", () => {
  it("o 'supabase start' (que imprime as chaves) é descartado nos dois", () => {
    // O stderr (progresso e erro, sem chaves) vai para a tela e fica guardado para a mensagem de
    // falha. Do stdout, que traz as chaves, só passam as linhas de erro da CLI (o JSON `"_tag":"Error"`),
    // e mesmo nelas o que tiver forma de chave vira <oculto>. No PS, o mesmo filtro nas linhas que não são ErrorRecord.
    expect(sh).toContain(`supabase_crm start -x "$SUPABASE_SERVICOS_FORA" 2>&3 | linhas_de_erro_da_cli >&3`);
    expect(ps1).toMatch(
      /start -x \$script:SupabaseServicosFora --workdir \$Raiz 2>&1 \| ForEach-Object \{\s*if \(\$_ -is \[System\.Management\.Automation\.ErrorRecord\]\)/,
    );
    expect(ps1).toMatch(/\} else \{\s*\$linha = Linha-DeErroDaCli \(\[string\]\$_\)/);
    for (const lib of [ler("scripts/lib/instalar-env.sh"), ler("scripts/lib/instalar-env.ps1")]) {
      expect(lib).toContain('"_tag":"Error"');
      expect(lib).toContain("<oculto>");
    }
  });

  it("nenhuma linha de saída ao usuário cita variável de segredo ou imprime o .env.local", () => {
    const saidaSh = semComentario(sh).split("\n").filter((l) => /^\s*(log|falha|echo)\b/.test(l) || /printf '==>/.test(l));
    const saidaPs1 = semComentario(ps1).split("\n").filter((l) => /\b(Log|Falha|Write-Host)\b/.test(l));
    for (const linha of [...saidaSh, ...saidaPs1]) {
      // Cita o NOME de uma chave numa mensagem de erro, mas nunca a VARIÁVEL que guarda o valor.
      expect(linha, linha).not.toMatch(/\$\{?(CHAVE_|SRH|STATUS_ENV|ENV_LOCAL)|\$(ChaveAnon|ChaveServico|StatusEnv|EnvLinhas)/);
    }
    for (const texto of [sh, ps1]) {
      expect(semComentario(texto)).not.toMatch(/\b(cat|type|Get-Content)\b[^\n]*\.env\.local/);
      expect(semComentario(texto)).not.toMatch(/set -x|Set-PSDebug|Start-Transcript/);
    }
  });

  it("o .env.local nasce com permissão restrita (no .sh)", () => {
    expect(sh).toContain('chmod 600 "$ENV_LOCAL"');
  });
});

describe("parar nunca apaga dados", () => {
  it.each([
    ["parar.sh", pararSh],
    ["parar.ps1", pararPs1],
  ])("%s não usa down -v, --volumes nem --no-backup", (_nome, texto) => {
    const codigo = semComentario(texto);
    expect(codigo).not.toMatch(/--volumes|down\s+-v|--no-backup/);
    expect(codigo).toContain("down");
    expect(codigo).toContain("stop");
  });

  it("o instalador também nunca apaga volume nem banco", () => {
    for (const texto of [sh, ps1]) {
      const codigo = semComentario(texto);
      expect(codigo).not.toMatch(/--volumes|down\s+-v|--no-backup|volume rm|volume prune|db reset|drop (database|schema)/i);
    }
  });
});

describe("portas configuráveis", () => {
  it.each([sh, ps1])("lê as variáveis CRM_ALQUIMIA_PORTA_*", (texto) => {
    for (const v of [
      "CRM_ALQUIMIA_PORTA_APP",
      "CRM_ALQUIMIA_PORTA_WORKER",
      "CRM_ALQUIMIA_PORTA_EVOLUTION",
      "CRM_ALQUIMIA_PORTA_SUPABASE_API",
      "CRM_ALQUIMIA_PORTA_SUPABASE_DB",
    ]) {
      expect(texto, v).toContain(v);
    }
  });
});
