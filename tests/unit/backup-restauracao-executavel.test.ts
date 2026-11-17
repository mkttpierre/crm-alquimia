/**
 * Backup e restauração de um comando (`scripts/backup.*`, `scripts/restaurar.*`), EXECUTADOS de verdade
 * (bash e Windows PowerShell 5.1) numa cópia temporária do projeto. Sem Docker real: um `docker` FALSO
 * no PATH registra cada chamada (argumentos e o conteúdo dos arquivos enviados ao contêiner) e finge as
 * respostas. Nada aqui toca banco, contêiner ou volume de verdade.
 *
 * Trancam: nome com data, retenção de 14, confirmação `RESTAURAR`, backup do estado atual ANTES de
 * restaurar, segredo fora do argv e da tela, permissão só do dono, e mensagens explicativas com código de
 * saída diferente de zero quando o Docker está parado ou o banco fora do ar.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import { afterAll, describe, expect, it } from "vitest";

const RAIZ = process.cwd();
// De onde copiar os scripts (padrão: este checkout); outra pasta mede uma versão antiga com estes testes.
const FONTE = process.env.CRM_ALQUIMIA_TESTE_FONTE_SCRIPTS || RAIZ;
const ehWindows = process.platform === "win32";
const temBash = !spawnSync("bash", ["-c", "true"]).error;
const temPowerShell = ehWindows && !spawnSync("powershell", ["-NoProfile", "-Command", "1"]).error;

const pastas: string[] = [];
afterAll(() => {
  for (const p of pastas) rmSync(p, { recursive: true, force: true });
});

const DOCKER_FALSO = `
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
const registro = { argv: args };
const ehConteiner = (s) => /^[A-Za-z0-9_.-]{2,}:/.test(s || "");
function fim(codigo, mensagem) {
  if (mensagem) process.stderr.write(mensagem + "\\n");
  if (process.env.FAKE_DOCKER_LOG) fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(registro) + "\\n");
  process.exit(codigo);
}
const [cmd, ...resto] = args;
if (cmd === "info") {
  if (process.env.FAKE_DOCKER_PARADO) fim(1, "failed to connect to the docker API");
  fim(0);
}
if (cmd === "inspect") {
  const nome = resto[resto.length - 1];
  if (process.env.FAKE_DOCKER_SEM_CONTEINER === nome) fim(1, "Error: No such object: " + nome);
  process.stdout.write("true\\n");
  fim(0);
}
if (cmd === "exec") {
  const linha = resto.slice(1);
  const prog = linha[0];
  if (prog === "pg_isready") fim(process.env.FAKE_DOCKER_BANCO_FORA ? 2 : 0);
  if (prog === "pg_dump" && process.env.FAKE_DOCKER_FALHA_PGDUMP === "muda") fim(137);
  if (prog === "pg_dump" && process.env.FAKE_DOCKER_FALHA_PGDUMP) fim(1, "pg_dump: error: erro falso do dump");
  if (prog === "pg_dump" && process.env.FAKE_DOCKER_DORME_PGDUMP) {
    // um pg_dump lento: dá tempo de o teste interromper o backup no meio
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_DOCKER_DORME_PGDUMP));
  }
  if (prog === "psql" && linha.includes("-c") && /app_secrets/.test(linha[linha.indexOf("-c") + 1] || "")) {
    // a chave de cifra que o banco usa (private.app_secrets): a do teste, ou nenhuma
    if (process.env.FAKE_DOCKER_CHAVE) process.stdout.write(process.env.FAKE_DOCKER_CHAVE + "\\n");
    fim(0);
  }
  if (prog === "psql" && linha.includes("-c")) {
    // consulta (só leitura) da versão instalada em public.system_version
    if (process.env.FAKE_DOCKER_SEM_VERSAO) fim(1, "psql: relation does not exist");
    process.stdout.write((process.env.FAKE_DOCKER_VERSAO ?? "1.4.0") + "\\n");
    fim(0);
  }
  if (prog === "psql" && process.env.FAKE_DOCKER_FALHA_PSQL) fim(3, "psql:/tmp/crm-restaurar.sql:9: ERROR:  erro falso da carga");
  // Falhas da carga fora do formato do Postgres: o docker sem conseguir rodar o psql, o psql
  // morto por falta de memória (137, nada escrito) e um erro com o dado da linha no DETAIL (m1).
  const falhaCarga = process.env.FAKE_DOCKER_FALHA_CARGA;
  if (prog === "psql" && linha.includes("/tmp/crm-prelude.sql") && falhaCarga === "sem-rotulo") {
    fim(126, 'OCI runtime exec failed: exec failed: unable to start container process: exec: "psql": executable file not found in $PATH: unknown');
  }
  if (prog === "psql" && linha.includes("/tmp/crm-prelude.sql") && falhaCarga === "muda") fim(137);
  if (prog === "psql" && linha.includes("/tmp/crm-prelude.sql") && falhaCarga === "dado") {
    fim(3, 'psql:/tmp/crm-restaurar.sql:12: ERROR:  duplicate key value violates unique constraint "contacts_email_key"\\nDETAIL:  Key (email)=(fulana.secreta@exemplo.test) already exists.\\nDETAIL:  Failing row contains (42, Fulana Secreta, fulana.secreta@exemplo.test).');
  }
  if (prog === "psql" && linha.includes("/tmp/crm-prelude.sql") && falhaCarga === "dado-formatos-r4") {
    // Valores que o Postgres cita fora do COPY e do Key
    fim(3, [
      'psql:/tmp/crm-restaurar.sql:50: ERROR:  date/time field value out of range: "2020-13-45"',
      'psql:/tmp/crm-restaurar.sql:51: ERROR:  value "3000000000" is out of range for type integer',
      'psql:/tmp/crm-restaurar.sql:52: ERROR:  invalid input syntax for type json',
      'DETAIL:  Token "Fulana" is invalid.',
      'CONTEXT:  JSON data, line 1: Fulana Secreta',
    ].join("\\n"));
  }
  if (prog === "psql" && linha.includes("/tmp/crm-prelude.sql") && falhaCarga === "dado-formatos") {
    // Os formatos que a máscara anterior deixava passar
    fim(3, [
      'psql:/tmp/crm-restaurar.sql:12: ERROR:  duplicate key value violates unique constraint "contacts_email_lower_key"',
      "DETAIL:  Key (lower(email::text))=(beltrana.oculta@exemplo.test) already exists.",
      'CONTEXT:  COPY contacts, line 3: "0b1c\\tBeltrana Oculta\\tbeltrana.oculta@exemplo.test\\t+5500987650000"',
      'psql:/tmp/crm-restaurar.sql:40: ERROR:  invalid input syntax for type integer: "Ciclano Escondido"',
      'CONTEXT:  COPY crm_leads, line 7, column valor_cents: "Ciclano Escondido"',
    ].join("\\n"));
  }
  if (prog === "psql" && linha.includes("/tmp/crm-prelude.sql")) {
    // Como no banco do Supabase: só o supabase_admin é dono das sequências de auth.*; como
    // postgres, o TRUNCATE ... RESTART IDENTITY do prelúdio falha e a transação inteira volta atrás.
    const usuario = linha[linha.indexOf("-U") + 1];
    if (usuario !== "supabase_admin") {
      fim(3, "psql:/tmp/crm-prelude.sql:29: NOTICE:  truncate cascades to table \\"messages\\"\\npsql:/tmp/crm-prelude.sql:29: ERROR:  must be owner of sequence refresh_tokens_id_seq\\nCONTEXT:  SQL statement \\"TRUNCATE TABLE auth.users RESTART IDENTITY CASCADE\\"");
    }
    // a carga boa também fala: centenas de NOTICE e WARNING que não são erro (B8)
    let ruido = "";
    for (let i = 0; i < 170; i++) ruido += 'psql:/tmp/crm-prelude.sql:29: NOTICE:  truncate cascades to table "tabela_' + i + '"\\n';
    ruido += "psql:/tmp/crm-restaurar.sql:40: WARNING:  ivfflat index created with little data\\nDETAIL:  This will cause low recall.\\nHINT:  Drop the index until the table has more data.\\n";
    process.stderr.write(ruido);
  }
  if (prog === "pg_dump") {
    let ruido = "";
    for (let i = 0; i < 9; i++) ruido += "pg_dump: warning: there are circular foreign-key constraints on this table:\\npg_dump: detail: tabela_" + i + "\\npg_dump: hint: You might not be able to restore the dump without using --disable-triggers or temporarily dropping the constraints.\\n";
    process.stderr.write(ruido);
  }
  fim(0);
}
if (cmd === "cp") {
  const [origem, destino] = resto;
  if (process.env.FAKE_DOCKER_FALHA_CP_PARA_STORAGE && /^supabase_storage_/.test(destino || "")) {
    fim(1, "Error: falha falsa ao copiar para o Storage");
  }
  if (ehConteiner(origem)) {
    if (/\\/\\.$/.test(origem)) {
      if (process.env.FAKE_DOCKER_FALHA_CP_STORAGE) fim(1, "Error: No such container:path");
      fs.mkdirSync(path.join(destino, "bucket-falso"), { recursive: true });
      fs.writeFileSync(path.join(destino, "bucket-falso", "arquivo.txt"), "arquivo falso do storage");
      fs.chmodSync(path.join(destino, "bucket-falso", "arquivo.txt"), 0o644);
      fs.chmodSync(path.join(destino, "bucket-falso"), 0o755);
    } else {
      fs.writeFileSync(destino, "-- dump falso do banco\\nCOPY public.exemplo FROM stdin;\\n");
      fs.chmodSync(destino, 0o644);
    }
  } else if (ehConteiner(destino)) {
    const st = fs.statSync(origem);
    if (st.isFile()) registro.conteudo = fs.readFileSync(origem, "utf8").slice(0, 4000);
    else registro.arquivos = fs.readdirSync(origem);
  }
  fim(0);
}
if (cmd === "compose" && resto[0] === "version") { process.stdout.write("Docker Compose version v2.0.0\\n"); fim(0); }
fim(0);
`;

// Schema falso (com CRLF, como num checkout do Windows): a "versão do schema" é o sha256 dele SEM os \r,
// para o mesmo backup valer no Windows e no Linux.
const BASELINE_FALSO = "create table public.a (id int);\r\ncreate table public.b (id int);\r\n";
const HASH_BASELINE = createHash("sha256").update(BASELINE_FALSO.replace(/\r/g, "")).digest("hex");
const VERSAO_PADRAO = "1.4.0";

type Sistema = "bash" | "ps1";

interface Projeto {
  dir: string;
  log: string;
  binBash: string;
  binPs1: string;
}

function lerLog(p: Projeto): Array<{ argv: string[]; conteudo?: string; arquivos?: string[] }> {
  if (!existsSync(p.log)) return [];
  return readFileSync(p.log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}
const chamadas = (p: Projeto) => lerLog(p).map((c) => c.argv.join(" "));

function criarProjeto(): Projeto {
  const dir = mkdtempSync(join(tmpdir(), "crm-backup-"));
  pastas.push(dir);
  mkdirSync(join(dir, "scripts", "lib"), { recursive: true });
  for (const arq of [
    "scripts/backup.sh",
    "scripts/backup.ps1",
    "scripts/restaurar.sh",
    "scripts/restaurar.ps1",
    "scripts/restaurar-preludio.sql",
    "scripts/lib/instalar-env.sh",
    "scripts/lib/instalar-env.ps1",
    "scripts/lib/backup.sh",
    "scripts/lib/backup.ps1",
  ]) {
    if (existsSync(join(FONTE, arq))) copyFileSync(join(FONTE, arq), join(dir, arq));
  }
  mkdirSync(join(dir, "supabase"), { recursive: true });
  writeFileSync(join(dir, "supabase", "baseline.sql"), BASELINE_FALSO);
  writeFileSync(
    join(dir, ".env.local"),
    "CRM_ALQUIMIA_PORTA_SUPABASE_DB=54322\nSUPABASE_SERVICE_ROLE_KEY=chave-de-servico-secreta-111\nEVOLUTION_DB_PASSWORD=senha-do-banco-222\nINTERNAL_SECRET=segredo-interno-333\n",
  );
  const bin = join(dir, "_bin");
  const binBash = join(bin, "bash");
  const binPs1 = join(bin, "ps1");
  mkdirSync(binBash, { recursive: true });
  mkdirSync(binPs1, { recursive: true });
  writeFileSync(join(bin, "docker-falso.js"), DOCKER_FALSO);
  writeFileSync(
    join(binBash, "docker"),
    '#!/usr/bin/env bash\nAQUI="$(cd "$(dirname "$0")/.." && (pwd -W 2>/dev/null || pwd))"\nexec node "$AQUI/docker-falso.js" "$@"\n',
  );
  chmodSync(join(binBash, "docker"), 0o755);
  writeFileSync(join(binPs1, "docker.cmd"), '@echo off\r\nnode "%~dp0..\\docker-falso.js" %*\r\n');
  return { dir, log: join(dir, "docker.log"), binBash, binPs1 };
}

function ambiente(p: Projeto, sistema: Sistema, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  // Cópia tipada de process.env (NodeJS.ProcessEnv, que o Next declara com NODE_ENV), sem PATH e sem as variáveis do teste.
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^path$/i.test(k) || k.startsWith("CRM_ALQUIMIA_") || k.startsWith("FAKE_DOCKER_")) delete env[k];
  }
  env.PATH = `${sistema === "bash" ? p.binBash : p.binPs1}${delimiter}${process.env.PATH ?? process.env.Path ?? ""}`;
  env.FAKE_DOCKER_LOG = p.log;
  return { ...env, ...extra };
}

function executar(
  p: Projeto,
  sistema: Sistema,
  script: "backup" | "restaurar",
  opcoes: { stdin?: string; env?: Record<string, string>; args?: string[] } = {},
) {
  const env = ambiente(p, sistema, opcoes.env);
  const r =
    sistema === "bash"
      ? spawnSync("bash", [join(p.dir, "scripts", `${script}.sh`), ...(opcoes.args ?? [])], {
          cwd: p.dir,
          encoding: "utf8",
          env,
          input: opcoes.stdin ?? "",
        })
      : spawnSync(
          "powershell",
          ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(p.dir, "scripts", `${script}.ps1`), ...(opcoes.args ?? [])],
          { cwd: p.dir, encoding: "utf8", env, input: opcoes.stdin ?? "" },
        );
  return { saida: r.stdout, erro: r.stderr, tudo: `${r.stdout}\n${r.stderr}`, status: r.status };
}

const PADRAO_NOME = /^\d{4}-\d{2}-\d{2}-\d{4}(-\d+)?\.sql\.gz$/;
const backupsDe = (p: Projeto) =>
  existsSync(join(p.dir, "backups")) ? readdirSync(join(p.dir, "backups")).filter((n) => n.endsWith(".sql.gz")).sort() : [];

/**
 * Um backup "antigo" já pronto na pasta (o .sql.gz, a pasta de arquivos e o registro de versão ao lado).
 * `versao: null` planta um backup de antes do registro de versão (sem o -versao.txt).
 */
function plantarBackup(
  p: Projeto,
  nome: string,
  sql = `-- backup plantado ${nome}\n`,
  versao: { hash?: string; atual?: string } | null = {},
) {
  mkdirSync(join(p.dir, "backups", `${nome}-storage`), { recursive: true });
  writeFileSync(join(p.dir, "backups", `${nome}.sql.gz`), gzipSync(sql));
  writeFileSync(join(p.dir, "backups", `${nome}-storage`, "x.txt"), `storage ${nome}`);
  if (versao !== null) {
    writeFileSync(
      join(p.dir, "backups", `${nome}-versao.txt`),
      `baseline_sha256=${versao.hash ?? HASH_BASELINE}\ncurrent_version=${versao.atual ?? VERSAO_PADRAO}\n`,
    );
  }
}

function sufixoDeVinte(n: number) {
  return String(n).padStart(2, "0");
}

const sistemas: Array<[Sistema, boolean]> = [
  ["bash", temBash],
  ["ps1", temPowerShell],
];

for (const [sistema, disponivel] of sistemas) {
  describe.skipIf(!disponivel)(`${sistema}: backup executado`, () => {
    it("cria AAAA-MM-DD-HHMM.sql.gz (gzip de verdade com o dump) e a cópia do Storage ao lado", () => {
      const p = criarProjeto();
      const r = executar(p, sistema, "backup");
      expect(r.status, r.tudo).toBe(0);
      const lista = backupsDe(p);
      expect(lista).toHaveLength(1);
      expect(lista[0]).toMatch(PADRAO_NOME);
      const stem = lista[0]!.replace(/\.sql\.gz$/, "");
      const sql = gunzipSync(readFileSync(join(p.dir, "backups", lista[0]!))).toString("utf8");
      expect(sql).toContain("dump falso do banco");
      expect(readFileSync(join(p.dir, "backups", `${stem}-storage`, "bucket-falso", "arquivo.txt"), "utf8")).toBe(
        "arquivo falso do storage",
      );
      // nenhuma sobra de trabalho parcial
      expect(readdirSync(join(p.dir, "backups")).filter((n) => n.startsWith("."))).toEqual([]);
      // o pg_dump rodou DENTRO do contêiner do Supabase (sem senha) e só os dados dos três schemas
      const chamada = chamadas(p).find((c) => c.includes("pg_dump"))!;
      expect(chamada).toContain("exec supabase_db_crm-alquimia pg_dump");
      expect(chamada).toContain("--data-only");
      expect(chamada).toContain("--schema=public");
      expect(chamada).toContain("--schema=auth");
      expect(chamada).toContain("--schema=storage");
      expect(chamadas(p).some((c) => c.includes("cp supabase_storage_crm-alquimia:"))).toBe(true);
      // o arquivo temporário do contêiner é apagado
      // o temporário no contêiner tem nome único por backup (dois backups ao mesmo tempo não se pisam)
      expect(chamada).toContain(`-f /tmp/crm-backup-${stem}.sql`);
      expect(chamadas(p).some((c) => c.includes(`exec supabase_db_crm-alquimia rm -f /tmp/crm-backup-${stem}.sql`))).toBe(true);
      // registro da versão do schema ao lado (sha256 do baseline sem \r + a versão instalada)
      const versao = readFileSync(join(p.dir, "backups", `${stem}-versao.txt`), "utf8");
      expect(versao).toContain(`baseline_sha256=${HASH_BASELINE}`);
      expect(versao).toContain(`current_version=${VERSAO_PADRAO}`);
      // diz onde ficou
      expect(r.saida).toContain(lista[0]!);
    });

    it("sem a tabela de versão (consulta falha), o backup sai igual, só com current_version vazio", () => {
      const p = criarProjeto();
      const r = executar(p, sistema, "backup", { env: { FAKE_DOCKER_SEM_VERSAO: "1" } });
      expect(r.status, r.tudo).toBe(0);
      const stem = backupsDe(p)[0]!.replace(/\.sql\.gz$/, "");
      const versao = readFileSync(join(p.dir, "backups", `${stem}-versao.txt`), "utf8");
      expect(versao).toContain(`baseline_sha256=${HASH_BASELINE}`);
      expect(versao).toMatch(/^current_version=$/m);
    });

    it("retenção também limpa sobras de trabalho (.parcial-*, .restaurando-*) com mais de 1 dia, e só elas", () => {
      const p = criarProjeto();
      const bk = join(p.dir, "backups");
      for (const n of [".parcial-velho", ".restaurando-velho", ".parcial-novo", ".outra-coisa"]) {
        mkdirSync(join(bk, n), { recursive: true });
        writeFileSync(join(bk, n, "x"), "x");
      }
      const doisDias = (Date.now() - 2 * 24 * 3600 * 1000) / 1000;
      for (const n of [".parcial-velho", ".restaurando-velho", ".outra-coisa"]) utimesSync(join(bk, n), doisDias, doisDias);
      const r = executar(p, sistema, "backup");
      expect(r.status, r.tudo).toBe(0);
      expect(existsSync(join(bk, ".parcial-velho"))).toBe(false);
      expect(existsSync(join(bk, ".restaurando-velho"))).toBe(false);
      expect(existsSync(join(bk, ".parcial-novo"))).toBe(true);
      expect(existsSync(join(bk, ".outra-coisa"))).toBe(true);
    });

    it("dois backups no mesmo minuto não se sobrescrevem", () => {
      const p = criarProjeto();
      expect(executar(p, sistema, "backup").status).toBe(0);
      expect(executar(p, sistema, "backup").status).toBe(0);
      expect(executar(p, sistema, "backup").status).toBe(0);
      const lista = backupsDe(p);
      expect(lista).toHaveLength(3);
      expect(new Set(lista).size).toBe(3);
    });

    it("retenção: mantém só os 14 mais novos (apaga os mais velhos e a pasta de arquivos deles) e nunca o recém-criado", () => {
      const p = criarProjeto();
      for (let i = 1; i <= 16; i++) plantarBackup(p, `2026-01-${sufixoDeVinte(i)}-0900`);
      writeFileSync(join(p.dir, "backups", "minha-nota.txt"), "não mexa");
      const r = executar(p, sistema, "backup");
      expect(r.status, r.tudo).toBe(0);
      const lista = backupsDe(p);
      expect(lista).toHaveLength(14);
      // 17 no total (16 + o novo): saem os 3 mais velhos
      for (const velho of ["2026-01-01-0900", "2026-01-02-0900", "2026-01-03-0900"]) {
        expect(existsSync(join(p.dir, "backups", `${velho}.sql.gz`)), velho).toBe(false);
        expect(existsSync(join(p.dir, "backups", `${velho}-storage`)), velho).toBe(false);
        expect(existsSync(join(p.dir, "backups", `${velho}-versao.txt`)), velho).toBe(false);
      }
      expect(existsSync(join(p.dir, "backups", "2026-01-04-0900-versao.txt"))).toBe(true);
      expect(existsSync(join(p.dir, "backups", "2026-01-04-0900.sql.gz"))).toBe(true);
      expect(existsSync(join(p.dir, "backups", "2026-01-04-0900-storage"))).toBe(true);
      expect(lista.some((n) => !n.startsWith("2026-01-"))).toBe(true); // o novo continua lá
      expect(readFileSync(join(p.dir, "backups", "minha-nota.txt"), "utf8")).toBe("não mexa");
    });

    it("com 14 ou menos, nada é apagado", () => {
      const p = criarProjeto();
      for (let i = 1; i <= 13; i++) plantarBackup(p, `2026-01-${sufixoDeVinte(i)}-0900`);
      expect(executar(p, sistema, "backup").status).toBe(0);
      expect(backupsDe(p)).toHaveLength(14);
    });

    it("Docker parado: mensagem explicativa, código ≠ 0 e nenhum backup", () => {
      const p = criarProjeto();
      const r = executar(p, sistema, "backup", { env: { FAKE_DOCKER_PARADO: "1" } });
      expect(r.status).not.toBe(0);
      expect(r.tudo).toMatch(/Docker/);
      expect(r.tudo).toMatch(/Docker Desktop/);
      expect(backupsDe(p)).toEqual([]);
      expect(chamadas(p).some((c) => c.includes("pg_dump"))).toBe(false);
    });

    it("Supabase fora do ar (contêiner do banco parado): diz para rodar o instalador, código ≠ 0", () => {
      const p = criarProjeto();
      const r = executar(p, sistema, "backup", { env: { FAKE_DOCKER_SEM_CONTEINER: "supabase_db_crm-alquimia" } });
      expect(r.status).not.toBe(0);
      expect(r.tudo).toContain("supabase_db_crm-alquimia");
      expect(r.tudo).toMatch(/instalar/);
      expect(backupsDe(p)).toEqual([]);
    });

    it("banco que não aceita conexões: erro explicativo e código ≠ 0", () => {
      const p = criarProjeto();
      const r = executar(p, sistema, "backup", { env: { FAKE_DOCKER_BANCO_FORA: "1" } });
      expect(r.status).not.toBe(0);
      expect(r.tudo).toMatch(/banco/i);
      expect(backupsDe(p)).toEqual([]);
    });

    it("pg_dump que falha: nenhum backup (nem parcial) e a retenção NÃO apaga nada", () => {
      const p = criarProjeto();
      for (let i = 1; i <= 16; i++) plantarBackup(p, `2026-01-${sufixoDeVinte(i)}-0900`);
      const r = executar(p, sistema, "backup", { env: { FAKE_DOCKER_FALHA_PGDUMP: "1" } });
      expect(r.status).not.toBe(0);
      expect(backupsDe(p)).toHaveLength(16);
      expect(readdirSync(join(p.dir, "backups")).filter((n) => n.startsWith("."))).toEqual([]);
    });

    it("cópia do Storage que falha: nenhum backup (um backup pela metade engana)", () => {
      const p = criarProjeto();
      const r = executar(p, sistema, "backup", { env: { FAKE_DOCKER_FALHA_CP_STORAGE: "1" } });
      expect(r.status).not.toBe(0);
      expect(backupsDe(p)).toEqual([]);
      expect(existsSync(join(p.dir, "backups")) ? readdirSync(join(p.dir, "backups")) : []).toEqual([]);
    });

    it("nenhum segredo do .env.local vai no argv do docker nem na tela", () => {
      const p = criarProjeto();
      const r = executar(p, sistema, "backup");
      expect(r.status, r.tudo).toBe(0);
      const todo = `${chamadas(p).join("\n")}\n${r.tudo}`;
      for (const segredo of ["chave-de-servico-secreta-111", "senha-do-banco-222", "segredo-interno-333"]) {
        expect(todo).not.toContain(segredo);
      }
    });

    it("os avisos do pg_dump vão para logs/backup.log; na tela fica só o resumo", () => {
      const p = criarProjeto();
      const r = executar(p, sistema, "backup");
      expect(r.status, r.tudo).toBe(0);
      expect(r.tudo).not.toMatch(/circular foreign-key/);
      const log = readFileSync(join(p.dir, "logs", "backup.log"), "utf8");
      expect(log).toMatch(/circular foreign-key/);
      expect(r.tudo).toMatch(/logs[\\/]backup\.log/);
    });

    it("B8: um erro de verdade do pg_dump continua na tela", () => {
      const p = criarProjeto();
      const r = executar(p, sistema, "backup", { env: { FAKE_DOCKER_FALHA_PGDUMP: "1" } });
      expect(r.status).not.toBe(0);
      expect(r.tudo).toContain("erro falso do dump");
    });

    it("pg_dump morto sem mensagem (137) diz o código na tela", () => {
      const p = criarProjeto();
      const r = executar(p, sistema, "backup", { env: { FAKE_DOCKER_FALHA_PGDUMP: "muda" } });
      expect(r.status).not.toBe(0);
      expect(r.tudo).toContain("137");
      expect(r.tudo).toMatch(/sem nenhuma mensagem/);
      expect(backupsDe(p)).toEqual([]);
    });

    it("log grande é girado (guarda os 3 anteriores) e o novo começa pequeno", () => {
      const p = criarProjeto();
      mkdirSync(join(p.dir, "logs"), { recursive: true });
      writeFileSync(join(p.dir, "logs", "backup.log"), "x".repeat(300 * 1024));
      for (const n of [1, 2, 3]) writeFileSync(join(p.dir, "logs", `backup.log.${n}`), `antigo ${n}`);
      const r = executar(p, sistema, "backup");
      expect(r.status, r.tudo).toBe(0);
      expect(readFileSync(join(p.dir, "logs", "backup.log.1"), "utf8").length).toBe(300 * 1024);
      expect(readFileSync(join(p.dir, "logs", "backup.log.2"), "utf8")).toBe("antigo 1");
      expect(readFileSync(join(p.dir, "logs", "backup.log.3"), "utf8")).toBe("antigo 2");
      expect(existsSync(join(p.dir, "logs", "backup.log.4"))).toBe(false);
      const novo = readFileSync(join(p.dir, "logs", "backup.log"), "utf8");
      expect(novo.length).toBeLessThan(20 * 1024);
      expect(novo).toMatch(/circular foreign-key/);
    });
  });

  describe.skipIf(!disponivel)(`${sistema}: restaurar executado`, () => {
    const prepararDoisBackups = (p: Projeto) => {
      plantarBackup(p, "2026-02-01-0900", "-- dados do backup A\nCOPY public.a FROM stdin;\n");
      plantarBackup(p, "2026-02-02-0900", "-- dados do backup B\nCOPY public.b FROM stdin;\n");
    };
    // Só o que MUDA alguma coisa: a consulta de versão (psql -At -c select) é leitura e pode acontecer antes.
    const mexeuEmAlgo = (p: Projeto) =>
      chamadas(p).filter((c) => /pg_dump|psql.*\s-f\s|compose.* stop|compose.* start|^cp .*:\//.test(c) || / rm -rf /.test(c));
    const religou = (p: Projeto) => chamadas(p).filter((x) => /compose .*\bstart\b/.test(x));

    it("lista os backups, exige RESTAURAR, faz o backup do estado atual ANTES, restaura e diz como voltar", () => {
      const p = criarProjeto();
      prepararDoisBackups(p);
      // 1 = o mais novo (B)
      const r = executar(p, sistema, "restaurar", { stdin: "1\nRESTAURAR\n" });
      expect(r.status, r.tudo).toBe(0);
      expect(r.saida).toContain("2026-02-01-0900");
      expect(r.saida).toContain("2026-02-02-0900");
      expect(r.saida).toContain("RESTAURAR");

      const c = chamadas(p);
      const iDump = c.findIndex((x) => x.includes("pg_dump"));
      const iPsql = c.findIndex((x) => /exec supabase_db_crm-alquimia psql .*--single-transaction/.test(x));
      expect(iDump, "backup do estado atual").toBeGreaterThanOrEqual(0);
      expect(iPsql, "restauração do banco").toBeGreaterThan(iDump);
      expect(c[iPsql]).toContain("--single-transaction");
      expect(c[iPsql]).toContain("ON_ERROR_STOP=1");
      // Só o supabase_admin é dono das sequências de auth.* (como postgres, o TRUNCATE falha)
      expect(c[iPsql]).toContain("psql -U supabase_admin");

      // o que foi para o banco é o dump B (e o prelúdio que esvazia as tabelas antes)
      const enviados = lerLog(p).filter((x) => x.argv[0] === "cp" && x.conteudo !== undefined);
      expect(enviados.some((x) => x.conteudo!.includes("dados do backup B"))).toBe(true);
      expect(enviados.some((x) => /TRUNCATE/i.test(x.conteudo!) && /replica/i.test(x.conteudo!))).toBe(true);
      expect(enviados.some((x) => x.conteudo!.includes("dados do backup A"))).toBe(false);

      // os arquivos (Storage) do backup B voltam para o contêiner do Storage
      const iCpStorage = c.findIndex((x) => /^cp .* supabase_storage_crm-alquimia:\/mnt\/?$/.test(x));
      expect(iCpStorage, "restauração do Storage").toBeGreaterThan(iPsql);
      expect(c[iCpStorage]).toContain("2026-02-02-0900-storage");

      // para o app/worker/agendador durante; no fim sobe SÓ o app: a fila voltou ao momento do backup,
      // e religar worker e agendador sozinho poderia mandar de novo mensagens e follow-ups já enviados
      const iStop = c.findIndex((x) => /compose .*stop app worker scheduler/.test(x));
      const iStart = c.findIndex((x) => /compose .*start app$/.test(x));
      expect(iStop).toBeGreaterThanOrEqual(0);
      expect(iStop).toBeLessThan(iDump);
      expect(iStart).toBeGreaterThan(iCpStorage);
      expect(religou(p).filter((x) => /worker|scheduler/.test(x))).toEqual([]);
      expect(r.saida).toContain("docker compose -p crm-alquimia --env-file .env.local start worker scheduler");
      expect(r.saida).toMatch(/PARADOS/);
      expect(r.saida).toMatch(/de novo|em dobro/i);

      // o backup pré-restauração existe (3 agora) e a mensagem final o cita
      const lista = backupsDe(p);
      expect(lista).toHaveLength(3);
      const novo = lista.find((n) => !n.startsWith("2026-02-0"))!;
      expect(novo).toMatch(PADRAO_NOME);
      expect(r.saida).toContain(novo);
      expect(r.saida).toMatch(/restaurar/i);
    });

    it("escolher pelo nome do backup (argumento) pula a pergunta de qual", () => {
      const p = criarProjeto();
      prepararDoisBackups(p);
      const r = executar(p, sistema, "restaurar", { stdin: "RESTAURAR\n", args: ["2026-02-01-0900"] });
      expect(r.status, r.tudo).toBe(0);
      const enviados = lerLog(p).filter((x) => x.argv[0] === "cp" && x.conteudo !== undefined);
      expect(enviados.some((x) => x.conteudo!.includes("dados do backup A"))).toBe(true);
    });

    it.each([["restaurar"], ["Restaurar"], ["sim"], ["s"], ["RESTAURAR já"], [" RESTAURAR"], [""]])(
      "digitar %j em vez de RESTAURAR aborta sem mexer em nada",
      (resposta) => {
        const p = criarProjeto();
        prepararDoisBackups(p);
        const r = executar(p, sistema, "restaurar", { stdin: `1\n${resposta}\n` });
        expect(r.status).not.toBe(0);
        expect(r.tudo).toMatch(/cancelad|abortad/i);
        expect(mexeuEmAlgo(p)).toEqual([]);
        expect(backupsDe(p)).toHaveLength(2);
      },
    );

    it("sem resposta nenhuma (entrada vazia) aborta sem mexer em nada", () => {
      const p = criarProjeto();
      prepararDoisBackups(p);
      const r = executar(p, sistema, "restaurar", { stdin: "" });
      expect(r.status).not.toBe(0);
      expect(mexeuEmAlgo(p)).toEqual([]);
    });

    it("número de backup que não existe aborta sem mexer em nada", () => {
      const p = criarProjeto();
      prepararDoisBackups(p);
      const r = executar(p, sistema, "restaurar", { stdin: "9\nRESTAURAR\n" });
      expect(r.status).not.toBe(0);
      expect(mexeuEmAlgo(p)).toEqual([]);
    });

    it("sem nenhum backup: mensagem e código ≠ 0", () => {
      const p = criarProjeto();
      const r = executar(p, sistema, "restaurar", { stdin: "1\nRESTAURAR\n" });
      expect(r.status).not.toBe(0);
      expect(r.tudo).toMatch(/backup/i);
      expect(mexeuEmAlgo(p)).toEqual([]);
    });

    it("Docker parado: erro explicativo, código ≠ 0 e nada é tocado", () => {
      const p = criarProjeto();
      prepararDoisBackups(p);
      const r = executar(p, sistema, "restaurar", { stdin: "1\nRESTAURAR\n", env: { FAKE_DOCKER_PARADO: "1" } });
      expect(r.status).not.toBe(0);
      expect(r.tudo).toMatch(/Docker Desktop/);
      expect(mexeuEmAlgo(p)).toEqual([]);
    });

    it("arquivo de backup corrompido: recusa ANTES de qualquer coisa (nem o backup do estado atual)", () => {
      const p = criarProjeto();
      mkdirSync(join(p.dir, "backups"), { recursive: true });
      writeFileSync(join(p.dir, "backups", "2026-02-01-0900.sql.gz"), "isto não é um gzip");
      const r = executar(p, sistema, "restaurar", { stdin: "1\nRESTAURAR\n" });
      expect(r.status).not.toBe(0);
      expect(r.tudo).toMatch(/corromp|inválid|invalid/i);
      expect(mexeuEmAlgo(p)).toEqual([]);
    });

    it("o backup pré-restauração NÃO apaga o que o usuário quer restaurar (sem retenção na restauração)", () => {
      const p = criarProjeto();
      for (let i = 1; i <= 14; i++) plantarBackup(p, `2026-01-${sufixoDeVinte(i)}-0900`, `-- dados do dia ${i}\n`);
      // restaura o MAIS VELHO (o 14º da lista, do mais novo ao mais velho)
      const r = executar(p, sistema, "restaurar", { stdin: "RESTAURAR\n", args: ["2026-01-01-0900"] });
      expect(r.status, r.tudo).toBe(0);
      expect(backupsDe(p)).toHaveLength(15);
      expect(existsSync(join(p.dir, "backups", "2026-01-01-0900.sql.gz"))).toBe(true);
    });

    it("falha na restauração do banco: avisa que o banco não mudou, indica o backup de antes e religa os serviços", () => {
      const p = criarProjeto();
      prepararDoisBackups(p);
      const r = executar(p, sistema, "restaurar", { stdin: "1\nRESTAURAR\n", env: { FAKE_DOCKER_FALHA_PSQL: "1" } });
      expect(r.status).not.toBe(0);
      const c = chamadas(p);
      const iStart = c.findIndex((x) => /compose .*start app worker scheduler/.test(x));
      expect(iStart, "os serviços voltam mesmo com erro").toBeGreaterThanOrEqual(0);
      // o Storage não foi tocado
      expect(c.some((x) => /^cp .* supabase_storage_crm-alquimia:\/mnt\/?$/.test(x))).toBe(false);
      expect(backupsDe(p)).toHaveLength(3);
    });

    it("os NOTICE e WARNING da carga vão para logs/restaurar.log; na tela fica o resumo", () => {
      const p = criarProjeto();
      prepararDoisBackups(p);
      const r = executar(p, sistema, "restaurar", { stdin: "1\nRESTAURAR\n" });
      expect(r.status, r.tudo).toBe(0);
      expect(r.tudo).not.toMatch(/truncate cascades|low recall|circular foreign-key/);
      const log = readFileSync(join(p.dir, "logs", "restaurar.log"), "utf8");
      expect(log).toMatch(/truncate cascades/);
      expect(log).toMatch(/low recall/);
      expect(r.tudo).toMatch(/logs[\\/]restaurar\.log/);
    });

    it("B8: o erro de verdade da carga continua na tela (e o ruído não)", () => {
      const p = criarProjeto();
      prepararDoisBackups(p);
      const r = executar(p, sistema, "restaurar", { stdin: "1\nRESTAURAR\n", env: { FAKE_DOCKER_FALHA_PSQL: "1" } });
      expect(r.status).not.toBe(0);
      expect(r.tudo).toContain("erro falso da carga");
      expect(r.tudo).not.toMatch(/circular foreign-key/);
    });

    it("falha fora do formato do Postgres (OCI runtime) aparece na tela, com o código", () => {
      const p = criarProjeto();
      prepararDoisBackups(p);
      const r = executar(p, sistema, "restaurar", { stdin: "1\nRESTAURAR\n", env: { FAKE_DOCKER_FALHA_CARGA: "sem-rotulo" } });
      expect(r.status).not.toBe(0);
      expect(r.tudo).toContain("OCI runtime exec failed");
      expect(r.tudo).toContain("126");
    });

    it("falha muda (código 137, nada escrito) diz o código e que não houve mensagem", () => {
      const p = criarProjeto();
      prepararDoisBackups(p);
      const r = executar(p, sistema, "restaurar", { stdin: "1\nRESTAURAR\n", env: { FAKE_DOCKER_FALHA_CARGA: "muda" } });
      expect(r.status).not.toBe(0);
      expect(r.tudo).toContain("137");
      expect(r.tudo).toMatch(/sem nenhuma mensagem/);
      expect(r.tudo).toMatch(/mem.ria/);
    });

    it("o dado da linha (Key/Failing row) não fica no log; o erro continua na tela", () => {
      const p = criarProjeto();
      prepararDoisBackups(p);
      const r = executar(p, sistema, "restaurar", { stdin: "1\nRESTAURAR\n", env: { FAKE_DOCKER_FALHA_CARGA: "dado" } });
      expect(r.status).not.toBe(0);
      expect(r.tudo).toContain("duplicate key value");
      const log = readFileSync(join(p.dir, "logs", "restaurar.log"), "utf8");
      expect(log).toContain("duplicate key value");
      expect(log).not.toContain("fulana.secreta@exemplo.test");
      expect(log).not.toContain("Fulana Secreta");
      expect(log).toMatch(/Key \(email\)=\(omitido\)/);
    });

    it("chave de expressão, CONTEXT do COPY e valor inválido também saem mascarados do log", () => {
      const p = criarProjeto();
      prepararDoisBackups(p);
      const r = executar(p, sistema, "restaurar", { stdin: "1\nRESTAURAR\n", env: { FAKE_DOCKER_FALHA_CARGA: "dado-formatos" } });
      expect(r.status).not.toBe(0);
      expect(r.tudo).toContain("duplicate key value");
      const log = readFileSync(join(p.dir, "logs", "restaurar.log"), "utf8");
      for (const dado of ["beltrana.oculta@exemplo.test", "Beltrana Oculta", "+5500987650000", "Ciclano Escondido"]) {
        expect(log, dado).not.toContain(dado);
      }
      // ficam a coluna, a tabela, a linha e a causa
      expect(log).toContain("Key (lower(email::text))=(omitido) already exists");
      expect(log).toContain("COPY contacts, line 3: (omitido)");
      expect(log).toContain("COPY crm_leads, line 7, column valor_cents: (omitido)");
      expect(log).toContain('invalid input syntax for type integer: "(omitido)"');
    });

    it("data e número fora da faixa, Token e JSON data também saem mascarados do log", () => {
      const p = criarProjeto();
      prepararDoisBackups(p);
      const r = executar(p, sistema, "restaurar", { stdin: "1\nRESTAURAR\n", env: { FAKE_DOCKER_FALHA_CARGA: "dado-formatos-r4" } });
      expect(r.status).not.toBe(0);
      const log = readFileSync(join(p.dir, "logs", "restaurar.log"), "utf8");
      for (const dado of ["2020-13-45", "3000000000", "Fulana"]) expect(log, dado).not.toContain(dado);
      expect(log).toContain('date/time field value out of range: "(omitido)"');
      expect(log).toContain('value "(omitido)" is out of range for type integer');
      expect(log).toContain('Token "(omitido)" is invalid');
      expect(log).toContain("JSON data, line 1: (omitido)");
    });

    // O lembrete do .env.local de outra instalação segue a CHAVE de cifra, não a pasta.
    const K1 = "a1".repeat(32);
    const K2 = "b2".repeat(32);
    const comChave = (p: Projeto, chave: string | null) => {
      const env = readFileSync(join(p.dir, ".env.local"), "utf8").replace(/^NUVEMSHOP_OAUTH_ENCRYPTION_KEY=.*\n/m, "");
      writeFileSync(join(p.dir, ".env.local"), env + (chave ? `NUVEMSHOP_OAUTH_ENCRYPTION_KEY=${chave}\n` : ""));
    };
    const fazerBackup = (p: Projeto, chave: string) => {
      comChave(p, chave);
      expect(executar(p, sistema, "backup", { env: { FAKE_DOCKER_CHAVE: chave } }).status).toBe(0);
      const nome = backupsDe(p)[0]!.replace(/\.sql\.gz$/, "");
      const versao = readFileSync(join(p.dir, "backups", `${nome}-versao.txt`), "utf8");
      expect(versao).toMatch(/^chave=[0-9a-f]{12}$/m);
      expect(versao, "a chave nunca vai em claro").not.toContain(chave);
      return nome;
    };
    const lembrete = /OUTRA instala/i;

    it("mesma instalação (mesma chave no banco e no .env.local): sem lembrete, e a chave não vai a argv nem à tela", () => {
      const p = criarProjeto();
      const nome = fazerBackup(p, K1);
      const r = executar(p, sistema, "restaurar", { stdin: "RESTAURAR\n", args: [nome], env: { FAKE_DOCKER_CHAVE: K1 } });
      expect(r.status, r.tudo).toBe(0);
      expect(r.saida).not.toMatch(lembrete);
      expect(`${chamadas(p).join("\n")}\n${r.tudo}`).not.toContain(K1);
    });

    it("migração para outra máquina no MESMO caminho, sem copiar o .env.local (banco e .env.local novos, chave nova): lembrete", () => {
      const p = criarProjeto();
      const nome = fazerBackup(p, K1);
      comChave(p, K2);
      const r = executar(p, sistema, "restaurar", { stdin: "RESTAURAR\n", args: [nome], env: { FAKE_DOCKER_CHAVE: K2 } });
      expect(r.status, r.tudo).toBe(0);
      expect(r.saida).toMatch(lembrete);
    });

    it("recomeçar do zero na mesma pasta (banco novo com outra chave, .env.local sem chave): lembrete", () => {
      const p = criarProjeto();
      const nome = fazerBackup(p, K1);
      comChave(p, null);
      const r = executar(p, sistema, "restaurar", { stdin: "RESTAURAR\n", args: [nome], env: { FAKE_DOCKER_CHAVE: K2 } });
      expect(r.status, r.tudo).toBe(0);
      expect(r.saida).toMatch(lembrete);
    });

    it("backup antigo, sem a impressão da chave: lembrete (mesmo com a chave igual nos dois lados)", () => {
      const p = criarProjeto();
      comChave(p, K1);
      plantarBackup(p, "2026-02-01-0900");
      const r = executar(p, sistema, "restaurar", { stdin: "RESTAURAR\n", args: ["2026-02-01-0900"], env: { FAKE_DOCKER_CHAVE: K1 } });
      expect(r.status, r.tudo).toBe(0);
      expect(r.saida).toMatch(lembrete);
    });

    it("a chave entre aspas e com espaços no .env.local é a mesma do banco: sem lembrete", () => {
      const p = criarProjeto();
      const nome = fazerBackup(p, K1);
      const env = readFileSync(join(p.dir, ".env.local"), "utf8").replace(/^NUVEMSHOP_OAUTH_ENCRYPTION_KEY=.*\n/m, "");
      writeFileSync(join(p.dir, ".env.local"), env + `NUVEMSHOP_OAUTH_ENCRYPTION_KEY= "${K1}" \n`);
      const r = executar(p, sistema, "restaurar", { stdin: "RESTAURAR\n", args: [nome], env: { FAKE_DOCKER_CHAVE: K1 } });
      expect(r.status, r.tudo).toBe(0);
      expect(r.saida).not.toMatch(lembrete);
      expect(r.tudo).not.toMatch(/chave de cifra do .env.local .* diferente/);
    });

    it("depois de restaurar, lembra de conferir webhooks e integrações se o backup veio de outra instalação", () => {
      const p = criarProjeto();
      prepararDoisBackups(p);
      const r = executar(p, sistema, "restaurar", { stdin: "1\nRESTAURAR\n" });
      expect(r.status, r.tudo).toBe(0);
      // o PowerShell 5.1 escreve na página de código do console: acentos podem chegar trocados
      const i = r.saida.search(/Restaura.{1,4}o conclu/);
      expect(i, r.saida).toBeGreaterThanOrEqual(0);
      const depois = r.saida.slice(i);
      expect(depois).toMatch(/outra instala.{1,4}o/i);
      expect(depois).toContain(".env.local");
      expect(depois).toMatch(/webhook/i);
    });

    it("banco restaurado mas Storage falhou (código 2): diz como desfazer, sobe SÓ o app e deixa worker e agendador parados", () => {
      const p = criarProjeto();
      prepararDoisBackups(p);
      const r = executar(p, sistema, "restaurar", { stdin: "1\nRESTAURAR\n", env: { FAKE_DOCKER_FALHA_CP_PARA_STORAGE: "1" } });
      expect(r.status).not.toBe(0);
      expect(r.tudo).toMatch(/Storage/);
      const antes = backupsDe(p).find((n) => !n.startsWith("2026-02-0"))!.replace(/\.sql\.gz$/, "");
      expect(r.tudo).toContain(antes);
      expect(religou(p).some((x) => /start app$/.test(x))).toBe(true);
      expect(religou(p).filter((x) => /worker|scheduler/.test(x))).toEqual([]);
      expect(r.tudo).toContain("start worker scheduler");
    });

    it("o backup de segurança falha (pg_dump): a restauração NÃO roda e os três serviços voltam (nada mudou)", () => {
      const p = criarProjeto();
      prepararDoisBackups(p);
      const r = executar(p, sistema, "restaurar", { stdin: "1\nRESTAURAR\n", env: { FAKE_DOCKER_FALHA_PGDUMP: "1" } });
      expect(r.status).not.toBe(0);
      expect(chamadas(p).some((x) => /psql.*--single-transaction/.test(x))).toBe(false);
      expect(religou(p).some((x) => /start app worker scheduler/.test(x))).toBe(true);
      expect(r.tudo).toMatch(/não restauro|nada foi alterado/i);
    });

    it("sem .env.local: aborta com código ≠ 0 antes de mexer em qualquer coisa", () => {
      const p = criarProjeto();
      prepararDoisBackups(p);
      rmSync(join(p.dir, ".env.local"));
      const r = executar(p, sistema, "restaurar", { stdin: "1\nRESTAURAR\n" });
      expect(r.status).not.toBe(0);
      expect(r.tudo).toContain(".env.local");
      expect(mexeuEmAlgo(p)).toEqual([]);
      expect(backupsDe(p)).toHaveLength(2);
    });

    it("RESTAURAR sem quebra de linha no fim (fim da entrada logo depois) vale", () => {
      const p = criarProjeto();
      prepararDoisBackups(p);
      const r = executar(p, sistema, "restaurar", { stdin: "1\nRESTAURAR" });
      expect(r.status, r.tudo).toBe(0);
      expect(chamadas(p).some((x) => /psql.*--single-transaction/.test(x))).toBe(true);
    });

    it("backup de outra versão do schema (baseline diferente): recusa sem mexer em nada e explica o que fazer", () => {
      const p = criarProjeto();
      plantarBackup(p, "2026-02-01-0900", "-- A\n", { hash: "0".repeat(64) });
      const r = executar(p, sistema, "restaurar", { stdin: "1\nRESTAURAR\n" });
      expect(r.status).not.toBe(0);
      expect(r.tudo).toMatch(/outra vers.o/i);
      expect(r.tudo).toMatch(/instalar/);
      expect(mexeuEmAlgo(p)).toEqual([]);
    });

    it("backup de outra versão do CRM (current_version diferente): recusa sem mexer em nada", () => {
      const p = criarProjeto();
      plantarBackup(p, "2026-02-01-0900", "-- A\n", { atual: "1.3.0" });
      const r = executar(p, sistema, "restaurar", { stdin: "1\nRESTAURAR\n" });
      expect(r.status).not.toBe(0);
      expect(r.tudo).toContain("1.3.0");
      expect(r.tudo).toMatch(/outra vers.o/i);
      expect(mexeuEmAlgo(p)).toEqual([]);
    });

    it("versão instalada vazia num dos lados não bloqueia (só o schema decide)", () => {
      const p = criarProjeto();
      plantarBackup(p, "2026-02-01-0900", "-- A\n", { atual: "" });
      const r = executar(p, sistema, "restaurar", { stdin: "1\nRESTAURAR\n" });
      expect(r.status, r.tudo).toBe(0);
    });

    it("backup antigo, sem o registro de versão: recusa sem mexer em nada e explica", () => {
      const p = criarProjeto();
      plantarBackup(p, "2026-02-01-0900", "-- A\n", null);
      const r = executar(p, sistema, "restaurar", { stdin: "1\nRESTAURAR\n" });
      expect(r.status).not.toBe(0);
      expect(r.tudo).toMatch(/registro de vers.o/i);
      expect(mexeuEmAlgo(p)).toEqual([]);
    });

    it("nenhum segredo do .env.local vai no argv do docker nem na tela", () => {
      const p = criarProjeto();
      prepararDoisBackups(p);
      const r = executar(p, sistema, "restaurar", { stdin: "1\nRESTAURAR\n" });
      expect(r.status, r.tudo).toBe(0);
      const todo = `${chamadas(p).join("\n")}\n${r.tudo}`;
      for (const segredo of ["chave-de-servico-secreta-111", "senha-do-banco-222", "segredo-interno-333"]) {
        expect(todo).not.toContain(segredo);
      }
    });
  });
}

const SEM_OUTROS = /Everyone|BUILTIN\\Users|Authenticated Users|Todos|Usu.rios/i;

/** Os titulares de cada ACE de um caminho, pelo icacls (o que vem antes de ":(" em cada linha). */
function titularesDaAcl(caminho: string): string[] {
  const saida = spawnSync("icacls", [caminho], { encoding: "utf8" }).stdout;
  return saida
    .split(/\r?\n/)
    .map((l, i) => (i === 0 ? l.slice(caminho.length) : l).trim())
    .map((l) => /^(.*?):\(/.exec(l)?.[1])
    .filter((t): t is string => !!t)
    .map((t) => t.toLowerCase());
}

for (const [sistema, disponivel] of sistemas) {
  describe.skipIf(!disponivel || !ehWindows)(`${sistema}: logs/ só do dono mesmo se já existia aberta`, () => {
    it("logs/ pré-existente com Users e um log girado antigo: depois do backup, só o dono aparece na ACL (herdado de outro não vale)", () => {
      const p = criarProjeto();
      const logs = join(p.dir, "logs");
      mkdirSync(logs);
      writeFileSync(join(logs, "backup.log.1"), "log antigo da rodada 1\n");
      writeFileSync(join(logs, "backup.log"), "log atual\n");
      // aberta para o grupo Users (SID, para não depender do idioma do Windows), herdável
      expect(spawnSync("icacls", [logs, "/grant", "*S-1-5-32-545:(OI)(CI)(R)"], { encoding: "utf8" }).status).toBe(0);
      expect(titularesDaAcl(logs).length, "a pasta do teste tem ACEs de outros antes").toBeGreaterThan(1);
      const r = executar(p, sistema, "backup");
      expect(r.status, r.tudo).toBe(0);
      const dono = `${process.env.USERDOMAIN ?? ""}\\${process.env.USERNAME ?? ""}`.toLowerCase();
      for (const alvo of [logs, join(logs, "backup.log"), join(logs, "backup.log.1")]) {
        const titulares = titularesDaAcl(alvo);
        expect(titulares.length, alvo).toBeGreaterThan(0);
        expect(titulares, alvo).toEqual(titulares.map(() => dono));
      }
    });
  });
}

describe.skipIf(!temBash)("bash: permissão só do dono", () => {
  // Em Linux/Mac vale o modo POSIX. No Git Bash do Windows o modo que o bash mostra NÃO é a permissão
  // real (o NTFS manda): lá a prova é a ACL, lida pelo icacls.
  it("a pasta backups/ e tudo dentro (.sql.gz e arquivos copiados do Storage, mesmo com o docker cp criando 644) só são acessíveis ao dono", () => {
    const p = criarProjeto();
    const r = executar(p, "bash", "backup");
    expect(r.status, r.tudo).toBe(0);
    const stem = backupsDe(p)[0]!.replace(/.sql.gz$/, "");
    if (ehWindows) {
      for (const alvo of ["backups", `backups/${stem}.sql.gz`, `backups/${stem}-storage/bucket-falso/arquivo.txt`, "logs", "logs/backup.log"]) {
        const acl = spawnSync("icacls", [join(p.dir, alvo)], { encoding: "utf8" }).stdout;
        expect(acl, alvo).not.toMatch(SEM_OUTROS);
        expect(acl, alvo).not.toMatch(/SISTEMA|Administrad|Administrators/i);
        expect(acl, alvo).toMatch(/(F)/);
      }
      return;
    }
    const modo = (rel: string) =>
      spawnSync("bash", ["-c", `stat -c %a "${rel}"`], { cwd: p.dir, encoding: "utf8" }).stdout.trim();
    expect(modo("backups")).toBe("700");
    expect(modo(`backups/${stem}.sql.gz`)).toBe("600");
    expect(modo(`backups/${stem}-storage`)).toBe("700");
    expect(modo(`backups/${stem}-storage/bucket-falso`)).toBe("700");
    expect(modo(`backups/${stem}-storage/bucket-falso/arquivo.txt`)).toBe("600");
    // O log dos avisos do Postgres também é só do dono
    expect(modo("logs")).toBe("700");
    expect(modo("logs/backup.log")).toBe("600");
  });
});

describe.skipIf(!temPowerShell)("PowerShell: só o dono acessa os backups (ACL)", () => {
  it("backups/ e o .sql.gz não dão acesso a Everyone, Users nem Authenticated Users", () => {
    const p = criarProjeto();
    const r = executar(p, "ps1", "backup");
    expect(r.status, r.tudo).toBe(0);
    const stem = backupsDe(p)[0]!.replace(/\.sql\.gz$/, "");
    // Logs\ e o log também só do dono
    for (const alvo of ["backups", `backups\\${stem}.sql.gz`, `backups\\${stem}-storage\\bucket-falso\\arquivo.txt`, "logs", "logs\\backup.log"]) {
      const acl = spawnSync("icacls", [join(p.dir, alvo)], { encoding: "utf8" }).stdout;
      expect(acl, alvo).not.toMatch(/Everyone|BUILTIN\\Users|Authenticated Users|Todos|Usu.rios/i);
      expect(acl, alvo).toMatch(/\(F\)|\(OI\)\(CI\)\(F\)|\(I\)/);
    }
  });
});

describe.skipIf(!temBash)("bash: restringir_ao_dono no Git Bash do Windows (chmod não muda a ACL do NTFS)", () => {
  function comFakes(unameSaida: string) {
    const p = criarProjeto();
    const bin = join(p.dir, "_fakes");
    mkdirSync(bin);
    const log = join(p.dir, "fakes.log").replace(/\\/g, "/");
    const fake = (nome: string, corpo: string) => {
      writeFileSync(join(bin, nome), `#!/usr/bin/env bash\n${corpo}\n`);
      chmodSync(join(bin, nome), 0o755);
    };
    fake("uname", `echo "${unameSaida}"`);
    fake("icacls", `printf 'icacls %s\\n' "$*" >> "${log}"; exit 0`);
    fake("cygpath", `printf '%s\\n' "$2"`);
    return { p, bin: bin.replace(/\\/g, "/"), log };
  }
  const roda = (c: ReturnType<typeof comFakes>, corpo: string) =>
    spawnSync(
      "bash",
      [
        "-c",
        `set -euo pipefail\numask 077\nBINU="$(cygpath -u "$BIN" 2>/dev/null || printf %s "$BIN")"\nexport PATH="$BINU:$PATH"\nsource scripts/lib/instalar-env.sh\n${corpo}`,
      ],
      { cwd: c.p.dir, encoding: "utf8", env: { ...ambiente(c.p, "bash"), BIN: c.bin, USERNAME: "dono", USERDOMAIN: "PC" } },
    );

  it("em MINGW/MSYS chama icacls (sem herança, só o dono) além do chmod 600", () => {
    const c = comFakes("MINGW64_NT-10.0-26200");
    const r = roda(c, `: > .env.local\nrestringir_ao_dono .env.local\nstat -c %a .env.local`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe("600");
    const log = readFileSync(c.log, "utf8");
    expect(log).toContain("/inheritance:r");
    expect(log).toContain("/grant:r");
    expect(log).toContain("PC\\dono");
    expect(log).toContain(".env.local");
    // O dono também pode APAGAR o arquivo (leitura, escrita e apagar; ninguém mais)
    expect(log).toContain("PC\\dono:(R,W,D)");
    // ACEs EXPLÍCITAS que já existiam (ex.: Everyone dado à mão) não sobrevivem: /reset antes
    const linhas = log.trim().split("\n");
    expect(linhas[0]).toContain("/reset");
    expect(linhas[1]).toContain("/inheritance:r");
  });

  it("em MINGW/MSYS, restringir_pasta_ao_dono dá controle total herdável (OI)(CI) só ao dono", () => {
    const c = comFakes("MSYS_NT-10.0");
    const r = roda(c, `mkdir backups\nrestringir_pasta_ao_dono backups`);
    expect(r.status, r.stderr).toBe(0);
    const log = readFileSync(c.log, "utf8");
    expect(log).toContain("/inheritance:r");
    expect(log).toContain("(OI)(CI)");
  });

  it("se o icacls falhar, avisa com clareza (e o arquivo continua com chmod 600)", () => {
    const c = comFakes("MINGW64_NT-10.0");
    writeFileSync(join(c.bin, "icacls"), "#!/usr/bin/env bash\nexit 5\n");
    const r = roda(c, `: > .env.local\nrestringir_ao_dono .env.local\nstat -c %a .env.local`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe("600");
    expect(r.stderr).toMatch(/AVISO/);
    expect(r.stderr).toMatch(/icacls|permiss/i);
  });

  it("em Linux/Mac não chama icacls", () => {
    const c = comFakes("Linux");
    const r = roda(c, `: > .env.local\nrestringir_ao_dono .env.local\nstat -c %a .env.local`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe("600");
    expect(existsSync(c.log)).toBe(false);
  });
});

describe.skipIf(!temPowerShell)("PowerShell: o dono consegue apagar o .env.local protegido", () => {
  it("numa pasta sem 'apagar filhos' (como C:\\crm-teste), o arquivo restrito ao dono ainda pode ser apagado por ele, e só ele o acessa", () => {
    const p = criarProjeto();
    const harness = join(p.dir, "harness-b5.ps1");
    writeFileSync(
      harness,
      `\uFEFF$ErrorActionPreference = "Stop"
. "${join(p.dir, "scripts", "lib", "instalar-env.ps1")}"
$u = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$d = Join-Path $PWD "pasta-sem-apagar"
New-Item -ItemType Directory $d | Out-Null
# a pasta dá ao usuário "modificar" (sem o 'apagar filhos' do controle total), como uma pasta criada em C:\\
icacls $d /inheritance:r /grant:r ($u + ":(OI)(CI)M") | Out-Null
try {
    $e = Join-Path $d ".env.local"
    [System.IO.File]::WriteAllText($e, "SEGREDO=x")
    Restringir-ArquivoAoDono $e
    (icacls $e) -join " " | Write-Output
    try { Remove-Item -LiteralPath $e -Force -ErrorAction Stop; Write-Output "APAGOU" } catch { Write-Output "NAO-APAGOU" }
} finally {
    icacls $d /grant ($u + ":(OI)(CI)F") /T | Out-Null
}
`,
      "utf8",
    );
    const r = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", harness], {
      cwd: p.dir,
      encoding: "utf8",
      env: ambiente(p, "ps1"),
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout, r.stdout).toContain("APAGOU");
    expect(r.stdout).not.toContain("NAO-APAGOU");
    expect(r.stdout).not.toMatch(/Everyone|BUILTIN\\Users|Authenticated Users|Todos|Usu.rios/i);
  });
});

describe.skipIf(!temPowerShell)("PowerShell: Restringir-ArquivoAoDono avisa quando o icacls falha", () => {
  it("icacls com código de saída ≠ 0 escreve um AVISO explícito (e não derruba o script)", () => {
    const p = criarProjeto();
    const bin = join(p.dir, "_fakes");
    mkdirSync(bin);
    writeFileSync(join(bin, "icacls.cmd"), "@echo off\r\nexit /b 5\r\n");
    const harness = join(p.dir, "harness.ps1");
    writeFileSync(
      harness,
      `﻿$ErrorActionPreference = "Stop"\n. "${join(p.dir, "scripts", "lib", "instalar-env.ps1")}"\n$e = Join-Path $PWD ".env.local"\nRestringir-ArquivoAoDono $e\nWrite-Output "seguiu"\n`,
      "utf8",
    );
    const r = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", harness], {
      cwd: p.dir,
      encoding: "utf8",
      env: { ...ambiente(p, "ps1"), PATH: `${bin}${delimiter}${process.env.PATH ?? process.env.Path ?? ""}` },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("AVISO");
    expect(r.stdout).toContain("seguiu");
  });
});

/** Um `mv` falso (bash) que falha ao pôr o .sql.gz no lugar final; o resto vai para o mv de verdade. */
function comMvQueFalha(p: Projeto) {
  const bin = join(p.dir, "_mv");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "mv"),
    '#!/usr/bin/env bash\ncase "$*" in *.sql.gz*) echo "mv: falha falsa" >&2; exit 1 ;; esac\nfor m in /usr/bin/mv /bin/mv; do [ -x "$m" ] && exec "$m" "$@"; done\nexit 127\n',
  );
  chmodSync(join(bin, "mv"), 0o755);
  return { PATH: `${bin}${delimiter}${p.binBash}${delimiter}${process.env.PATH ?? process.env.Path ?? ""}` };
}

describe.skipIf(!temBash)("bash: backup só é dado como pronto se existir de verdade", () => {
  it("mv do .sql.gz falha: código ≠ 0, nenhum backup e nenhuma sobra (nem a pasta de arquivos já movida)", () => {
    const p = criarProjeto();
    const r = executar(p, "bash", "backup", { env: comMvQueFalha(p) });
    expect(r.status).not.toBe(0);
    expect(r.tudo).toMatch(/Nenhum backup foi criado/);
    expect(r.saida).not.toMatch(/Backup pronto/);
    expect(readdirSync(join(p.dir, "backups"))).toEqual([]);
  });

  it("na restauração, se o backup de segurança não fica pronto (mv falha), nada é restaurado e os serviços voltam", () => {
    const p = criarProjeto();
    plantarBackup(p, "2026-02-01-0900", "-- A\n");
    const r = executar(p, "bash", "restaurar", { stdin: "1\nRESTAURAR\n", env: comMvQueFalha(p) });
    expect(r.status).not.toBe(0);
    expect(chamadas(p).some((x) => /psql.*--single-transaction/.test(x))).toBe(false);
    expect(chamadas(p).some((x) => /compose .*start app worker scheduler/.test(x))).toBe(true);
    expect(backupsDe(p)).toEqual(["2026-02-01-0900.sql.gz"]);
  });
});

describe.skipIf(!temPowerShell)("PowerShell: backup só é dado como pronto se existir de verdade", () => {
  it("Move-Item do .sql.gz falha: Criar-Backup devolve falso, sem nome e sem sobras", () => {
    const p = criarProjeto();
    const harness = join(p.dir, "harness-mv.ps1");
    writeFileSync(
      harness,
      `﻿$ErrorActionPreference = "Continue"
Set-StrictMode -Version 2.0
. "${join(p.dir, "scripts", "lib", "backup.ps1")}"
function Move-Item {
    param([string]$LiteralPath, [string]$Destination)
    if ($Destination -like "*.sql.gz") { throw "falha falsa do Move-Item" }
    Microsoft.PowerShell.Management\Move-Item -LiteralPath $LiteralPath -Destination $Destination -ErrorAction Stop
}
$ok = Criar-Backup (Join-Path $PWD "backups") $PWD.Path
Write-Output ("resultado=" + $ok + " criado=[" + $script:BackupCriado + "]")
`,
      "utf8",
    );
    const r = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", harness], {
      cwd: p.dir,
      encoding: "utf8",
      env: ambiente(p, "ps1"),
    });
    expect(r.stdout, r.stderr).toContain("resultado=False criado=[]");
    expect(readdirSync(join(p.dir, "backups"))).toEqual([]);
  });
});

describe.skipIf(!temBash || !ehWindows)("bash no Windows: pasta de backups absoluta (CRM_ALQUIMIA_BACKUP_DIR)", () => {
  it("caminho /c/... do Git Bash é convertido antes de ir ao docker.exe", () => {
    const p = criarProjeto();
    const fora = mkdtempSync(join(tmpdir(), "crm-bk-fora-"));
    pastas.push(fora);
    const posix = spawnSync("bash", ["-c", 'cygpath -u "$1"', "_", fora], { encoding: "utf8" }).stdout.trim();
    expect(posix).toMatch(/^\//);
    const r = executar(p, "bash", "backup", { env: { CRM_ALQUIMIA_BACKUP_DIR: posix } });
    expect(r.status, r.tudo).toBe(0);
    const lista = readdirSync(fora).filter((n) => n.endsWith(".sql.gz"));
    expect(lista).toHaveLength(1);
    expect(gunzipSync(readFileSync(join(fora, lista[0]!))).toString("utf8")).toContain("dump falso do banco");
  });
});

for (const [sistema, disponivel] of [
  ["bash", temBash && ehWindows],
  ["ps1", temPowerShell],
] as Array<[Sistema, boolean]>) {
  describe.skipIf(!disponivel)(`${sistema}: ACE explícita que já existia na pasta backups/ é removida`, () => {
    it("Everyone dado à mão antes do backup não sobrevive (na ACL real, via icacls)", () => {
      const p = criarProjeto();
      const bk = join(p.dir, "backups");
      mkdirSync(bk);
      const g = spawnSync("icacls", [bk, "/grant", "*S-1-1-0:(OI)(CI)(R)"], { encoding: "utf8" });
      expect(g.status, g.stdout + g.stderr).toBe(0);
      expect(spawnSync("icacls", [bk], { encoding: "utf8" }).stdout).toMatch(SEM_OUTROS);
      const r = executar(p, sistema, "backup");
      expect(r.status, r.tudo).toBe(0);
      const stem = backupsDe(p)[0]!.replace(/\.sql\.gz$/, "");
      for (const alvo of [bk, join(bk, `${stem}.sql.gz`)]) {
        expect(spawnSync("icacls", [alvo], { encoding: "utf8" }).stdout, alvo).not.toMatch(SEM_OUTROS);
      }
    });
  });
}

// --- ao lado de outro sistema, e casos menores ------------------------------------------------------
const composeDe = (p: Projeto) => chamadas(p).filter((c) => c.startsWith("compose") && !c.startsWith("compose version"));
const mexeuNoBanco = (p: Projeto) =>
  chamadas(p).filter((c) => /pg_dump|psql.*\s-f\s|compose.* stop|compose.* start|^cp .*:\//.test(c) || / rm -rf /.test(c));

for (const [sistema, disponivel] of sistemas) {
  describe.skipIf(!disponivel)(`${sistema}: backup e restauração só mexem no próprio projeto`, () => {
    it("o projeto vem do .env.local desta pasta (CRM_ALQUIMIA_PROJETO da sessão não redireciona)", () => {
      const p = criarProjeto();
      writeFileSync(join(p.dir, ".env.local"), readFileSync(join(p.dir, ".env.local"), "utf8") + "CRM_ALQUIMIA_PROJETO=crm-teste\n");
      const r = executar(p, sistema, "backup", { env: { CRM_ALQUIMIA_PROJETO: "outro-sistema" } });
      expect(r.status, r.tudo).toBe(0);
      expect(chamadas(p).some((c) => c.includes("exec supabase_db_crm-teste pg_dump"))).toBe(true);
      expect(chamadas(p).some((c) => c.startsWith("cp supabase_storage_crm-teste:"))).toBe(true);
      expect(chamadas(p).some((c) => /crm-alquimia|outro-sistema/.test(c))).toBe(false);
    });

    it("com COMPOSE_PROJECT_NAME de outro projeto na sessão, todo compose da restauração leva -p e -f", () => {
      const p = criarProjeto();
      plantarBackup(p, "2026-02-02-0900", "-- dados do backup B\nCOPY public.b FROM stdin;\n");
      const r = executar(p, sistema, "restaurar", {
        stdin: "1\nRESTAURAR\n",
        env: { COMPOSE_PROJECT_NAME: "outro-sistema", COMPOSE_FILE: "outro.yml" },
      });
      expect(r.status, r.tudo).toBe(0);
      const compose = composeDe(p);
      expect(compose.length).toBeGreaterThanOrEqual(2);
      for (const c of compose) expect(c).toMatch(/^compose -p crm-alquimia -f docker-compose\.yml --env-file \.env\.local (stop|start) /);
      expect(r.saida).toContain("docker compose -p crm-alquimia --env-file .env.local start worker scheduler");
    });

    it("EOF logo na confirmação (só o número do backup, nada mais): cancela com código 1 sem mexer em nada", () => {
      const p = criarProjeto();
      plantarBackup(p, "2026-02-02-0900");
      const r = executar(p, sistema, "restaurar", { stdin: "1\n" });
      expect(r.status, r.tudo).toBe(1);
      expect(r.saida).toMatch(/Cancelado/);
      expect(mexeuNoBanco(p)).toEqual([]);
      expect(backupsDe(p)).toEqual(["2026-02-02-0900.sql.gz"]);
    });
  });

  describe.skipIf(!disponivel)(`${sistema}: um backup por vez`, () => {
    it("outro backup rodando (trava recente): recusa com mensagem clara e não toca no banco", () => {
      const p = criarProjeto();
      mkdirSync(join(p.dir, "backups", ".trava-backup"), { recursive: true });
      const r = executar(p, sistema, "backup");
      expect(r.status, r.tudo).not.toBe(0);
      expect(r.tudo).toMatch(/Outro backup/);
      expect(chamadas(p).some((c) => c.includes("pg_dump"))).toBe(false);
      expect(backupsDe(p)).toEqual([]);
      // a trava é do outro: continua lá
      expect(existsSync(join(p.dir, "backups", ".trava-backup"))).toBe(true);
    });

    it("trava velha (mais de 2 h, de um backup que morreu): é quebrada, o backup sai e a trava some no fim", () => {
      const p = criarProjeto();
      const trava = join(p.dir, "backups", ".trava-backup");
      mkdirSync(trava, { recursive: true });
      const tresHorasAtras = new Date(Date.now() - 3 * 3600_000);
      utimesSync(trava, tresHorasAtras, tresHorasAtras);
      const r = executar(p, sistema, "backup");
      expect(r.status, r.tudo).toBe(0);
      expect(backupsDe(p)).toHaveLength(1);
      expect(existsSync(trava)).toBe(false);
    });

    it("o backup normal não deixa trava para trás", () => {
      const p = criarProjeto();
      const r = executar(p, sistema, "backup");
      expect(r.status, r.tudo).toBe(0);
      expect(existsSync(join(p.dir, "backups", ".trava-backup"))).toBe(false);
    });

    it("vale para o backup de segurança da restauração: com outro backup rodando, não restaura e religa tudo", () => {
      const p = criarProjeto();
      plantarBackup(p, "2026-02-02-0900", "-- dados do backup B\n");
      mkdirSync(join(p.dir, "backups", ".trava-backup"), { recursive: true });
      const r = executar(p, sistema, "restaurar", { stdin: "1\nRESTAURAR\n" });
      expect(r.status, r.tudo).not.toBe(0);
      expect(r.tudo).toMatch(/Outro backup/);
      expect(chamadas(p).some((c) => /psql.*--single-transaction/.test(c))).toBe(false);
      expect(chamadas(p).some((c) => /compose .*start app worker scheduler/.test(c))).toBe(true);
    });
  });

  describe.skipIf(!disponivel)(`${sistema}: a pasta de backups tem de ser só dos backups`, () => {
    it("CRM_ALQUIMIA_BACKUP_DIR com outros arquivos: recusa antes de mexer nas permissões da pasta", () => {
      const p = criarProjeto();
      const pasta = join(p.dir, "documentos-do-usuario");
      mkdirSync(pasta);
      writeFileSync(join(pasta, "planilha.xlsx"), "dados do usuário");
      const aclAntes = ehWindows ? spawnSync("icacls", [pasta], { encoding: "utf8" }).stdout : "";
      const r = executar(p, sistema, "backup", { env: { CRM_ALQUIMIA_BACKUP_DIR: pasta } });
      expect(r.status, r.tudo).not.toBe(0);
      expect(r.tudo).toContain("planilha.xlsx");
      expect(r.tudo).toMatch(/s. dos backups/);
      expect(chamadas(p).some((c) => c.includes("pg_dump"))).toBe(false);
      expect(readFileSync(join(pasta, "planilha.xlsx"), "utf8")).toBe("dados do usuário");
      if (ehWindows) expect(spawnSync("icacls", [pasta], { encoding: "utf8" }).stdout).toBe(aclAntes);
    });

    it("na pasta padrão (backups/, dentro do CRM) um arquivo alheio só gera AVISO, e o backup sai", () => {
      const p = criarProjeto();
      mkdirSync(join(p.dir, "backups"));
      writeFileSync(join(p.dir, "backups", "nota.txt"), "x");
      const r = executar(p, sistema, "backup");
      expect(r.status, r.tudo).toBe(0);
      expect(r.tudo).toMatch(/AVISO/);
      expect(r.tudo).toContain("nota.txt");
      expect(backupsDe(p)).toHaveLength(1);
    });

    it("pasta que só tem backups (de antes) segue funcionando", () => {
      const p = criarProjeto();
      plantarBackup(p, "2026-02-02-0900");
      const r = executar(p, sistema, "backup");
      expect(r.status, r.tudo).toBe(0);
      expect(backupsDe(p)).toHaveLength(2);
    });
  });
}

// --- Casos de borda do backup -----------------------------------------------------------------------------
for (const [sistema, disponivel] of sistemas) {
  describe.skipIf(!disponivel)(`${sistema}: a trava sempre é solta`, () => {
    it("pg_dump falhando no meio: o backup falha e a trava some", () => {
      const p = criarProjeto();
      const r = executar(p, sistema, "backup", { env: { FAKE_DOCKER_FALHA_PGDUMP: "1" } });
      expect(r.status, r.tudo).not.toBe(0);
      expect(existsSync(join(p.dir, "backups", ".trava-backup"))).toBe(false);
    });

    it("a recusa por trava diz o caminho da trava e como destravar", () => {
      const p = criarProjeto();
      mkdirSync(join(p.dir, "backups", ".trava-backup"), { recursive: true });
      const r = executar(p, sistema, "backup");
      expect(r.status, r.tudo).not.toBe(0);
      expect(r.tudo).toContain(".trava-backup");
      expect(r.tudo).toMatch(/apague/);
      expect(r.tudo).toMatch(/2 horas/);
    });

    it("quebrar uma trava velha não deixa sobra (.trava-backup.*) na pasta", () => {
      const p = criarProjeto();
      const trava = join(p.dir, "backups", ".trava-backup");
      mkdirSync(trava, { recursive: true });
      const velho = new Date(Date.now() - 3 * 3600_000);
      utimesSync(trava, velho, velho);
      const r = executar(p, sistema, "backup");
      expect(r.status, r.tudo).toBe(0);
      expect(readdirSync(join(p.dir, "backups")).filter((n) => n.startsWith(".trava"))).toEqual([]);
    });
  });

  describe.skipIf(!disponivel)(`${sistema}: pasta de backups`, () => {
    it("arquivos de sistema (desktop.ini, .DS_Store, Thumbs.db, lost+found) não contam como alheios", () => {
      const p = criarProjeto();
      const pasta = join(p.dir, "pendrive-backups");
      mkdirSync(join(pasta, "lost+found"), { recursive: true });
      for (const n of ["desktop.ini", ".DS_Store", "Thumbs.db"]) writeFileSync(join(pasta, n), "x");
      const r = executar(p, sistema, "backup", { env: { CRM_ALQUIMIA_BACKUP_DIR: pasta } });
      expect(r.status, r.tudo).toBe(0);
      expect(readdirSync(pasta).filter((n) => n.endsWith(".sql.gz"))).toHaveLength(1);
    });

    it("CRM_ALQUIMIA_BACKUP_DIR que já existia (vazia): avisa que passa a ser só do seu usuário", () => {
      const p = criarProjeto();
      const pasta = join(p.dir, "pasta-que-ja-existia");
      mkdirSync(pasta);
      const r = executar(p, sistema, "backup", { env: { CRM_ALQUIMIA_BACKUP_DIR: pasta } });
      expect(r.status, r.tudo).toBe(0);
      expect(r.tudo).toMatch(/AVISO/);
      expect(r.tudo).toMatch(/j. existia/);
    });
  });

  describe.skipIf(!disponivel)(`${sistema}: CRM_ALQUIMIA_STORAGE_DIR validado`, () => {
    it("com caractere de shell: recusa antes de qualquer coisa", () => {
      const p = criarProjeto();
      const r = executar(p, sistema, "backup", { env: { CRM_ALQUIMIA_STORAGE_DIR: "/mnt; touch /tmp/x" } });
      expect(r.status, r.tudo).not.toBe(0);
      expect(r.tudo).toContain("CRM_ALQUIMIA_STORAGE_DIR");
      expect(chamadas(p).some((c) => c.includes("pg_dump"))).toBe(false);
    });

    it("a raiz (/) é recusada", () => {
      const p = criarProjeto();
      const r = executar(p, sistema, "backup", { env: { CRM_ALQUIMIA_STORAGE_DIR: "/" } });
      expect(r.status, r.tudo).not.toBe(0);
      expect(r.tudo).toContain("CRM_ALQUIMIA_STORAGE_DIR");
    });

    it("a limpeza do Storage na restauração leva o caminho entre aspas", () => {
      const p = criarProjeto();
      plantarBackup(p, "2026-02-02-0900", "-- dados do backup B\n");
      const r = executar(p, sistema, "restaurar", { stdin: "1\nRESTAURAR\n" });
      expect(r.status, r.tudo).toBe(0);
      const limpeza = chamadas(p).find((c) => / sh -c /.test(c))!;
      expect(limpeza).toContain("rm -rf '/mnt'/* '/mnt'/.[!.]*");
    });
  });
}

// --- Mais casos de borda do backup ------------------------------------------------------------------------
describe.skipIf(!temBash)("bash: não depende de $(trap -p) (o bash 3.2 do macOS pode devolvê-lo vazio)", () => {
  it("com trap -p sempre vazio, a restauração cujo backup de segurança falha ainda religa os três serviços", () => {
    const p = criarProjeto();
    plantarBackup(p, "2026-02-02-0900", "-- dados do backup B\n");
    // BASH_ENV é lido por todo bash não interativo: aqui ele faz `trap -p` não devolver nada
    const shim = join(p.dir, "trap-p-vazio.sh");
    writeFileSync(shim, 'trap() { if [ "${1:-}" = "-p" ]; then return 0; fi; builtin trap "$@"; }\n');
    const r = executar(p, "bash", "restaurar", {
      stdin: "1\nRESTAURAR\n",
      env: { BASH_ENV: shim.replace(/\\/g, "/"), FAKE_DOCKER_FALHA_PGDUMP: "1" },
    });
    expect(r.status, r.tudo).not.toBe(0);
    expect(chamadas(p).some((c) => /compose .*start app worker scheduler/.test(c)), r.tudo).toBe(true);
    expect(existsSync(join(p.dir, "backups", ".trava-backup"))).toBe(false);
  });

  it("a lib não lê trap -p", () => {
    expect(readFileSync(join(FONTE, "scripts/lib/backup.sh"), "utf8")).not.toMatch(/trap -p/);
  });
});

describe.skipIf(!temPowerShell)("ps1: interrompido no meio, o trabalho parcial (.parcial-*) também some", () => {
  it("um erro que escapa no meio do backup (como um Ctrl+C) solta a trava E apaga o .parcial-*", () => {
    const p = criarProjeto();
    const harness = join(p.dir, "interromper.ps1");
    writeFileSync(
      harness,
      "\ufeff" +
        [
          '$ErrorActionPreference = "Continue"',
          "Set-Location $PSScriptRoot",
          '. (Join-Path $PSScriptRoot "scripts\\lib\\backup.ps1")',
          // a cópia do Storage é anunciada fora de qualquer try: o throw ali simula a interrupção
          'function Backup-Log([string]$m) { if ($m -like "*Storage*") { throw "interrompido" } }',
          'try { Criar-Backup (Join-Path $PSScriptRoot "backups") $PSScriptRoot | Out-Null } catch { Write-Host "pegou: $($_.Exception.Message)" }',
        ].join("\r\n"),
    );
    const env = ambiente(p, "ps1");
    const r = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", harness], { cwd: p.dir, encoding: "utf8", env });
    expect(r.stdout + r.stderr).toContain("pegou: interrompido");
    const sobras = readdirSync(join(p.dir, "backups")).filter((n) => n.startsWith("."));
    expect(sobras, r.stdout + r.stderr).toEqual([]);
  });
});

for (const [sistema, disponivel] of sistemas) {
  describe.skipIf(!disponivel)(`${sistema}: CRM_ALQUIMIA_STORAGE_DIR sem . nem ..`, () => {
    for (const valor of ["/..", "/mnt/..", "/mnt/../etc", "/mnt/./x", "/."]) {
      it(`${valor} é recusado`, () => {
        const p = criarProjeto();
        const r = executar(p, sistema, "backup", { env: { CRM_ALQUIMIA_STORAGE_DIR: valor } });
        expect(r.status, r.tudo).not.toBe(0);
        expect(r.tudo).toContain("CRM_ALQUIMIA_STORAGE_DIR");
        expect(chamadas(p).some((c) => c.includes("pg_dump"))).toBe(false);
      });
    }

    it("/mnt/dados.v2 (ponto dentro do nome) segue valendo", () => {
      const p = criarProjeto();
      const r = executar(p, sistema, "backup", { env: { CRM_ALQUIMIA_STORAGE_DIR: "/mnt/dados.v2" } });
      expect(r.status, r.tudo).toBe(0);
    });
  });

  describe.skipIf(!disponivel)(`${sistema}: quebra da trava velha sem devolver trava de ninguém`, () => {
    const envelhecer = (caminho: string, horas: number) => {
      const t = new Date(Date.now() - horas * 3600_000);
      utimesSync(caminho, t, t);
    };

    it("outro processo está quebrando a trava agora (.trava-backup.quebrando recente): recusa, não mexe em nada", () => {
      const p = criarProjeto();
      const trava = join(p.dir, "backups", ".trava-backup");
      mkdirSync(trava, { recursive: true });
      envelhecer(trava, 3);
      writeFileSync(join(p.dir, "backups", ".trava-backup.quebrando"), "");
      const r = executar(p, sistema, "backup");
      expect(r.status, r.tudo).not.toBe(0);
      expect(r.tudo).toMatch(/Outro backup/);
      expect(existsSync(trava)).toBe(true);
      expect(existsSync(join(p.dir, "backups", ".trava-backup.quebrando"))).toBe(true);
    });

    it("uma marca de quebra abandonada (mais de 10 min) não trava para sempre", () => {
      const p = criarProjeto();
      const trava = join(p.dir, "backups", ".trava-backup");
      mkdirSync(trava, { recursive: true });
      envelhecer(trava, 3);
      const marca = join(p.dir, "backups", ".trava-backup.quebrando");
      writeFileSync(marca, "");
      envelhecer(marca, 1);
      const r = executar(p, sistema, "backup");
      expect(r.status, r.tudo).toBe(0);
      expect(readdirSync(join(p.dir, "backups")).filter((n) => n.startsWith(".trava"))).toEqual([]);
    });
  });
}

describe.skipIf(!temBash)("bash: interrompido (SIGTERM) no meio, solta a trava", () => {
  function interromper(p: Projeto, script: "backup" | "restaurar", stdin = "") {
    const env = ambiente(p, "bash", { FAKE_DOCKER_DORME_PGDUMP: "4000" });
    const corpo = [
      `printf '%s' "$ENTRADA" | bash scripts/${script}.sh > saida.log 2>&1 &`,
      "pid=$!",
      "for i in $(seq 1 150); do [ -d backups/.trava-backup ] && break; sleep 0.1; done",
      "[ -d backups/.trava-backup ] || { echo SEM-TRAVA; exit 9; }",
      "kill -TERM $pid",
      "wait $pid; echo rc=$?",
    ].join("\n");
    return spawnSync("bash", ["-c", corpo], { cwd: p.dir, encoding: "utf8", env: { ...env, ENTRADA: stdin } });
  }

  it("backup.sh morto com SIGTERM durante o pg_dump: sai com erro e a trava some", () => {
    const p = criarProjeto();
    const r = interromper(p, "backup");
    expect(r.stdout, r.stdout + r.stderr).toMatch(/rc=[1-9]/);
    expect(existsSync(join(p.dir, "backups", ".trava-backup"))).toBe(false);
    expect(backupsDe(p)).toEqual([]);
  });

  it("restaurar.sh morto durante o backup de segurança: solta a trava E religa os três serviços", () => {
    const p = criarProjeto();
    plantarBackup(p, "2026-02-02-0900", "-- dados do backup B\n");
    const r = interromper(p, "restaurar", "1\nRESTAURAR\n");
    expect(r.stdout, r.stdout + r.stderr).toMatch(/rc=[1-9]/);
    expect(existsSync(join(p.dir, "backups", ".trava-backup"))).toBe(false);
    expect(chamadas(p).some((c) => /compose .*start app worker scheduler/.test(c))).toBe(true);
    expect(chamadas(p).some((c) => /psql.*--single-transaction/.test(c))).toBe(false);
  });
});

describe.skipIf(!(temBash && ehWindows))("bash: restringir_acl_windows roda os dois icacls mesmo se o primeiro falhar", () => {
  it("/reset falhou: o /inheritance:r ainda roda e sai um AVISO", () => {
    const dir = mkdtempSync(join(tmpdir(), "crm-icacls-"));
    pastas.push(dir);
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const log = join(dir, "icacls.log").replace(/\\/g, "/");
    writeFileSync(
      join(bin, "icacls"),
      '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "' + log + '"\ncase "$*" in *"/reset"*) exit 5 ;; esac\nexit 0\n',
    );
    chmodSync(join(bin, "icacls"), 0o755);
    writeFileSync(join(dir, "alvo.txt"), "x");
    const lib = (process.env.CRM_ALQUIMIA_TESTE_FONTE_SCRIPTS || RAIZ).replace(/\\/g, "/") + "/scripts/lib/instalar-env.sh";
    const r = spawnSync("bash", ["-c", 'source "' + lib + '"; restringir_acl_windows alvo.txt'], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? process.env.Path ?? ""}` },
    });
    const linhas = existsSync(log) ? readFileSync(log, "utf8") : "";
    expect(linhas).toContain("/reset");
    expect(linhas).toContain("/inheritance:r");
    expect(r.stderr).toMatch(/AVISO/);
  });
});
