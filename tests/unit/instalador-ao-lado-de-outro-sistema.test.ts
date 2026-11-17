/**
 * Instalar o CRM ALQUIM(IA) numa máquina que JÁ roda outra coisa (outro Supabase local, outro app na 3000,
 * outro projeto do Docker Compose). EXECUTA de verdade `scripts/instalar.*` e `scripts/parar.*` (bash e
 * Windows PowerShell 5.1) numa cópia temporária, com `docker` e `npx` FALSOS no PATH que registram cada
 * chamada. As portas "ocupadas" são servidores TCP de verdade abertos pelo teste em portas efêmeras: nada
 * aqui toca em Docker, Supabase ou porta de outro sistema.
 *
 * Trancam (riscos R1 a R8 da prova de instalação ao lado da produção):
 *   1. porta ocupada por outro programa = o instalador para ANTES de tocar em qualquer coisa, dizendo qual
 *      variável trocar; porta ocupada pelo próprio CRM (reinstalação) passa;
 *   2. todo `docker compose` leva `-p <projeto> -f docker-compose.yml`, mesmo com COMPOSE_PROJECT_NAME e
 *      COMPOSE_FILE de outro projeto na sessão; todo comando da CLI do Supabase leva a pasta/projeto certos;
 *   3. as imagens são construídas UMA POR VEZ, com o heap do build configurável;
 *   4. a CLI do Supabase tem versão fixa e não sobe o que o CRM não usa;
 *   5. o nome do projeto é configurável (duas instalações lado a lado).
 */
import { execFile } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createTcpServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";

import { afterAll, describe, expect, it } from "vitest";

// De onde copiar os scripts (padrão: este checkout). Outra pasta serve para medir uma versão antiga dos
// scripts com estes mesmos testes (a prova de que eles falham sem a correção).
const RAIZ = process.env.CRM_ALQUIMIA_TESTE_FONTE_SCRIPTS || process.cwd();
const ehWindows = process.platform === "win32";
const temBash = !spawnSync("bash", ["-c", "true"]).error;
const temPowerShell = ehWindows && !spawnSync("powershell", ["-NoProfile", "-Command", "1"]).error;

const VERSAO_CLI = "2.120.0";
const FORA = "imgproxy,studio,postgres-meta,mailpit";
/** Projeto padrão do compose. Os nomes que o Docker deriva dele (`<projeto>-<serviço>-N`,
 * `<projeto>_<volume>`) saem daqui, e não escritos à mão, um a um. */
const PROJETO = "crm-alquimia";

const pastas: string[] = [];
const servidores: Array<Server | ReturnType<typeof createTcpServer>> = [];
afterAll(async () => {
  for (const s of servidores) await new Promise((r) => s.close(() => r(null)));
  for (const p of pastas) rmSync(p, { recursive: true, force: true });
});

const DOCKER_FALSO = `
const fs = require("fs");
const args = process.argv.slice(2);
if (process.env.FAKE_DOCKER_LOG) fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(args) + "\\n");
// uma linha do tempo só, com o npx falso, para conferir a ORDEM
if (process.env.FAKE_ORDEM_LOG) fs.appendFileSync(process.env.FAKE_ORDEM_LOG, "docker " + args.join(" ") + "\\n");
// Um build que só acaba se for morto; grava o próprio pid para o teste conferir que morreu
if (args[0] === "compose" && args.includes("build") && process.env.FAKE_DOCKER_BUILD_PRESO === args[args.length - 1]) {
  if (process.env.FAKE_DOCKER_BUILD_PID) fs.writeFileSync(process.env.FAKE_DOCKER_BUILD_PID, String(process.pid));
  setInterval(() => {}, 1000);
  return;
}
if (args[0] === "compose" && args.includes("build") && process.env.FAKE_DOCKER_FALHA_BUILD === args[args.length - 1]) { process.stderr.write("falha falsa no build\\n"); process.exit(1); }
const [cmd, ...resto] = args;
// inspect --format {{json .Config}} NOME: FAKE_DOCKER_INSPECT = { nome: { antes, depois } }, "antes" até o
// primeiro supabase start (pelo FAKE_SUPABASE_START_CONTADOR), "depois" a partir dele. Sem o nome, nada.
if (cmd === "inspect" && resto.includes("--format") && process.env.FAKE_DOCKER_INSPECT) {
  const e = JSON.parse(process.env.FAKE_DOCKER_INSPECT)[resto[resto.length - 1]];
  const c = process.env.FAKE_SUPABASE_START_CONTADOR;
  const starts = c && fs.existsSync(c) ? Number(fs.readFileSync(c, "utf8")) : 0;
  const v = e ? (starts > 0 && "depois" in e ? e.depois : e.antes) : undefined;
  if (v !== undefined && v !== null) process.stdout.write(JSON.stringify(v) + "\\n");
  process.exit(0);
}
// O --format é interpretado como o docker faz (template do Go): {{.Names}}, {{.Name}} e {{.Label "x"}} ou
// {{.Label \`x\`}}. Recebe o argv como o processo o recebe, então as aspas que o Windows PowerShell 5.1 tira
// ao chamar um programa ({{.Label com.docker...}}) dão o MESMO erro do docker real, com código 1.
function formatar(obj) {
  const fmt = resto[resto.indexOf("--format") + 1] || "";
  let erro = "";
  const saida = fmt.replace(/\\{\\{\\s*(.*?)\\s*\\}\\}/g, (_, expr) => {
    let m;
    if ((m = /^\\.(Names|Name)$/.exec(expr))) return obj[m[1]] || "";
    if ((m = /^\\.Label\\s+(?:"([^"]*)"|\`([^\`]*)\`)$/.exec(expr))) return (obj.labels || {})[m[1] !== undefined ? m[1] : m[2]] || "";
    if ((m = /^\\.Label\\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(expr))) { erro = erro || 'template: :1: function "' + m[1] + '" not defined'; return ""; }
    erro = erro || "template: :1: unexpected " + expr;
    return "";
  });
  return { saida, erro };
}
function conferirFormato(prefixo) {
  const r = formatar({});
  if (r.erro) { process.stderr.write(prefixo + r.erro + "\\n"); process.exit(1); }
}
const rotulos = (projeto, pasta) => ({ "com.docker.compose.project": projeto || "", "com.docker.compose.project.working_dir": pasta || "" });
if (cmd === "ps") {
  conferirFormato("failed to parse template: ");
  const filtro = resto[resto.indexOf("--filter") + 1] || "";
  const m = /^publish=(\\d+)$/.exec(filtro);
  const mapa = JSON.parse(process.env.FAKE_DOCKER_PUBLICA || "{}");
  if (m && process.env.FAKE_DOCKER_FALHA_PUBLISH) { process.stderr.write("Error response from daemon: falha falsa no filtro publish\\n"); process.exit(1); }
  if (m && mapa[m[1]]) process.stdout.write(formatar({ Names: mapa[m[1]] }).saida + "\\n");
  // contêineres do compose de um projeto (inclusive parados), com a pasta de onde o compose subiu cada um
  const l = /^label=com\\.docker\\.compose\\.project=(.+)$/.exec(filtro);
  if (l) {
    if (process.env.FAKE_DOCKER_FALHA_LISTA) { process.stderr.write("Cannot connect to the Docker daemon\\n"); process.exit(1); }
    for (const c of JSON.parse(process.env.FAKE_DOCKER_COMPOSE || "[]")) {
      if (c.projeto === l[1]) process.stdout.write(formatar({ Names: c.nome, labels: rotulos(c.projeto, c.pasta) }).saida + "\\n");
    }
  }
  process.exit(0);
}
// volumes (os da CLI do Supabase vêm com o label de projeto, mas sem a pasta; o Docker Desktop também não
// grava a pasta nos volumes do compose)
if (cmd === "volume" && resto[0] === "ls") {
  conferirFormato("template parsing error: ");
  if (process.env.FAKE_DOCKER_FALHA_LISTA) { process.stderr.write("Cannot connect to the Docker daemon\\n"); process.exit(1); }
  for (const v of JSON.parse(process.env.FAKE_DOCKER_VOLUMES || "[]")) {
    process.stdout.write(formatar({ Name: v.nome, labels: rotulos(v.projeto, v.pasta) }).saida + "\\n");
  }
  process.exit(0);
}
// docker info --format {{.MemTotal}}: a memória da VM do Docker em bytes; sem a variável, nada
if (cmd === "info" && resto.join(" ").includes(".MemTotal")) {
  if (process.env.FAKE_DOCKER_MEMTOTAL) process.stdout.write(process.env.FAKE_DOCKER_MEMTOTAL + "\\n");
  process.exit(0);
}
if (cmd === "compose" && resto[0] === "version") { process.stdout.write("Docker Compose version v2.0.0\\n"); process.exit(0); }
// o que o compose recebe do ambiente para o build (CPUs e heap do Next)
if (cmd === "compose" && resto.includes("build") && process.env.FAKE_DOCKER_ENV_LOG) {
  fs.appendFileSync(process.env.FAKE_DOCKER_ENV_LOG, JSON.stringify({ cpus: process.env.CRM_ALQUIMIA_BUILD_CPUS || "", heap: process.env.CRM_ALQUIMIA_HEAP_BUILD_MB || "", versao: process.env.APP_VERSION || "" }) + "\\n");
}
// exec NOME cat /home/kong/kong.yml: FAKE_DOCKER_KONG_YML = { nome: texto } (o arquivo onde as chaves sb_ do Kong de fato ficam).
if (cmd === "exec" && resto.includes("cat") && resto.includes("/home/kong/kong.yml")) {
  const t = process.env.FAKE_DOCKER_KONG_YML ? JSON.parse(process.env.FAKE_DOCKER_KONG_YML)[resto[0]] : undefined;
  if (t !== undefined) process.stdout.write(t + "\\n");
  process.exit(t !== undefined ? 0 : 1);
}
if (cmd === "exec" && resto.includes("-c")) { process.stdout.write("f\\n"); process.exit(0); }
process.exit(0);
`;

const NPX_FALSO = `
const fs = require("fs");
const args = process.argv.slice(2);
if (process.env.FAKE_NPX_LOG) fs.appendFileSync(process.env.FAKE_NPX_LOG, JSON.stringify(args) + "\\n");
if (process.env.FAKE_ORDEM_LOG) fs.appendFileSync(process.env.FAKE_ORDEM_LOG, "npx " + args.join(" ") + "\\n");
// o segredo do JWT que a CLI recebe do ambiente (o supabase/config.toml o lê de env(CRM_ALQUIMIA_JWT_SECRET))
if (process.env.FAKE_NPX_ENV_LOG) fs.appendFileSync(process.env.FAKE_NPX_ENV_LOG, JSON.stringify({ args, jwt: process.env.CRM_ALQUIMIA_JWT_SECRET || "", secreta: process.env.CRM_ALQUIMIA_SECRET_KEY || "", publica: process.env.CRM_ALQUIMIA_PUBLISHABLE_KEY || "" }) + "\\n");
// \`gen signing-key\`, como a CLI 2.120 com \`[auth] signing_keys_path\` no config: lê o arquivo (falha sem ele) e,
// com --append, acrescenta uma chave nele, sem nada no stdout. FAKE_GEN_NA_SAIDA imita a CLI sem o caminho no
// config (a chave sai no stdout); FAKE_GEN_FALHA, um erro (em JSON, no stdout, como a real).
if (args.includes("gen") && args.includes("signing-key")) {
  const iw = args.indexOf("--workdir");
  const arq = require("path").join(iw >= 0 ? args[iw + 1] : ".", "supabase", "signing_keys.json");
  const chave = (n) => ({ kty: "EC", kid: "kid-falso-" + n, use: "sig", key_ops: ["sign", "verify"], alg: "ES256", ext: true, d: "d-privada-falsa-nunca-na-tela", crv: "P-256", x: "x-falso", y: "y-falso" });
  if (process.env.FAKE_GEN_STDERR) { process.stderr.write(process.env.FAKE_GEN_STDERR + "\\n"); process.exit(1); }
  if (process.env.FAKE_GEN_FALHA) { process.stdout.write('{"_tag":"Error","error":{"code":"GenFalsoError","message":"falha falsa do gen"}}\\n'); process.exit(1); }
  if (process.env.FAKE_GEN_NA_SAIDA) { process.stdout.write(JSON.stringify(chave(1)) + "\\n"); process.exit(0); }
  if (!fs.existsSync(arq)) { process.stdout.write('{"_tag":"Error","error":{"code":"GenSigningKeyReadError","message":"failed to read signing keys: NotFound"}}\\n'); process.exit(1); }
  if (!args.includes("--append")) { process.stderr.write("Do you want to overwrite the existing file? [Y/n]\\n"); process.exit(1); }
  const atual = JSON.parse(fs.readFileSync(arq, "utf8"));
  atual.push(chave(atual.length + 1));
  fs.writeFileSync(arq, JSON.stringify(atual));
  process.stderr.write("JWT signing key appended to: supabase/signing_keys.json (now contains " + atual.length + " keys)\\n");
  process.exit(0);
}
// Como a CLI real com signing_keys_path no config: sem o arquivo, status e start falham (o stop não o lê).
const semChave = () => {
  const iw = args.indexOf("--workdir");
  return !fs.existsSync(require("path").join(iw >= 0 ? args[iw + 1] : ".", "supabase", "signing_keys.json"));
};
if ((args.includes("status") || args.includes("start")) && semChave()) {
  process.stdout.write('{"_tag":"Error","error":{"code":"StatusInvalidConfigError","message":"failed to read signing keys: ENOENT"}}\\n');
  process.exit(1);
}
// FAKE_SUPABASE_ESTADO: arquivo com o estado do Supabase falso; o stop o derruba, o start o sobe.
const estado = process.env.FAKE_SUPABASE_ESTADO;
const lerEstado = () => (estado && fs.existsSync(estado) ? fs.readFileSync(estado, "utf8") : "");
if (args.includes("status")) {
  if (args.includes("-o")) { process.stdout.write('ANON_KEY="anon-falsa"\\nSERVICE_ROLE_KEY="servico-falsa"\\n'); process.exit(0); }
  if (lerEstado() === "parado") process.exit(1);
  if (lerEstado() === "de-pe") process.exit(0);
  process.exit(Number(process.env.FAKE_SUPABASE_STATUS || "1"));
}
// O start real imprime as chaves no stdout: o falso também, para conferir que nunca chegam à tela.
if (args.includes("start")) process.stdout.write('SERVICE_ROLE_KEY="chave-do-stdout-nunca-na-tela"\\n');
// O start falha nas FAKE_SUPABASE_START_FALHAS primeiras vezes (mudo, como o real, ou com
// FAKE_SUPABASE_START_MSG no stderr e FAKE_SUPABASE_START_STDOUT no stdout, onde a CLI real põe o erro
// em JSON); a contagem fica em FAKE_SUPABASE_START_CONTADOR.
if (args.includes("start") && process.env.FAKE_SUPABASE_START_CONTADOR) {
  const c = process.env.FAKE_SUPABASE_START_CONTADOR;
  const n = fs.existsSync(c) ? Number(fs.readFileSync(c, "utf8")) : 0;
  fs.writeFileSync(c, String(n + 1));
  if (n < Number(process.env.FAKE_SUPABASE_START_FALHAS || "0")) {
    if (process.env.FAKE_SUPABASE_START_MSG) process.stderr.write(process.env.FAKE_SUPABASE_START_MSG.replace("{n}", String(n + 1)) + "\\n");
    if (process.env.FAKE_SUPABASE_START_STDOUT) process.stdout.write(process.env.FAKE_SUPABASE_START_STDOUT.replace("{n}", String(n + 1)) + "\\n");
    process.exit(1);
  }
}
if (args.includes("start")) { if (estado) fs.writeFileSync(estado, "de-pe"); process.exit(Number(process.env.FAKE_SUPABASE_START || "0")); }
if (args.includes("stop")) { if (estado) fs.writeFileSync(estado, "parado"); process.exit(Number(process.env.FAKE_SUPABASE_STOP || "0")); }
process.exit(0);
`;

/**
 * O `npx.ps1` que o instalador do Node põe no PATH do Windows, com o MESMO despacho (só o CLI trocado pelo
 * falso). Chamado de dentro de uma função do PowerShell ("-Command"), ele reconstrói a linha a partir do
 * texto da chamada e perde os argumentos que vieram por splatting: `supabase status` vira `supabase` (que
 * mostra a ajuda e sai com 0). É o caso real de um bug medido; um `npx.cmd` sozinho não o reproduz.
 */
const NPX_PS1_FALSO = [
  "#!/usr/bin/env pwsh",
  "Set-StrictMode -Version 'Latest'",
  '$NODE_EXE="node"',
  '$NPX_CLI_JS="$PSScriptRoot/../npx-falso.js"',
  "if ($MyInvocation.ExpectingInput) {",
  "  $input | & $NODE_EXE $NPX_CLI_JS $args",
  "} elseif (-not $MyInvocation.Line) {",
  "  & $NODE_EXE $NPX_CLI_JS $args",
  "} else {",
  "  if (($MyInvocation | Get-Member -Name 'Statement') -and $MyInvocation.Statement) {",
  "    $NPX_ORIGINAL_COMMAND = $MyInvocation.Statement",
  "  } else {",
  "    $NPX_ORIGINAL_COMMAND = (",
  "      [Management.Automation.InvocationInfo].GetProperty('ScriptPosition', [Reflection.BindingFlags] 'Instance, NonPublic')",
  "    ).GetValue($MyInvocation).Text",
  "  }",
  '  $NODE_EXE = $NODE_EXE.Replace("``", "````")',
  '  $NPX_CLI_JS = $NPX_CLI_JS.Replace("``", "````")',
  "  $NPX_COMMAND_ARRAY = [Management.Automation.Language.Parser]::ParseInput($NPX_ORIGINAL_COMMAND, [ref] $null, [ref] $null).",
  "    EndBlock.Statements.PipelineElements.CommandElements.Extent.Text",
  "  $NPX_ARGS = ($NPX_COMMAND_ARRAY | Select-Object -Skip 1) -join ' '",
  '  Invoke-Expression "& `"$NODE_EXE`" `"$NPX_CLI_JS`" $NPX_ARGS"',
  "}",
  "exit $LASTEXITCODE",
  "",
].join("\r\n");

interface Projeto {
  dir: string;
  logDocker: string;
  logNpx: string;
  binBash: string;
  binPs1: string;
}

function criarProjeto(): Projeto {
  const dir = mkdtempSync(join(tmpdir(), "crm-ao-lado-"));
  pastas.push(dir);
  mkdirSync(join(dir, "scripts", "lib"), { recursive: true });
  mkdirSync(join(dir, "supabase", "migrations"), { recursive: true });
  for (const arq of [
    "scripts/instalar.sh",
    "scripts/instalar.ps1",
    "scripts/parar.sh",
    "scripts/parar.ps1",
    "scripts/instalar-extensoes.sql",
    "scripts/lib/instalar-env.sh",
    "scripts/lib/instalar-env.ps1",
    "scripts/lib/portas-em-uso.mjs",
    "scripts/lib/conferir-chaves.mjs",
    "supabase/config.toml",
    "docker-compose.yml",
  ]) {
    if (existsSync(join(RAIZ, arq))) copyFileSync(join(RAIZ, arq), join(dir, arq));
  }
  writeFileSync(join(dir, "supabase", "baseline.sql"), "create table public.a (id int);\n");
  const bin = join(dir, "_bin");
  const binBash = join(bin, "bash");
  const binPs1 = join(bin, "ps1");
  mkdirSync(binBash, { recursive: true });
  mkdirSync(binPs1, { recursive: true });
  writeFileSync(join(bin, "docker-falso.js"), DOCKER_FALSO);
  writeFileSync(join(bin, "npx-falso.js"), NPX_FALSO);
  for (const [nome, js] of [
    ["docker", "docker-falso.js"],
    ["npx", "npx-falso.js"],
  ] as const) {
    writeFileSync(
      join(binBash, nome),
      `#!/usr/bin/env bash\nAQUI="$(cd "$(dirname "$0")/.." && (pwd -W 2>/dev/null || pwd))"\nexec node "$AQUI/${js}" "$@"\n`,
    );
    chmodSync(join(binBash, nome), 0o755);
    writeFileSync(join(binPs1, `${nome}.cmd`), `@echo off\r\nnode "%~dp0..\\${js}" %*\r\n`);
  }
  // Como na pasta do Node no Windows: npx.ps1 E npx.cmd lado a lado (o PowerShell prefere o .ps1).
  writeFileSync(join(binPs1, "npx.ps1"), NPX_PS1_FALSO);
  return { dir, logDocker: join(dir, "docker.log"), logNpx: join(dir, "npx.log"), binBash, binPs1 };
}

type Sistema = "bash" | "ps1";

function ambiente(p: Projeto, sistema: Sistema, extra: Record<string, string>): NodeJS.ProcessEnv {
  // Cópia tipada de process.env (NodeJS.ProcessEnv, que o Next declara com NODE_ENV), sem PATH e sem as variáveis do teste.
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^path$/i.test(k) || k.startsWith("CRM_ALQUIMIA_") || k.startsWith("FAKE_") || k.startsWith("COMPOSE_")) delete env[k];
  }
  env.PATH = `${sistema === "bash" ? p.binBash : p.binPs1}${delimiter}${process.env.PATH ?? process.env.Path ?? ""}`;
  env.FAKE_DOCKER_LOG = p.logDocker;
  env.FAKE_NPX_LOG = p.logNpx;
  env.CRM_ALQUIMIA_NAO_ABRIR = "1";
  // Memória livre fixa e folgada: o resultado não depende da RAM da máquina que roda o teste.
  env.CRM_ALQUIMIA_MEMORIA_LIVRE_MB = "16000";
  // Sem servidor no lugar do JWKS do Supabase: uma tentativa só, sem esperar.
  env.CRM_ALQUIMIA_JWKS_TENTATIVAS = "1";
  return { ...env, ...extra };
}

/** Assíncrono de propósito: o servidor HTTP falso (/login e /healthz) roda neste mesmo processo. */
function executar(p: Projeto, sistema: Sistema, script: "instalar" | "parar", extra: Record<string, string> = {}) {
  const env = ambiente(p, sistema, extra);
  const [prog, args] =
    sistema === "bash"
      ? ["bash", [join(p.dir, "scripts", `${script}.sh`)]]
      : ["powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(p.dir, "scripts", `${script}.ps1`)]];
  return new Promise<{ status: number; tudo: string }>((resolve) => {
    const filho = execFile(prog as string, args as string[], { cwd: p.dir, env, encoding: "utf8", timeout: 150_000 }, (erro, saida, err) => {
      resolve({ status: erro ? (typeof erro.code === "number" ? erro.code : 1) : 0, tudo: `${saida}\n${err}` });
    });
    filho.stdin?.end();
  });
}

const ler = (arquivo: string): string[][] =>
  existsSync(arquivo)
    ? readFileSync(arquivo, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
const docker = (p: Projeto) => ler(p.logDocker).map((a) => a.join(" "));
const npx = (p: Projeto) => ler(p.logNpx);

/** Uma porta livre agora (efêmera; o SO não a reaproveita logo). */
async function portaLivre(): Promise<number> {
  const s = createTcpServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const porta = (s.address() as AddressInfo).port;
  await new Promise((r) => s.close(() => r(null)));
  return porta;
}

/** Um "outro programa" escutando numa porta (TCP puro), por padrão só em 127.0.0.1. */
async function portaOcupada(host = "127.0.0.1"): Promise<number> {
  const s = createTcpServer((c) => c.destroy());
  servidores.push(s);
  await new Promise<void>((r, rej) => {
    s.once("error", rej);
    s.listen(0, host, () => r());
  });
  return (s.address() as AddressInfo).port;
}

/** Os contêineres do compose de um projeto, como o docker falso os lista (com a pasta de onde subiram). */
const conteineres = (pasta: string, projeto: string, servicos: string[]) =>
  JSON.stringify(servicos.map((s) => ({ nome: `${projeto}-${s}-1`, projeto, pasta })));

/** O "CRM já de pé": responde 200 em /login e /healthz. */
async function crmDePe(): Promise<number> {
  const s = createServer((_req, res) => {
    res.writeHead(200);
    res.end("ok");
  });
  servidores.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  return (s.address() as AddressInfo).port;
}

async function portasLivres() {
  return {
    CRM_ALQUIMIA_PORTA_APP: String(await portaLivre()),
    CRM_ALQUIMIA_PORTA_WORKER: String(await portaLivre()),
    CRM_ALQUIMIA_PORTA_EVOLUTION: String(await portaLivre()),
    CRM_ALQUIMIA_PORTA_SUPABASE_API: String(await portaLivre()),
    CRM_ALQUIMIA_PORTA_SUPABASE_DB: String(await portaLivre()),
  };
}

describe("nenhum comando documentado sem projeto ou sem a versão da CLI", () => {
  const doc = (a: string) => readFileSync(join(process.cwd(), a), "utf8");

  it("README e CONTRIBUTING: todo docker compose leva -p e nenhum npx supabase sem versão", () => {
    for (const a of ["README.md", "CONTRIBUTING.md"]) {
      const texto = doc(a);
      for (const m of texto.matchAll(/docker compose [^\n`|]*/g)) expect(m[0], `${a}: ${m[0]}`).toMatch(/ -p /);
      expect(texto, a).not.toMatch(/npx supabase(?!@)/);
    }
  });

  it("os cabeçalhos do instalador não prometem mais up --build", () => {
    for (const a of ["scripts/instalar.sh", "scripts/instalar.ps1"]) expect(doc(a), a).not.toContain("up -d --build");
  });

  it("Pasta-Canonica usa -LiteralPath ([ e ] num nome de pasta não são curinga)", () => {
    const ps = doc("scripts/lib/instalar-env.ps1");
    expect(ps).toContain("Push-Location -LiteralPath");
    expect(ps).not.toContain("Push-Location -Path");
  });

  it("gerar-env-e2e.sh também usa a CLI na versão testada quando cai no npx", () => {
    expect(doc("scripts/gerar-env-e2e.sh")).toContain(`supabase@${VERSAO_CLI}`);
  });
});

describe("heap do build do Next configurável (Dockerfile e compose)", () => {
  const dockerfile = readFileSync(join(RAIZ, "Dockerfile"), "utf8");
  const compose = readFileSync(join(RAIZ, "docker-compose.yml"), "utf8");

  it("o Dockerfile lê o heap de um ARG com o padrão de antes (4096)", () => {
    expect(dockerfile).toMatch(/^ARG NODE_HEAP_MB=4096$/m);
    expect(dockerfile).toContain("NODE_OPTIONS=--max-old-space-size=${NODE_HEAP_MB}");
    expect(dockerfile).not.toMatch(/max-old-space-size=4096/);
    // o ARG vem antes do ENV que o usa, no mesmo estágio do build
    expect(dockerfile.indexOf("ARG NODE_HEAP_MB")).toBeLessThan(dockerfile.indexOf("${NODE_HEAP_MB}"));
    expect(dockerfile.lastIndexOf("FROM ", dockerfile.indexOf("ARG NODE_HEAP_MB"))).toBe(
      dockerfile.lastIndexOf("FROM ", dockerfile.indexOf("${NODE_HEAP_MB}")),
    );
  });

  it("o compose passa CRM_ALQUIMIA_HEAP_BUILD_MB ao build do app, com o mesmo padrão", () => {
    expect(compose).toContain("NODE_HEAP_MB: ${CRM_ALQUIMIA_HEAP_BUILD_MB:-4096}");
  });
});

describe("CPUs do build do Next configuráveis (o Turbopack escala com todas as CPUs e esgota a RAM)", () => {
  const dockerfile = readFileSync(join(RAIZ, "Dockerfile"), "utf8");
  const compose = readFileSync(join(RAIZ, "docker-compose.yml"), "utf8");
  const nextConfig = readFileSync(join(RAIZ, "next.config.ts"), "utf8");
  const readme = readFileSync(join(RAIZ, "README.md"), "utf8");

  it("o Dockerfile lê as CPUs de um ARG (padrão 2) e limita o Turbopack (tokio, rayon) e os workers do Next no build", () => {
    expect(dockerfile).toMatch(/^ARG BUILD_CPUS=2$/m);
    // o RUN que chama o pnpm build (pode quebrar a linha com \)
    const m = /^RUN (?:[^\n]*\\\n)*[^\n]*pnpm build/m.exec(dockerfile);
    expect(m, "o RUN do pnpm build").not.toBeNull();
    const run = m![0];
    expect(run).toContain("TOKIO_WORKER_THREADS=${BUILD_CPUS}");
    expect(run).toContain("RAYON_NUM_THREADS=${BUILD_CPUS}");
    expect(run).toContain("CRM_ALQUIMIA_BUILD_CPUS=${BUILD_CPUS}");
    // no mesmo estágio do build, antes de usar
    expect(dockerfile.indexOf("ARG BUILD_CPUS")).toBeLessThan(m!.index);
    expect(dockerfile.lastIndexOf("FROM ", dockerfile.indexOf("ARG BUILD_CPUS"))).toBe(dockerfile.lastIndexOf("FROM ", m!.index));
  });

  it("o compose passa CRM_ALQUIMIA_BUILD_CPUS ao build do app, padrão 2", () => {
    expect(compose).toContain("BUILD_CPUS: ${CRM_ALQUIMIA_BUILD_CPUS:-2}");
  });

  it("o next.config usa CRM_ALQUIMIA_BUILD_CPUS em experimental.cpus (só quando definida)", () => {
    expect(nextConfig).toContain("process.env.CRM_ALQUIMIA_BUILD_CPUS");
    expect(nextConfig).toMatch(/cpus:\s*cpusDoBuild/);
  });

  it("o README diz quanta memória livre o build pede (o número medido) e como baixar CPUs e heap", () => {
    expect(readme).toContain("CRM_ALQUIMIA_BUILD_CPUS");
    expect(readme).toContain("CRM_ALQUIMIA_HEAP_BUILD_MB");
    expect(readme).toMatch(/GB de (RAM|mem.ria) livre/);
    // O número medido numa instalação real e a terceira alavanca
    expect(readme).toContain("+4,1 GB");
    expect(readme).toContain("CRM_ALQUIMIA_BUILD_TYPECHECK");
    expect(readme).not.toMatch(/ainda n.o foram medidos/);
  });
});

const sistemas: Array<[Sistema, boolean]> = [
  ["bash", temBash],
  ["ps1", temPowerShell],
];
const T = 160_000;

for (const [sistema, disponivel] of sistemas) {
  describe.skipIf(!disponivel)(`${sistema}: porta ocupada para o instalador antes de tocar em qualquer coisa`, () => {
    it(
      "porta do app ocupada por outro programa: código 1, mensagem com a porta e a variável, nada alterado",
      async () => {
        const p = criarProjeto();
        const configAntes = readFileSync(join(p.dir, "supabase", "config.toml"), "utf8");
        const portas = await portasLivres();
        const ocupada = await portaOcupada();
        const r = await executar(p, sistema, "instalar", { ...portas, CRM_ALQUIMIA_PORTA_APP: String(ocupada) });
        expect(r.status, r.tudo).not.toBe(0);
        expect(r.tudo).toContain(String(ocupada));
        expect(r.tudo).toContain("CRM_ALQUIMIA_PORTA_APP");
        expect(r.tudo).toMatch(/j. est. em uso/);
        expect(r.tudo).toMatch(/Nada foi alterado/);
        // nada tocado: sem .env.local, config.toml igual, nenhum supabase start, nenhum compose de verdade
        expect(existsSync(join(p.dir, ".env.local"))).toBe(false);
        expect(readFileSync(join(p.dir, "supabase", "config.toml"), "utf8")).toBe(configAntes);
        expect(npx(p).some((a) => a.includes("start"))).toBe(false);
        expect(docker(p).filter((c) => c.startsWith("compose") && !c.startsWith("compose version"))).toEqual([]);
      },
      T,
    );

    it(
      "API do Supabase ocupada pelo Supabase de OUTRO projeto: recusa e diz qual contêiner está lá",
      async () => {
        const p = criarProjeto();
        const portas = await portasLivres();
        const ocupada = await portaOcupada();
        const r = await executar(p, sistema, "instalar", {
          ...portas,
          CRM_ALQUIMIA_PORTA_SUPABASE_API: String(ocupada),
          FAKE_DOCKER_PUBLICA: JSON.stringify({ [ocupada]: "supabase_kong_outro-sistema" }),
        });
        expect(r.status, r.tudo).not.toBe(0);
        expect(r.tudo).toContain("CRM_ALQUIMIA_PORTA_SUPABASE_API");
        expect(r.tudo).toContain("supabase_kong_outro-sistema");
        expect(npx(p).some((a) => a.includes("start"))).toBe(false);
      },
      T,
    );

    it(
      "a mesma porta para dois serviços é recusada",
      async () => {
        const p = criarProjeto();
        const portas = await portasLivres();
        const r = await executar(p, sistema, "instalar", { ...portas, CRM_ALQUIMIA_PORTA_WORKER: portas.CRM_ALQUIMIA_PORTA_APP });
        expect(r.status, r.tudo).not.toBe(0);
        expect(r.tudo).toMatch(/mais de um servi.o/);
        expect(existsSync(join(p.dir, ".env.local"))).toBe(false);
      },
      T,
    );

    it(
      "porta de serviço ligado no config.toml (Studio) também é conferida",
      async () => {
        const p = criarProjeto();
        const ocupada = await portaOcupada();
        const toml = join(p.dir, "supabase", "config.toml");
        writeFileSync(
          toml,
          readFileSync(toml, "utf8").replace(/\[studio\]\nenabled = false\nport = \d+/, `[studio]\nenabled = true\nport = ${ocupada}`),
        );
        const r = await executar(p, sistema, "instalar", await portasLivres());
        expect(r.status, r.tudo).not.toBe(0);
        expect(r.tudo).toContain(String(ocupada));
        expect(r.tudo).toContain("[studio]");
      },
      T,
    );

    it(
      "portas livres: passa da conferência e chega ao supabase start (versão fixa, pasta certa, só o necessário)",
      async () => {
        const p = criarProjeto();
        const r = await executar(p, sistema, "instalar", { ...(await portasLivres()), FAKE_SUPABASE_START: "1" });
        expect(r.status, r.tudo).not.toBe(0); // o start falso falha de propósito
        expect(r.tudo).not.toMatch(/j. est. em uso/);
        const chamadas = npx(p);
        expect(chamadas.length).toBeGreaterThan(0);
        for (const a of chamadas) {
          expect(a.slice(0, 2), a.join(" ")).toEqual(["--yes", `supabase@${VERSAO_CLI}`]);
          expect(a, a.join(" ")).toContain("--workdir");
        }
        const start = chamadas.find((a) => a.includes("start"))!;
        expect(start[start.indexOf("-x") + 1]).toBe(FORA);
      },
      T,
    );

    it(
      "máquina limpa: Supabase parado NÃO vira 'já está rodando', e o erro do start para o instalador",
      async () => {
        const p = criarProjeto();
        const r = await executar(p, sistema, "instalar", { ...(await portasLivres()), FAKE_SUPABASE_START: "1" });
        expect(r.status, r.tudo).not.toBe(0);
        expect(r.tudo).not.toMatch(/j. est. rodando/);
        expect(r.tudo).toMatch(/supabase start' falhou/);
        // o status e o start chegaram à CLI com o subcomando (o npx.ps1 do Node perde os argumentos)
        const chamadas = npx(p);
        expect(chamadas.some((a) => a.includes("status")), JSON.stringify(chamadas)).toBe(true);
        expect(chamadas.some((a) => a.includes("start")), JSON.stringify(chamadas)).toBe(true);
      },
      T,
    );

    it(
      "CPUs do build inválidas: recusa antes de tudo",
      async () => {
        const p = criarProjeto();
        const r = await executar(p, sistema, "instalar", { ...(await portasLivres()), CRM_ALQUIMIA_BUILD_CPUS: "todas" });
        expect(r.status, r.tudo).not.toBe(0);
        expect(r.tudo).toContain("CRM_ALQUIMIA_BUILD_CPUS");
        expect(r.tudo).toMatch(/Nada foi alterado/);
        expect(existsSync(join(p.dir, ".env.local"))).toBe(false);
      },
      T,
    );

    it(
      "heap do build inválido: recusa antes de tudo",
      async () => {
        const p = criarProjeto();
        const r = await executar(p, sistema, "instalar", { ...(await portasLivres()), CRM_ALQUIMIA_HEAP_BUILD_MB: "muito" });
        expect(r.status, r.tudo).not.toBe(0);
        expect(r.tudo).toContain("CRM_ALQUIMIA_HEAP_BUILD_MB");
        expect(existsSync(join(p.dir, ".env.local"))).toBe(false);
      },
      T,
    );
  });

  describe.skipIf(!disponivel)(`${sistema}: instalação inteira com outro projeto do compose na sessão`, () => {
    it(
      "reinstalação (app e worker já de pé, do próprio CRM): -p e -f explícitos, build um por vez, Realtime pelo nome exato",
      async () => {
        const p = criarProjeto();
        writeFileSync(join(p.dir, "package.json"), JSON.stringify({ name: "x", version: "4.5.6" }));
        const app = await crmDePe();
        const worker = await crmDePe();
        const r = await executar(p, sistema, "instalar", {
          ...(await portasLivres()),
          CRM_ALQUIMIA_PORTA_APP: String(app),
          CRM_ALQUIMIA_PORTA_WORKER: String(worker),
          CRM_ALQUIMIA_HEAP_BUILD_MB: "3072",
          FAKE_DOCKER_PUBLICA: JSON.stringify({ [app]: `${PROJETO}-app-1`, [worker]: `${PROJETO}-worker-1` }),
          FAKE_DOCKER_COMPOSE: conteineres(p.dir, "crm-alquimia", ["app", "worker"]),
          COMPOSE_PROJECT_NAME: "outro-sistema",
          COMPOSE_FILE: "outro-sistema.yml",
          FAKE_NPX_ENV_LOG: join(p.dir, "npx-env.log"),
          FAKE_DOCKER_ENV_LOG: join(p.dir, "docker-env.log"),
        });
        expect(r.status, r.tudo).toBe(0);
        // Segredo do JWT por instalação: gerado no .env.local e entregue a todo comando da CLI que lê o config.
        const envLocal = readFileSync(join(p.dir, ".env.local"), "utf8");
        const segredo = /^CRM_ALQUIMIA_JWT_SECRET=([0-9a-f]{64})\r?$/m.exec(envLocal)?.[1];
        expect(segredo, "CRM_ALQUIMIA_JWT_SECRET no .env.local").toBeTruthy();
        const daCli = readFileSync(join(p.dir, "npx-env.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { args: string[]; jwt: string });
        const leemOConfig = daCli.filter((c) => c.args.includes("start") || c.args.includes("status"));
        expect(leemOConfig.length).toBeGreaterThan(0);
        for (const c of leemOConfig) expect(c.jwt, c.args.join(" ")).toBe(segredo);
        expect(r.tudo).not.toContain(segredo!);
        // A versão da imagem vem do package.json da pasta, gravada no .env.local e passada ao build.
        const versao = "4.5.6";
        expect(envLocal).toContain(`APP_VERSION=${versao}`);
        const builds = readFileSync(join(p.dir, "docker-env.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { versao: string });
        expect(builds.length).toBe(3);
        for (const b of builds) expect(b.versao).toBe(versao);
        const compose = docker(p).filter((c) => c.startsWith("compose") && !c.startsWith("compose version"));
        expect(compose.length).toBeGreaterThan(0);
        for (const c of compose) expect(c).toMatch(/^compose -p crm-alquimia -f docker-compose\.yml --env-file \.env\.local /);
        const fim = compose.map((c) => c.replace(/^compose -p crm-alquimia -f docker-compose\.yml --env-file \.env\.local /, ""));
        expect(fim).toEqual(["build app", "build worker", "build scheduler", "up -d"]);
        expect(r.tudo).toContain("3072");
        expect(docker(p)).toContain("restart supabase_realtime_crm-alquimia");
        expect(docker(p).some((c) => /ps -q --filter name=/.test(c))).toBe(false);
        // o resumo das portas (não são segredo) sai no fim
        expect(r.tudo).toContain(`${app}`);
        expect(r.tudo).toMatch(/Portas usadas/);
        const env = readFileSync(join(p.dir, ".env.local"), "utf8");
        expect(env).toMatch(/^CRM_ALQUIMIA_PROJETO=crm-alquimia$/m);
      },
      T,
    );

    for (const caso of [
      { heap: "1536", cpus: "1", sugere2048: false },
      // 2048 com 1 CPU é a combinação medida, então é o piso que o aviso sugere
      { heap: "2048", cpus: "1", sugere2048: false },
      { heap: "", cpus: "", sugere2048: true },
    ]) {
      it(
        `aviso do build com heap ${caso.heap || "padrão"} e CPUs ${caso.cpus || "padrão"}: memória livre pedida, CPUs no compose, 2048 só se ajudar`,
        async () => {
          const p = criarProjeto();
          const app = await crmDePe();
          const worker = await crmDePe();
          const logEnv = join(p.dir, "docker-env.log");
          const extra: Record<string, string> = {
            ...(await portasLivres()),
            CRM_ALQUIMIA_PORTA_APP: String(app),
            CRM_ALQUIMIA_PORTA_WORKER: String(worker),
            FAKE_DOCKER_PUBLICA: JSON.stringify({ [app]: `${PROJETO}-app-1`, [worker]: `${PROJETO}-worker-1` }),
            FAKE_DOCKER_COMPOSE: conteineres(p.dir, PROJETO, ["app", "worker"]),
            FAKE_DOCKER_ENV_LOG: logEnv,
          };
          if (caso.heap) extra.CRM_ALQUIMIA_HEAP_BUILD_MB = caso.heap;
          if (caso.cpus) extra.CRM_ALQUIMIA_BUILD_CPUS = caso.cpus;
          const r = await executar(p, sistema, "instalar", extra);
          expect(r.status, r.tudo).toBe(0);
          const env = readFileSync(logEnv, "utf8").trim().split("\n").map((l) => JSON.parse(l));
          expect(env.length).toBe(3);
          for (const e of env) {
            expect(e.cpus).toBe(caso.cpus || "2");
            expect(e.heap).toBe(caso.heap || "4096");
          }
          expect(r.tudo).toMatch(/GB de RAM livres/);
          expect(r.tudo).toContain("CRM_ALQUIMIA_BUILD_CPUS");
          if (caso.sugere2048) expect(r.tudo).toContain("CRM_ALQUIMIA_HEAP_BUILD_MB=2048");
          else expect(r.tudo).not.toContain("CRM_ALQUIMIA_HEAP_BUILD_MB=2048");
          // o aviso não volta a sugerir o 3072 de antes da medida
          expect(r.tudo).not.toContain("CRM_ALQUIMIA_HEAP_BUILD_MB=3072");
          expect(r.tudo).not.toMatch(/abaixo de 3072/);
        },
        T,
      );
    }

    it(
      "CPUs e heap do build escritos no .env.local valem (sem variável na sessão)",
      async () => {
        const p = criarProjeto();
        const app = await crmDePe();
        const worker = await crmDePe();
        const logEnv = join(p.dir, "docker-env.log");
        writeFileSync(join(p.dir, ".env.local"), ["CRM_ALQUIMIA_BUILD_CPUS=3", "CRM_ALQUIMIA_HEAP_BUILD_MB=2048", ""].join("\n"));
        const r = await executar(p, sistema, "instalar", {
          ...(await portasLivres()),
          CRM_ALQUIMIA_PORTA_APP: String(app),
          CRM_ALQUIMIA_PORTA_WORKER: String(worker),
          FAKE_DOCKER_PUBLICA: JSON.stringify({ [app]: `${PROJETO}-app-1`, [worker]: `${PROJETO}-worker-1` }),
          FAKE_DOCKER_COMPOSE: conteineres(p.dir, PROJETO, ["app", "worker"]),
          FAKE_DOCKER_ENV_LOG: logEnv,
        });
        expect(r.status, r.tudo).toBe(0);
        const env = readFileSync(logEnv, "utf8").trim().split("\n").map((l) => JSON.parse(l));
        for (const e of env) expect(e).toMatchObject({ cpus: "3", heap: "2048" });
        // a variável da sessão vence o arquivo, como nas portas
        const r2 = await executar(p, sistema, "instalar", {
          CRM_ALQUIMIA_BUILD_CPUS: "1",
          FAKE_DOCKER_PUBLICA: JSON.stringify({ [app]: `${PROJETO}-app-1`, [worker]: `${PROJETO}-worker-1` }),
          FAKE_DOCKER_COMPOSE: conteineres(p.dir, PROJETO, ["app", "worker"]),
          FAKE_DOCKER_ENV_LOG: logEnv,
        });
        expect(r2.status, r2.tudo).toBe(0);
        const ultimo = readFileSync(logEnv, "utf8").trim().split("\n").map((l) => JSON.parse(l)).pop();
        expect(ultimo).toMatchObject({ cpus: "1", heap: "2048" });
      },
      T,
    );

    it(
      ".env.local salvo com CRLF (Bloco de Notas), com aspas e espaços: os valores valem",
      async () => {
        const p = criarProjeto();
        const app = await crmDePe();
        const worker = await crmDePe();
        const logEnv = join(p.dir, "docker-env.log");
        writeFileSync(join(p.dir, ".env.local"), ['CRM_ALQUIMIA_BUILD_CPUS=3', 'CRM_ALQUIMIA_HEAP_BUILD_MB= "2048" ', ''].join("\r\n"));
        const r = await executar(p, sistema, "instalar", {
          ...(await portasLivres()),
          CRM_ALQUIMIA_PORTA_APP: String(app),
          CRM_ALQUIMIA_PORTA_WORKER: String(worker),
          FAKE_DOCKER_PUBLICA: JSON.stringify({ [app]: `${PROJETO}-app-1`, [worker]: `${PROJETO}-worker-1` }),
          FAKE_DOCKER_COMPOSE: conteineres(p.dir, PROJETO, ["app", "worker"]),
          FAKE_DOCKER_ENV_LOG: logEnv,
        });
        expect(r.status, r.tudo).toBe(0);
        const env = readFileSync(logEnv, "utf8").trim().split("\n").map((l) => JSON.parse(l));
        expect(env.length).toBe(3);
        for (const e of env) expect(e).toMatchObject({ cpus: "3", heap: "2048" });
      },
      T,
    );

    it(
      "CRM_ALQUIMIA_PROJETO troca o nome em tudo: compose, config.toml e contêineres do Supabase",
      async () => {
        const p = criarProjeto();
        const app = await crmDePe();
        const worker = await crmDePe();
        const r = await executar(p, sistema, "instalar", {
          ...(await portasLivres()),
          CRM_ALQUIMIA_PORTA_APP: String(app),
          CRM_ALQUIMIA_PORTA_WORKER: String(worker),
          CRM_ALQUIMIA_PROJETO: "crm-teste",
          FAKE_DOCKER_PUBLICA: JSON.stringify({ [app]: "crm-teste-app-1", [worker]: "crm-teste-worker-1" }),
          FAKE_DOCKER_COMPOSE: conteineres(p.dir, "crm-teste", ["app", "worker"]),
        });
        expect(r.status, r.tudo).toBe(0);
        expect(readFileSync(join(p.dir, "supabase", "config.toml"), "utf8")).toMatch(/^project_id = "crm-teste"$/m);
        expect(readFileSync(join(p.dir, ".env.local"), "utf8")).toMatch(/^CRM_ALQUIMIA_PROJETO=crm-teste$/m);
        const compose = docker(p).filter((c) => c.startsWith("compose") && !c.startsWith("compose version"));
        for (const c of compose) expect(c).toMatch(/^compose -p crm-teste /);
        expect(docker(p)).toContain("inspect supabase_db_crm-teste");
        expect(docker(p)).toContain("restart supabase_realtime_crm-teste");
      },
      T,
    );

    it(
      "o dono da porta tem de ser EXATAMENTE este projeto (crm não é dono do contêiner de crm-alquimia)",
      async () => {
        const p = criarProjeto();
        const app = await crmDePe();
        const r = await executar(p, sistema, "instalar", {
          ...(await portasLivres()),
          CRM_ALQUIMIA_PORTA_APP: String(app),
          CRM_ALQUIMIA_PROJETO: "crm",
          FAKE_DOCKER_PUBLICA: JSON.stringify({ [app]: `${PROJETO}-app-1` }),
        });
        expect(r.status, r.tudo).not.toBe(0);
        expect(r.tudo).toContain(`${PROJETO}-app-1`);
      },
      T,
    );

    it(
      "nome de projeto inválido é recusado",
      async () => {
        const p = criarProjeto();
        const r = await executar(p, sistema, "instalar", { ...(await portasLivres()), CRM_ALQUIMIA_PROJETO: "Meu CRM!" });
        expect(r.status, r.tudo).not.toBe(0);
        expect(r.tudo).toContain("CRM_ALQUIMIA_PROJETO");
        expect(existsSync(join(p.dir, ".env.local"))).toBe(false);
      },
      T,
    );
  });

  describe.skipIf(!disponivel)(`${sistema}: o mesmo nome de projeto em OUTRA pasta não é reinstalação`, () => {
    const OUTRA = "C:/crm-a";

    it(
      "contêineres do compose com o mesmo projeto, de outra pasta, mesmo com as portas livres: recusa e sugere CRM_ALQUIMIA_PROJETO",
      async () => {
        const p = criarProjeto();
        const r = await executar(p, sistema, "instalar", {
          ...(await portasLivres()),
          FAKE_DOCKER_COMPOSE: conteineres(OUTRA, "crm-alquimia", ["app", "worker", "evolution"]),
        });
        expect(r.status, r.tudo).not.toBe(0);
        expect(r.tudo).toContain(OUTRA);
        expect(r.tudo).toContain("CRM_ALQUIMIA_PROJETO");
        // A recusa é pelo nome de projeto; o fim não manda "escolher portas" nem sugere a 3100
        expect(r.tudo).not.toMatch(/Escolha portas livres/);
        expect(r.tudo).not.toMatch(/CRM_ALQUIMIA_PORTA_APP ?= ?"?3100/);
        expect(existsSync(join(p.dir, ".env.local"))).toBe(false);
        expect(npx(p).some((a) => a.includes("start"))).toBe(false);
      },
      T,
    );

    it(
      `porta do app com ${PROJETO}-app-1 de OUTRA pasta: não é dono, recusa`,
      async () => {
        const p = criarProjeto();
        const app = await crmDePe();
        const r = await executar(p, sistema, "instalar", {
          ...(await portasLivres()),
          CRM_ALQUIMIA_PORTA_APP: String(app),
          FAKE_DOCKER_PUBLICA: JSON.stringify({ [app]: `${PROJETO}-app-1` }),
          FAKE_DOCKER_COMPOSE: conteineres(OUTRA, "crm-alquimia", ["app"]),
        });
        expect(r.status, r.tudo).not.toBe(0);
        expect(r.tudo).toContain(`${PROJETO}-app-1`);
        expect(r.tudo).toContain(OUTRA);
      },
      T,
    );

    it(
      "clone novo (sem .env.local) com o Supabase do mesmo projeto de pé: é de outra instalação, recusa",
      async () => {
        const p = criarProjeto();
        const api = await portaOcupada();
        const r = await executar(p, sistema, "instalar", {
          ...(await portasLivres()),
          CRM_ALQUIMIA_PORTA_SUPABASE_API: String(api),
          FAKE_DOCKER_PUBLICA: JSON.stringify({ [api]: "supabase_kong_crm-alquimia" }),
        });
        expect(r.status, r.tudo).not.toBe(0);
        expect(r.tudo).toContain("supabase_kong_crm-alquimia");
        expect(r.tudo).toContain("CRM_ALQUIMIA_PROJETO");
      },
      T,
    );

    it(
      "reinstalação completa nesta pasta: Supabase (API e banco) e Evolution do próprio CRM passam",
      async () => {
        const p = criarProjeto();
        const app = await crmDePe();
        const worker = await crmDePe();
        const api = await portaOcupada();
        const db = await portaOcupada();
        const evo = await portaOcupada();
        writeFileSync(join(p.dir, ".env.local"), "CRM_ALQUIMIA_PROJETO=crm-alquimia\n");
        const r = await executar(p, sistema, "instalar", {
          CRM_ALQUIMIA_PORTA_APP: String(app),
          CRM_ALQUIMIA_PORTA_WORKER: String(worker),
          CRM_ALQUIMIA_PORTA_EVOLUTION: String(evo),
          CRM_ALQUIMIA_PORTA_SUPABASE_API: String(api),
          CRM_ALQUIMIA_PORTA_SUPABASE_DB: String(db),
          FAKE_DOCKER_PUBLICA: JSON.stringify({
            [app]: `${PROJETO}-app-1`,
            [worker]: `${PROJETO}-worker-1`,
            [evo]: `${PROJETO}-evolution-1`,
            [api]: "supabase_kong_crm-alquimia",
            [db]: "supabase_db_crm-alquimia",
          }),
          FAKE_DOCKER_COMPOSE: conteineres(p.dir, "crm-alquimia", ["app", "worker", "evolution"]),
          FAKE_DOCKER_VOLUMES: JSON.stringify([
            { nome: `${PROJETO}_evolution_db`, projeto: "crm-alquimia", pasta: p.dir },
            { nome: "supabase_db_crm-alquimia" },
          ]),
        });
        expect(r.status, r.tudo).toBe(0);
        expect(r.tudo).not.toMatch(/j. est. em uso/);
      },
      T,
    );

    it(
      "supabase_db_a_b não é do projeto b (o sufixo tem de ser o nome inteiro do serviço + projeto)",
      async () => {
        const p = criarProjeto();
        const db = await portaOcupada();
        writeFileSync(join(p.dir, ".env.local"), "CRM_ALQUIMIA_PROJETO=b\n");
        const r = await executar(p, sistema, "instalar", {
          ...(await portasLivres()),
          CRM_ALQUIMIA_PORTA_SUPABASE_DB: String(db),
          FAKE_DOCKER_PUBLICA: JSON.stringify({ [db]: "supabase_db_a_b" }),
        });
        expect(r.status, r.tudo).not.toBe(0);
        expect(r.tudo).toContain("supabase_db_a_b");
      },
      T,
    );
  });

  describe.skipIf(!disponivel)(`${sistema}: outra instalação PARADA (só os volumes sobraram)`, () => {
    it(
      "volume do compose do mesmo projeto, de outra pasta: recusa citando a pasta e CRM_ALQUIMIA_PROJETO",
      async () => {
        const p = criarProjeto();
        const r = await executar(p, sistema, "instalar", {
          ...(await portasLivres()),
          FAKE_DOCKER_VOLUMES: JSON.stringify([{ nome: `${PROJETO}_evolution_db`, projeto: "crm-alquimia", pasta: "C:/crm-a" }]),
        });
        expect(r.status, r.tudo).not.toBe(0);
        expect(r.tudo).toContain(`${PROJETO}_evolution_db`);
        expect(r.tudo).toContain("C:/crm-a");
        expect(r.tudo).toContain("CRM_ALQUIMIA_PROJETO");
        expect(existsSync(join(p.dir, ".env.local"))).toBe(false);
        expect(npx(p).some((a) => a.includes("start"))).toBe(false);
      },
      T,
    );

    it(
      "volume do Supabase do mesmo projeto num clone novo (sem .env.local deste projeto): recusa",
      async () => {
        const p = criarProjeto();
        const r = await executar(p, sistema, "instalar", {
          ...(await portasLivres()),
          FAKE_DOCKER_VOLUMES: JSON.stringify([{ nome: "supabase_db_crm-alquimia" }]),
        });
        expect(r.status, r.tudo).not.toBe(0);
        expect(r.tudo).toContain("supabase_db_crm-alquimia");
        expect(r.tudo).toContain("CRM_ALQUIMIA_PROJETO");
      },
      T,
    );

    it(
      "segundo clone com a primeira instalação PARADA, volumes como o Docker Desktop os deixa (sem a pasta): recusa pela regra do .env.local",
      async () => {
        const p = criarProjeto();
        const proj = `${PROJETO}-teste`;
        const configAntes = readFileSync(join(p.dir, "supabase", "config.toml"), "utf8");
        const r = await executar(p, sistema, "instalar", {
          ...(await portasLivres()),
          CRM_ALQUIMIA_PROJETO: proj,
          // como o Docker Desktop lista: os volumes da CLI com project=<proj> e working_dir vazio; o do compose idem
          FAKE_DOCKER_VOLUMES: JSON.stringify([
            { nome: `${proj}_evolution_db`, projeto: proj },
            { nome: `supabase_db_${proj}`, projeto: proj },
            { nome: `supabase_storage_${proj}`, projeto: proj },
          ]),
        });
        expect(r.status, r.tudo).not.toBe(0);
        expect(r.tudo).toMatch(new RegExp(`(supabase_db|supabase_storage|${proj}_evolution_db)`));
        expect(r.tudo).toMatch(/n.o tem o \.env\.local/);
        expect(r.tudo).toContain(`CRM_ALQUIMIA_PROJETO=${proj}-2`);
        // M-r3-2: quem quer recomeçar do zero acha o caminho
        expect(r.tudo).toMatch(/recome.ar do zero/i);
        expect(r.tudo).toContain("README");
        // B7: a recusa é por nome de projeto, não por porta
        expect(r.tudo).not.toMatch(/Escolha portas livres/);
        expect(existsSync(join(p.dir, ".env.local"))).toBe(false);
        expect(readFileSync(join(p.dir, "supabase", "config.toml"), "utf8")).toBe(configAntes);
        expect(npx(p).some((a) => a.includes("start"))).toBe(false);
      },
      T,
    );

    it(
      "o docker não consegue listar volumes e contêineres: recusa alto, em vez de seguir como se não houvesse nada",
      async () => {
        const p = criarProjeto();
        const r = await executar(p, sistema, "instalar", { ...(await portasLivres()), FAKE_DOCKER_FALHA_LISTA: "1" });
        expect(r.status, r.tudo).not.toBe(0);
        expect(r.tudo).toMatch(/N.o consegui (listar|perguntar)/);
        expect(r.tudo).toContain("Cannot connect to the Docker daemon");
        // A última linha fala do Docker, não manda trocar o nome do projeto
        expect(r.tudo).toMatch(/docker ps/);
        expect(r.tudo).not.toMatch(/outro nome em/);
        expect(existsSync(join(p.dir, ".env.local"))).toBe(false);
        expect(npx(p).some((a) => a.includes("start"))).toBe(false);
      },
      T,
    );

    it(
      "o docker falha ao dizer quem publica uma porta ocupada: recusa citando o Docker, não 'outro programa'",
      async () => {
        const p = criarProjeto();
        const ocupada = await portaOcupada();
        const r = await executar(p, sistema, "instalar", {
          ...(await portasLivres()),
          CRM_ALQUIMIA_PORTA_APP: String(ocupada),
          FAKE_DOCKER_FALHA_PUBLISH: "1",
        });
        expect(r.status, r.tudo).not.toBe(0);
        expect(r.tudo).toContain("falha falsa no filtro publish");
        expect(r.tudo).toMatch(/N.o consegui perguntar ao Docker/);
        expect(r.tudo).not.toMatch(/por outro programa/);
      },
      T,
    );

    it(
      "volumes de OUTRO projeto não atrapalham (supabase_db_outro, outro_evolution_db)",
      async () => {
        const p = criarProjeto();
        const r = await executar(p, sistema, "instalar", {
          ...(await portasLivres()),
          FAKE_SUPABASE_START: "1",
          FAKE_DOCKER_VOLUMES: JSON.stringify([
            { nome: "supabase_db_outro" },
            { nome: "outro_evolution_db", projeto: "outro", pasta: "C:/outro" },
            { nome: `supabase_db_${PROJETO}-velho` },
          ]),
        });
        // chega ao supabase start (que o npx falso faz falhar): a conferência passou
        expect(npx(p).some((a) => a.includes("start")), r.tudo).toBe(true);
      },
      T,
    );
  });

  describe.skipIf(!disponivel)(`${sistema}: outro programa escutando em todas as interfaces`, () => {
    for (const host of ["0.0.0.0", "::"]) {
      it(
        `listener em ${host} na porta do worker é recusado`,
        async () => {
          let ocupada: number;
          try {
            ocupada = await portaOcupada(host);
          } catch {
            return; // sem IPv6 nesta máquina: nada a medir
          }
          const p = criarProjeto();
          const r = await executar(p, sistema, "instalar", { ...(await portasLivres()), CRM_ALQUIMIA_PORTA_WORKER: String(ocupada) });
          expect(r.status, r.tudo).not.toBe(0);
          expect(r.tudo).toContain(String(ocupada));
          expect(r.tudo).toContain("CRM_ALQUIMIA_PORTA_WORKER");
        },
        T,
      );
    }
  });

  describe.skipIf(!disponivel)(`${sistema}: parar só mexe no próprio projeto`, () => {
    it(
      "com COMPOSE_PROJECT_NAME de outro projeto na sessão: down com -p/-f explícitos e stop com --project-id",
      async () => {
        const p = criarProjeto();
        writeFileSync(join(p.dir, ".env.local"), "CRM_ALQUIMIA_PORTA_APP=3100\n");
        const r = await executar(p, sistema, "parar", { COMPOSE_PROJECT_NAME: "outro-sistema", COMPOSE_FILE: "outro.yml" });
        expect(r.status, r.tudo).toBe(0);
        expect(docker(p)).toContain("compose -p crm-alquimia -f docker-compose.yml --env-file .env.local down");
        const stop = npx(p).find((a) => a.includes("stop"))!;
        expect(stop.slice(0, 2)).toEqual(["--yes", `supabase@${VERSAO_CLI}`]);
        expect(stop[stop.indexOf("--project-id") + 1]).toBe("crm-alquimia");
        expect(stop).not.toContain("--no-backup");
        expect(stop).not.toContain("--all");
      },
      T,
    );

    it(
      "supabase stop que falha: o parar sai com código ≠ 0 e não diz 'Parado'",
      async () => {
        const p = criarProjeto();
        writeFileSync(join(p.dir, ".env.local"), "CRM_ALQUIMIA_PROJETO=crm-alquimia\n");
        const r = await executar(p, sistema, "parar", { FAKE_SUPABASE_STOP: "1" });
        expect(r.status, r.tudo).not.toBe(0);
        expect(r.tudo).toMatch(/supabase stop/);
        expect(r.tudo).not.toMatch(/==> Parado\./);
      },
      T,
    );

    it(
      "o projeto vem do .env.local DESTA pasta (a variável da sessão não redireciona o parar)",
      async () => {
        const p = criarProjeto();
        writeFileSync(join(p.dir, ".env.local"), "CRM_ALQUIMIA_PROJETO=crm-teste\n");
        const r = await executar(p, sistema, "parar", { CRM_ALQUIMIA_PROJETO: "outro-sistema" });
        expect(r.status, r.tudo).toBe(0);
        expect(docker(p)).toContain("compose -p crm-teste -f docker-compose.yml --env-file .env.local down");
        const stop = npx(p).find((a) => a.includes("stop"))!;
        expect(stop[stop.indexOf("--project-id") + 1]).toBe("crm-teste");
      },
      T,
    );

    it(
      "o stop recebe o segredo do JWT do .env.local (a CLI lê o config.toml), sem imprimi-lo",
      async () => {
        const p = criarProjeto();
        const segredo = "ab".repeat(32);
        writeFileSync(join(p.dir, ".env.local"), ["CRM_ALQUIMIA_PROJETO=crm-alquimia", `CRM_ALQUIMIA_JWT_SECRET=${segredo}`, ""].join("\n"));
        const logEnv = join(p.dir, "npx-env.log");
        const r = await executar(p, sistema, "parar", { FAKE_NPX_ENV_LOG: logEnv });
        expect(r.status, r.tudo).toBe(0);
        const daCli = readFileSync(logEnv, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { args: string[]; jwt: string });
        const stop = daCli.find((c) => c.args.includes("stop"));
        expect(stop?.jwt).toBe(segredo);
        expect(r.tudo).not.toContain(segredo);
      },
      T,
    );
  });
}

describe.skipIf(!temPowerShell)("Programa-Nativo escolhe o executável pela extensão, nunca pela ordem", () => {
  function rodar(pastas: string[]) {
    const p = criarProjeto();
    const harness = join(p.dir, "harness-m3.ps1");
    writeFileSync(
      harness,
      "\uFEFF" +
        [
          `. "${join(p.dir, "scripts", "lib", "instalar-env.ps1")}"`,
          `$env:PATH = "${pastas.join(";")}"`,
          "try { Write-Output (\"RESOLVIDO=\" + (Programa-Nativo \"npx\")) } catch { Write-Output (\"ERRO=\" + $_.Exception.Message) }",
          "",
        ].join("\r\n"),
      "utf8",
    );
    return spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", harness], { cwd: p.dir, encoding: "utf8" });
  }
  const pasta = (arquivos: string[]) => {
    const d = mkdtempSync(join(tmpdir(), "crm-npx-"));
    pastas.push(d);
    for (const a of arquivos) writeFileSync(join(d, a), a.endsWith(".cmd") ? "@echo off\r\n" : "# falso\n");
    return d;
  };

  it("o npx sem extensão (o script de shell do Node) e o npx.ps1 vêm antes no PATH: pega o npx.cmd", () => {
    const a = pasta(["npx", "npx.ps1"]);
    const b = pasta(["npx.cmd"]);
    const r = rodar([a, b]);
    expect(r.stdout, r.stderr).toContain(`RESOLVIDO=${join(b, "npx.cmd")}`);
  });

  it("só existe o npx.ps1: falha alto, citando o .ps1 e CRM_ALQUIMIA_SUPABASE_CLI (em vez de voltar ao B1 calado)", () => {
    const c = pasta(["npx.ps1"]);
    const r = rodar([c]);
    expect(r.stdout, r.stderr).toMatch(/^ERRO=/m);
    expect(r.stdout).toContain("npx.ps1");
    expect(r.stdout).toContain("CRM_ALQUIMIA_SUPABASE_CLI");
  });
});

/**
 * O build do app pede cerca de 4 GB na VM do Docker. Com o Supabase de pé ao lado,
 * a instalação limpa não coube numa passada. As imagens saem ANTES do `supabase start`, e numa
 * reinstalação com o Supabase deste CRM de pé ele para (sem apagar dados) durante o build.
 */
/**
 * Uma reinstalação que já tinha as chaves desta versão: o segredo do JWT, as chaves novas da API e a chave
 * de assinatura das sessões (o caso de cada uma nova tem teste próprio).
 */
const SEGREDO_JA_GRAVADO = "cd".repeat(32);
const SECRETA_JA_GRAVADA = `sb_secret_${"ef".repeat(16)}`;
function jaTinhaSegredo(p: Projeto): void {
  writeFileSync(
    join(p.dir, ".env.local"),
    [
      `CRM_ALQUIMIA_JWT_SECRET=${SEGREDO_JA_GRAVADO}`,
      `CRM_ALQUIMIA_PUBLISHABLE_KEY=sb_publishable_${"ab".repeat(16)}`,
      `CRM_ALQUIMIA_SECRET_KEY=${SECRETA_JA_GRAVADA}`,
      "",
    ].join("\n"),
  );
  jaTinhaChaveDeAssinatura(p);
}
/** Uma chave de assinatura já gerada (a forma da CLI; o material é falso). */
const CHAVE_JA_GRAVADA = JSON.stringify([
  { kty: "EC", kid: "kid-que-ja-existia", use: "sig", key_ops: ["sign", "verify"], alg: "ES256", ext: true, d: "d-que-ja-existia", crv: "P-256", x: "x", y: "y" },
]);
function jaTinhaChaveDeAssinatura(p: Projeto): void {
  writeFileSync(join(p.dir, "supabase", "signing_keys.json"), CHAVE_JA_GRAVADA);
}

function linhaDoTempo(arquivo: string): string[] {
  return readFileSync(arquivo, "utf8")
    .split("\n")
    .flatMap((l) => {
      const build = / build (app|worker|scheduler)$/.exec(l);
      if (l.startsWith("docker compose") && build) return [`build ${build[1]}`];
      if (l.startsWith("docker compose") && / up -d$/.test(l)) return ["up -d"];
      if (l.startsWith("npx ") && / start( |$)/.test(l)) return ["supabase start"];
      if (l.startsWith("npx ") && / stop( |$)/.test(l)) return ["supabase stop"];
      return [];
    });
}

for (const [sistema, disponivel] of sistemas) {
  describe.skipIf(!disponivel)(`${sistema}: as imagens saem ANTES do Supabase subir`, () => {
    async function instalar(p: Projeto, extra: Record<string, string>) {
      const app = await crmDePe();
      const worker = await crmDePe();
      return executar(p, sistema, "instalar", {
        ...(await portasLivres()),
        CRM_ALQUIMIA_PORTA_APP: String(app),
        CRM_ALQUIMIA_PORTA_WORKER: String(worker),
        FAKE_DOCKER_PUBLICA: JSON.stringify({ [app]: `${PROJETO}-app-1`, [worker]: `${PROJETO}-worker-1` }),
        FAKE_DOCKER_COMPOSE: conteineres(p.dir, PROJETO, ["app", "worker"]),
        FAKE_ORDEM_LOG: join(p.dir, "ordem.log"),
        FAKE_SUPABASE_ESTADO: join(p.dir, "supabase-estado"),
        ...extra,
      });
    }

    it(
      "instalação limpa: build de app, worker e scheduler, só depois o supabase start, e o compose up por último",
      async () => {
        const p = criarProjeto();
        const r = await instalar(p, {});
        expect(r.status, r.tudo).toBe(0);
        expect(linhaDoTempo(join(p.dir, "ordem.log"))).toEqual([
          "build app",
          "build worker",
          "build scheduler",
          "supabase start",
          "up -d",
        ]);
        // os segredos que o compose interpola já estavam no .env.local na hora do build, e ficam
        const env = readFileSync(join(p.dir, ".env.local"), "utf8");
        for (const k of ["INTERNAL_SECRET", "SRH_TOKEN", "EVOLUTION_DB_PASSWORD", "EVOLUTION_API_KEY", "EVOLUTION_WEBHOOK_TOKEN"]) {
          expect(env).toMatch(new RegExp(`^${k}=[0-9a-f]{64}$`, "m"));
        }
        expect(env).toMatch(/^NEXT_PUBLIC_SUPABASE_ANON_KEY=anon-falsa$/m);
      },
      T,
    );

    it(
      "reinstalação com o Supabase deste CRM de pé e pouca memória: avisa, para (sem apagar dados), constrói e sobe de novo",
      async () => {
        const p = criarProjeto();
        writeFileSync(join(p.dir, "supabase-estado"), "de-pe");
        jaTinhaSegredo(p);
        const r = await instalar(p, { CRM_ALQUIMIA_MEMORIA_LIVRE_MB: "2000" });
        expect(r.status, r.tudo).toBe(0);
        expect(linhaDoTempo(join(p.dir, "ordem.log"))).toEqual([
          "supabase stop",
          "build app",
          "build worker",
          "build scheduler",
          "supabase start",
          "up -d",
        ]);
        const stop = npx(p).find((a) => a.includes("stop"))!;
        expect(stop[stop.indexOf("--project-id") + 1]).toBe(PROJETO);
        expect(stop).not.toContain("--no-backup");
        expect(stop).not.toContain("--all");
        // O aviso de que o CRM fica fora do ar vem na tela, e o resultado depois
        expect(r.tudo).toMatch(/CRM fica fora do ar/);
        expect(r.tudo).toMatch(/Supabase de volta/);
      },
      T,
    );

    // O stop só quando falta memória, e o Supabase sempre volta.
    it(
      "reinstalação com memória de sobra (modo auto): o Supabase fica de pé e o CRM não sai do ar",
      async () => {
        const p = criarProjeto();
        writeFileSync(join(p.dir, "supabase-estado"), "de-pe");
        jaTinhaSegredo(p);
        const r = await instalar(p, { CRM_ALQUIMIA_MEMORIA_LIVRE_MB: "16000" });
        expect(r.status, r.tudo).toBe(0);
        expect(linhaDoTempo(join(p.dir, "ordem.log"))).toEqual(["build app", "build worker", "build scheduler", "up -d"]);
        expect(r.tudo).not.toMatch(/CRM fica fora do ar/);
        expect(r.tudo).not.toMatch(/sess.{1,2}es abertas podem pedir novo login/);
        // o segredo que já existia fica o mesmo
        expect(readFileSync(join(p.dir, ".env.local"), "utf8")).toContain(`CRM_ALQUIMIA_JWT_SECRET=${SEGREDO_JA_GRAVADO}`);
      },
      T,
    );

    // Uma instalação de antes do segredo por instalação: os contêineres assinam com o segredo de
    // demonstração. Sem reiniciar, as chaves novas do `status -o env` não batem com o que está rodando.
    it(
      "reinstalação com o Supabase de pé e o segredo do JWT NOVO (memória de sobra): para, avisa que as sessões caem e sobe com o segredo",
      async () => {
        const p = criarProjeto();
        writeFileSync(join(p.dir, "supabase-estado"), "de-pe");
        const logEnv = join(p.dir, "npx-env.log");
        const r = await instalar(p, { CRM_ALQUIMIA_MEMORIA_LIVRE_MB: "16000", FAKE_NPX_ENV_LOG: logEnv });
        expect(r.status, r.tudo).toBe(0);
        expect(linhaDoTempo(join(p.dir, "ordem.log"))).toEqual([
          "supabase stop",
          "build app",
          "build worker",
          "build scheduler",
          "supabase start",
          "up -d",
        ]);
        expect(r.tudo).toMatch(/sess.{1,2}es abertas podem pedir novo login/);
        const segredo = /^CRM_ALQUIMIA_JWT_SECRET=([0-9a-f]{64})\r?$/m.exec(readFileSync(join(p.dir, ".env.local"), "utf8"))?.[1];
        expect(segredo).toBeTruthy();
        const daCli = readFileSync(logEnv, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { args: string[]; jwt: string });
        const start = daCli.find((c) => c.args.includes("start"));
        expect(start?.jwt).toBe(segredo);
        expect(r.tudo).not.toContain(segredo!);
      },
      T,
    );

    it(
      "pouca memória no modo auto e nada escolhido para o build: 1 CPU e 2048 MB, dito na tela",
      async () => {
        const p = criarProjeto();
        const logEnv = join(p.dir, "docker-env.log");
        const r = await instalar(p, { CRM_ALQUIMIA_MEMORIA_LIVRE_MB: "2000", FAKE_DOCKER_ENV_LOG: logEnv });
        expect(r.status, r.tudo).toBe(0);
        const builds = readFileSync(logEnv, "utf8").trim().split("\n").map((l) => JSON.parse(l));
        expect(builds.length).toBe(3);
        for (const b of builds) expect(b).toMatchObject({ cpus: "1", heap: "2048" });
        expect(r.tudo).toMatch(/1 CPU e 2048 MB/);
        // a escolha automática não vira escolha do usuário no .env.local
        const env = readFileSync(join(p.dir, ".env.local"), "utf8");
        expect(env).not.toMatch(/^CRM_ALQUIMIA_BUILD_CPUS=/m);
        expect(env).not.toMatch(/^CRM_ALQUIMIA_HEAP_BUILD_MB=/m);
      },
      T,
    );

    const casosDoUsuario: Array<{ nome: string; extra: Record<string, string>; arquivo: string; cpus: string; heap: string }> = [
      { nome: "CPUs na sessão", extra: { CRM_ALQUIMIA_BUILD_CPUS: "2" }, arquivo: "", cpus: "2", heap: "4096" },
      { nome: "heap no .env.local", extra: {}, arquivo: "CRM_ALQUIMIA_HEAP_BUILD_MB=3072\n", cpus: "2", heap: "3072" },
      { nome: "modo nunca", extra: { CRM_ALQUIMIA_PARAR_BANCO_NO_BUILD: "nunca" }, arquivo: "", cpus: "2", heap: "4096" },
    ];
    for (const caso of casosDoUsuario) {
      it(
        `pouca memória com ${caso.nome}: o valor do usuário vence e nada é trocado sozinho`,
        async () => {
          const p = criarProjeto();
          if (caso.arquivo) writeFileSync(join(p.dir, ".env.local"), caso.arquivo);
          const logEnv = join(p.dir, "docker-env.log");
          const r = await instalar(p, { CRM_ALQUIMIA_MEMORIA_LIVRE_MB: "2000", FAKE_DOCKER_ENV_LOG: logEnv, ...caso.extra });
          expect(r.status, r.tudo).toBe(0);
          const builds = readFileSync(logEnv, "utf8").trim().split("\n").map((l) => JSON.parse(l));
          for (const b of builds) expect(b).toMatchObject({ cpus: caso.cpus, heap: caso.heap });
          expect(r.tudo).not.toMatch(/1 CPU e 2048 MB/);
        },
        T,
      );
    }

    // No Mac (e no Windows) o build roda na VM do Docker, que tem teto próprio. Com o computador
    // folgado e a VM pequena, vale a menor das duas medidas.
    it(
      "reinstalação com o computador folgado e a VM do Docker pequena (modo auto): o Supabase para",
      async () => {
        const p = criarProjeto();
        writeFileSync(join(p.dir, "supabase-estado"), "de-pe");
        jaTinhaSegredo(p);
        const r = await instalar(p, { CRM_ALQUIMIA_MEMORIA_LIVRE_MB: "16000", FAKE_DOCKER_MEMTOTAL: String(4096 * 1024 * 1024) });
        expect(r.status, r.tudo).toBe(0);
        expect(linhaDoTempo(join(p.dir, "ordem.log"))[0]).toBe("supabase stop");
        expect(r.tudo).toMatch(/4096 MB/);
        expect(r.tudo).toMatch(/VM do Docker/);
      },
      T,
    );

    it(
      "reinstalação com o computador e a VM do Docker folgados (modo auto): o Supabase fica de pé",
      async () => {
        const p = criarProjeto();
        writeFileSync(join(p.dir, "supabase-estado"), "de-pe");
        jaTinhaSegredo(p);
        const r = await instalar(p, { CRM_ALQUIMIA_MEMORIA_LIVRE_MB: "16000", FAKE_DOCKER_MEMTOTAL: String(12288 * 1024 * 1024) });
        expect(r.status, r.tudo).toBe(0);
        expect(linhaDoTempo(join(p.dir, "ordem.log"))).not.toContain("supabase stop");
        expect(r.tudo).toMatch(/12288 MB/);
      },
      T,
    );

    it(
      "CRM_ALQUIMIA_PARAR_BANCO_NO_BUILD=nunca: com pouca memória o Supabase também fica de pé",
      async () => {
        const p = criarProjeto();
        writeFileSync(join(p.dir, "supabase-estado"), "de-pe");
        jaTinhaSegredo(p);
        const r = await instalar(p, { CRM_ALQUIMIA_MEMORIA_LIVRE_MB: "1000", CRM_ALQUIMIA_PARAR_BANCO_NO_BUILD: "nunca" });
        expect(r.status, r.tudo).toBe(0);
        expect(linhaDoTempo(join(p.dir, "ordem.log"))).not.toContain("supabase stop");
      },
      T,
    );

    it(
      "reinstalação com o Supabase parado pelo instalador e build que falha: o Supabase é religado",
      async () => {
        const p = criarProjeto();
        writeFileSync(join(p.dir, "supabase-estado"), "de-pe");
        jaTinhaSegredo(p);
        const r = await instalar(p, { CRM_ALQUIMIA_PARAR_BANCO_NO_BUILD: "sempre", FAKE_DOCKER_FALHA_BUILD: "app" });
        expect(r.status, r.tudo).not.toBe(0);
        expect(r.tudo).toMatch(/constru..o da imagem 'app' falhou/);
        expect(linhaDoTempo(join(p.dir, "ordem.log"))).toEqual(["supabase stop", "build app", "supabase start"]);
        expect(readFileSync(join(p.dir, "supabase-estado"), "utf8")).toBe("de-pe");
        expect(r.tudo).toMatch(/Supabase de volta/);
        // as migrations voltam ao lugar depois do start do religamento
        expect(existsSync(join(p.dir, "supabase", ".migracoes-fora"))).toBe(false);
      },
      T,
    );

    it(
      "valor inválido em CRM_ALQUIMIA_PARAR_BANCO_NO_BUILD: para antes de tocar em qualquer coisa",
      async () => {
        const p = criarProjeto();
        const r = await instalar(p, { CRM_ALQUIMIA_PARAR_BANCO_NO_BUILD: "talvez" });
        expect(r.status, r.tudo).not.toBe(0);
        expect(r.tudo).toMatch(/CRM_ALQUIMIA_PARAR_BANCO_NO_BUILD=talvez/);
        expect(r.tudo).toMatch(/Nada foi alterado/);
        expect(existsSync(join(p.dir, "ordem.log"))).toBe(false);
      },
      T,
    );

    it(
      "build que falha: o Supabase nem sobe",
      async () => {
        const p = criarProjeto();
        const r = await instalar(p, { FAKE_DOCKER_FALHA_BUILD: "app" });
        expect(r.status, r.tudo).not.toBe(0);
        expect(r.tudo).toMatch(/constru..o da imagem 'app' falhou/);
        expect(npx(p).some((a) => a.includes("start"))).toBe(false);
      },
      T,
    );
  });
}

// O `supabase start` preso depois de uma interrupção, o build que segue
// depois de interrompido e a versão instalada gravada no banco.
for (const [sistema, disponivel] of sistemas) {
  describe.skipIf(!disponivel)(`${sistema}: start preso, build interrompido e versão no banco`, () => {
    async function instalar(p: Projeto, extra: Record<string, string>) {
      const app = await crmDePe();
      const worker = await crmDePe();
      return executar(p, sistema, "instalar", {
        ...(await portasLivres()),
        CRM_ALQUIMIA_PORTA_APP: String(app),
        CRM_ALQUIMIA_PORTA_WORKER: String(worker),
        FAKE_DOCKER_PUBLICA: JSON.stringify({ [app]: `${PROJETO}-app-1`, [worker]: `${PROJETO}-worker-1` }),
        FAKE_DOCKER_COMPOSE: conteineres(p.dir, PROJETO, ["app", "worker"]),
        FAKE_ORDEM_LOG: join(p.dir, "ordem.log"),
        FAKE_SUPABASE_ESTADO: join(p.dir, "supabase-estado"),
        FAKE_SUPABASE_START_CONTADOR: join(p.dir, "starts"),
        ...extra,
      });
    }

    it(
      "o start falha uma vez sem mensagem: o instalador faz UM stop do projeto (sem apagar dados) e um start novo, e segue",
      async () => {
        const p = criarProjeto();
        const r = await instalar(p, { FAKE_SUPABASE_START_FALHAS: "1" });
        expect(r.status, r.tudo).toBe(0);
        expect(linhaDoTempo(join(p.dir, "ordem.log"))).toEqual([
          "build app",
          "build worker",
          "build scheduler",
          "supabase start",
          "supabase stop",
          "supabase start",
          "up -d",
        ]);
        const stop = npx(p).find((a) => a.includes("stop"))!;
        expect(stop[stop.indexOf("--project-id") + 1]).toBe(PROJETO);
        expect(stop).not.toContain("--no-backup");
        expect(stop).not.toContain("--all");
        expect(r.tudo).toMatch(/Tentando destravar uma vez/);
      },
      T,
    );

    it(
      "o start falha de novo depois do stop: para com o comando parar e as últimas linhas do erro",
      async () => {
        const p = criarProjeto();
        const r = await instalar(p, { FAKE_SUPABASE_START_FALHAS: "2", FAKE_SUPABASE_START_MSG: "erro falso do start: porta presa" });
        expect(r.status, r.tudo).not.toBe(0);
        expect(linhaDoTempo(join(p.dir, "ordem.log")).slice(-3)).toEqual(["supabase start", "supabase stop", "supabase start"]);
        expect(linhaDoTempo(join(p.dir, "ordem.log"))).not.toContain("up -d");
        expect(r.tudo).toMatch(/falhou duas vezes/);
        expect(r.tudo).toMatch(/scripts[\\/]parar\.(sh|ps1)/);
        expect(r.tudo).toMatch(/.ltimas linhas do erro/);
        expect(r.tudo).toMatch(/erro falso do start: porta presa/);
        expect(r.tudo).not.toMatch(/Rode o instalador de novo e leia a mensagem acima/);
      },
      T,
    );

    it(
      "as duas tentativas falham por motivos diferentes: a mensagem final mostra o erro de cada uma",
      async () => {
        const p = criarProjeto();
        const r = await instalar(p, { FAKE_SUPABASE_START_FALHAS: "2", FAKE_SUPABASE_START_MSG: "erro falso da tentativa {n}" });
        expect(r.status, r.tudo).not.toBe(0);
        const final = r.tudo.slice(r.tudo.search(/falhou duas vezes/));
        expect(final).toMatch(/primeira tentativa/i);
        expect(final).toContain("erro falso da tentativa 1");
        expect(final).toMatch(/segunda tentativa/i);
        expect(final).toContain("erro falso da tentativa 2");
      },
      T,
    );

    it(
      "o start falha mudo duas vezes: a mensagem diz que ele não escreveu nada",
      async () => {
        const p = criarProjeto();
        const r = await instalar(p, { FAKE_SUPABASE_START_FALHAS: "2" });
        expect(r.status, r.tudo).not.toBe(0);
        expect(r.tudo).toMatch(/n.o escreveu nenhuma mensagem/);
      },
      T,
    );

    it(
      "o religamento depois de um build que falha também destrava o start preso",
      async () => {
        const p = criarProjeto();
        writeFileSync(join(p.dir, "supabase-estado"), "de-pe");
        jaTinhaSegredo(p);
        const r = await instalar(p, {
          CRM_ALQUIMIA_PARAR_BANCO_NO_BUILD: "sempre",
          FAKE_DOCKER_FALHA_BUILD: "app",
          FAKE_SUPABASE_START_FALHAS: "1",
        });
        expect(r.status, r.tudo).not.toBe(0);
        expect(linhaDoTempo(join(p.dir, "ordem.log"))).toEqual([
          "supabase stop",
          "build app",
          "supabase start",
          "supabase stop",
          "supabase start",
        ]);
        expect(r.tudo).toMatch(/Supabase de volta/);
        expect(existsSync(join(p.dir, "supabase", ".migracoes-fora"))).toBe(false);
      },
      T,
    );

    it(
      "build que falha com o Supabase parado: avisa que um build pode seguir no Docker e como conferir, ANTES de religar",
      async () => {
        const p = criarProjeto();
        writeFileSync(join(p.dir, "supabase-estado"), "de-pe");
        jaTinhaSegredo(p);
        const r = await instalar(p, { CRM_ALQUIMIA_PARAR_BANCO_NO_BUILD: "sempre", FAKE_DOCKER_FALHA_BUILD: "app" });
        expect(r.status, r.tudo).not.toBe(0);
        const aviso = r.tudo.search(/um build interrompido pode seguir compilando dentro do Docker/);
        expect(aviso, r.tudo).toBeGreaterThan(-1);
        expect(r.tudo).toMatch(/docker buildx history ls/);
        expect(aviso).toBeLessThan(r.tudo.indexOf("Religando o Supabase"));
        // nada global: nem prune, nem comando de builder que atinja outros projetos
        expect(docker(p).some((l) => /prune|buildx (rm|stop)/.test(l))).toBe(false);
      },
      T,
    );

    it(
      "grava no banco a versão do package.json depois do schema",
      async () => {
        const p = criarProjeto();
        writeFileSync(join(p.dir, "package.json"), JSON.stringify({ name: "x", version: "9.8.7" }));
        const r = await instalar(p, {});
        expect(r.status, r.tudo).toBe(0);
        const linhas = docker(p);
        const gravaRe = new RegExp(`^exec supabase_db_${PROJETO} psql .*update public\\.system_version set current_version = '9\\.8\\.7'`);
        const grava = linhas.findIndex((l) => gravaRe.test(l));
        expect(grava, linhas.join("\n")).toBeGreaterThan(-1);
        expect(grava).toBeGreaterThan(linhas.findIndex((l) => /-f \/tmp\/baseline\.sql/.test(l)));
      },
      T,
    );

    it(
      "versão com caractere estranho no package.json não vai para o SQL, e a instalação segue",
      async () => {
        const p = criarProjeto();
        writeFileSync(join(p.dir, "package.json"), JSON.stringify({ name: "x", version: "1.0'; drop table x; --" }));
        const r = await instalar(p, {});
        expect(r.status, r.tudo).toBe(0);
        expect(docker(p).some((l) => /system_version/.test(l))).toBe(false);
      },
      T,
    );
  });
}

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
const OUTROS_NA_ACL = /Everyone|BUILTIN\\Users|Authenticated Users|Todos|Usu.rios/i;

/**
 * A chave que assina as sessões é desta instalação: gerada uma vez pela própria CLI (`gen signing-key`),
 * num arquivo só do dono, nunca impressa, mantida nas reinstalações. Numa instalação de antes dela, a
 * reinstalação gera a chave, reinicia o Supabase (as sessões caem, com aviso) e regrava as chaves do app.
 */
for (const [sistema, disponivel] of sistemas) {
  describe.skipIf(!disponivel)(`${sistema}: chave de assinatura das sessões e chaves novas da API por instalação`, () => {
    async function instalar(p: Projeto, extra: Record<string, string>, api?: number) {
      const app = await crmDePe();
      const worker = await crmDePe();
      const publica: Record<string, string> = { [app]: `${PROJETO}-app-1`, [worker]: `${PROJETO}-worker-1` };
      if (api) publica[api] = `supabase_kong_${PROJETO}`;
      return executar(p, sistema, "instalar", {
        ...(await portasLivres()),
        ...(api ? { CRM_ALQUIMIA_PORTA_SUPABASE_API: String(api) } : {}),
        CRM_ALQUIMIA_PORTA_APP: String(app),
        CRM_ALQUIMIA_PORTA_WORKER: String(worker),
        FAKE_DOCKER_PUBLICA: JSON.stringify(publica),
        FAKE_DOCKER_COMPOSE: conteineres(p.dir, PROJETO, ["app", "worker"]),
        FAKE_ORDEM_LOG: join(p.dir, "ordem.log"),
        FAKE_SUPABASE_ESTADO: join(p.dir, "supabase-estado"),
        FAKE_SUPABASE_START_CONTADOR: join(p.dir, "starts"),
        FAKE_NPX_ENV_LOG: join(p.dir, "npx-env.log"),
        ...extra,
      });
    }
    const daCli = (p: Projeto) =>
      readFileSync(join(p.dir, "npx-env.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { args: string[]; jwt: string; secreta: string; publica: string });
    const chave = (p: Projeto) => join(p.dir, "supabase", "signing_keys.json");
    const envDaCli = (p: Projeto) => join(p.dir, "supabase", ".env");
    const marcador = (p: Projeto) => join(p.dir, "supabase", ".env.pendente");
    const ordem = (p: Projeto) => linhaDoTempo(join(p.dir, "ordem.log"));
    /** O `kid` da chave que vem dentro da CLI 2.120 (público, igual em toda instalação). */
    const KID_DA_CLI = "b81269f1-21d8-4f2e-b719-c2240a840d90";
    /**
     * O JWKS do Auth (`/auth/v1/.well-known/jwks.json`), como o Kong o serve. "da-instalacao": as chaves do
     * signing_keys.json; "velho-ate-reiniciar": a chave da CLI até o primeiro `supabase start`; "sempre-velho": a
     * da CLI sempre.
     */
    async function jwksDePe(p: Projeto, modo: "da-instalacao" | "velho-ate-reiniciar" | "sempre-velho"): Promise<number> {
      const s = createServer((req, res) => {
        const arq = join(p.dir, "starts");
        const starts = existsSync(arq) ? Number(readFileSync(arq, "utf8")) : 0;
        const velho = modo === "sempre-velho" || (modo === "velho-ate-reiniciar" && starts === 0);
        const kids = velho ? [KID_DA_CLI] : (JSON.parse(readFileSync(chave(p), "utf8")) as Array<{ kid: string }>).map((c) => c.kid);
        if (req.url !== "/auth/v1/.well-known/jwks.json") {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ keys: kids.map((kid) => ({ kty: "EC", kid, alg: "ES256", crv: "P-256", x: "x", y: "y" })) }));
      });
      servidores.push(s);
      await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
      return (s.address() as AddressInfo).port;
    }
    // Segredos falsos montados na hora (o portão de dados não vê nenhum deles inteiro no código).
    const JWT_FALSO = ["eyJhbGciOiJFUzI1NiJ9", "eyJyb2xlIjoic2VydmljZV9yb2xlIn0", "YXNzaW5hdHVyYS1mYWxzYS1kby10ZXN0ZQ"].join(".");
    const SECRETA_FALSA = "sb_" + "secret_" + "f00d".repeat(16);
    const D_FALSO = "d-" + "Q".repeat(41);
    const HEX_FALSO = "c0de".repeat(16);

    it(
      "instalação limpa: a CLI gera a chave (com --append, num arquivo que já existe) ANTES do primeiro status, e nada dela vai à tela",
      async () => {
        const p = criarProjeto();
        const r = await instalar(p, {});
        expect(r.status, r.tudo).toBe(0);
        const chamadas = npx(p);
        const gen = chamadas.findIndex((a) => a.includes("gen") && a.includes("signing-key"));
        expect(gen, JSON.stringify(chamadas)).toBeGreaterThan(-1);
        expect(chamadas[gen]).toContain("--append");
        expect(chamadas[gen]).toContain("--workdir");
        expect(gen).toBeLessThan(chamadas.findIndex((a) => a.includes("status")));
        expect(chamadas.filter((a) => a.includes("signing-key"))).toHaveLength(1);
        const chaves = JSON.parse(readFileSync(chave(p), "utf8")) as Array<{ kid: string; d: string }>;
        expect(chaves).toHaveLength(1);
        expect(r.tudo).not.toContain("d-privada-falsa-nunca-na-tela");
        expect(r.tudo).not.toContain(String(chaves[0]?.kid));
        expect(r.tudo).not.toContain("chave-do-stdout-nunca-na-tela");
      },
      T,
    );

    it(
      "instalação limpa: chaves sb_publishable_/sb_secret_ próprias no .env.local e no ambiente de todo start, sem ir à tela",
      async () => {
        const p = criarProjeto();
        const r = await instalar(p, {});
        expect(r.status, r.tudo).toBe(0);
        const env = readFileSync(join(p.dir, ".env.local"), "utf8");
        const secreta = /^CRM_ALQUIMIA_SECRET_KEY=(sb_secret_[0-9a-f]{64})\r?$/m.exec(env)?.[1];
        const publica = /^CRM_ALQUIMIA_PUBLISHABLE_KEY=(sb_publishable_[0-9a-f]{32})\r?$/m.exec(env)?.[1];
        expect(secreta, env.replace(/=.*/g, "=…")).toBeTruthy();
        expect(publica).toBeTruthy();
        const start = daCli(p).find((c) => c.args.includes("start"))!;
        expect(start.secreta).toBe(secreta);
        expect(start.publica).toBe(publica);
        expect(r.tudo).not.toContain(secreta!);
      },
      T,
    );

    it(
      "grava o supabase/.env que a CLI lê sozinha (subir à mão não volta às chaves públicas), com os três valores do .env.local",
      async () => {
        const p = criarProjeto();
        const r = await instalar(p, {});
        expect(r.status, r.tudo).toBe(0);
        const env = readFileSync(join(p.dir, ".env.local"), "utf8");
        const daCliTexto = readFileSync(envDaCli(p), "utf8");
        for (const k of ["CRM_ALQUIMIA_JWT_SECRET", "CRM_ALQUIMIA_PUBLISHABLE_KEY", "CRM_ALQUIMIA_SECRET_KEY"]) {
          const v = new RegExp(`^${k}=(.+?)\\r?$`, "m").exec(env)?.[1];
          expect(v, k).toBeTruthy();
          expect(daCliTexto, k).toContain(`${k}=${v}`);
        }
        // só esses três: nenhum outro segredo do .env.local vai para a pasta supabase/
        expect(daCliTexto).not.toMatch(/^(INTERNAL_SECRET|SUPABASE_SERVICE_ROLE_KEY|AI_CRED_AES_KEY)=/m);
      },
      T,
    );

    it.skipIf(!ehWindows)(
      "a chave e o supabase/.env ficam só do dono, mesmo com a pasta supabase/ aberta a Users",
      async () => {
        const p = criarProjeto();
        expect(spawnSync("icacls", [join(p.dir, "supabase"), "/grant", "*S-1-5-32-545:(OI)(CI)(R)"], { encoding: "utf8" }).status).toBe(0);
        const r = await instalar(p, {});
        expect(r.status, r.tudo).toBe(0);
        for (const arq of [chave(p), envDaCli(p)]) {
          const titulares = titularesDaAcl(arq);
          expect(titulares.length, arq).toBeGreaterThan(0);
          for (const t of titulares) expect(t, `${arq}: ${titulares.join(", ")}`).not.toMatch(OUTROS_NA_ACL);
        }
      },
      T,
    );

    it(
      "reinstalação: a chave que já existia fica a mesma, a CLI não gera outra e as sessões não caem",
      async () => {
        const p = criarProjeto();
        writeFileSync(join(p.dir, "supabase-estado"), "de-pe");
        jaTinhaSegredo(p);
        const r = await instalar(p, { CRM_ALQUIMIA_MEMORIA_LIVRE_MB: "16000" });
        expect(r.status, r.tudo).toBe(0);
        expect(readFileSync(chave(p), "utf8")).toBe(CHAVE_JA_GRAVADA);
        expect(npx(p).some((a) => a.includes("signing-key"))).toBe(false);
        expect(linhaDoTempo(join(p.dir, "ordem.log"))).not.toContain("supabase stop");
        expect(r.tudo).not.toMatch(/sess.{1,2}es abertas podem pedir novo login/);
        expect(readFileSync(join(p.dir, ".env.local"), "utf8")).toContain(`CRM_ALQUIMIA_SECRET_KEY=${SECRETA_JA_GRAVADA}`);
      },
      T,
    );

    it(
      "migração (o CRM já tinha o segredo do JWT, mas não a chave): gera a chave, para o Supabase, avisa que as sessões caem, sobe com ela e regrava as chaves do app",
      async () => {
        const p = criarProjeto();
        writeFileSync(join(p.dir, "supabase-estado"), "de-pe");
        // Instalação da versão anterior: segredo do JWT, sem a chave de assinatura nem as chaves novas.
        writeFileSync(
          join(p.dir, ".env.local"),
          [`CRM_ALQUIMIA_JWT_SECRET=${SEGREDO_JA_GRAVADO}`, "NEXT_PUBLIC_SUPABASE_ANON_KEY=anon-de-antes", "SUPABASE_SERVICE_ROLE_KEY=servico-de-antes", ""].join("\n"),
        );
        const r = await instalar(p, { CRM_ALQUIMIA_MEMORIA_LIVRE_MB: "16000" });
        expect(r.status, r.tudo).toBe(0);
        expect(linhaDoTempo(join(p.dir, "ordem.log"))).toEqual(["supabase stop", "build app", "build worker", "build scheduler", "supabase start", "up -d"]);
        expect(r.tudo).toMatch(/sess.{1,2}es abertas podem pedir novo login/);
        expect(JSON.parse(readFileSync(chave(p), "utf8"))).toHaveLength(1);
        const env = readFileSync(join(p.dir, ".env.local"), "utf8");
        expect(env).toMatch(/^NEXT_PUBLIC_SUPABASE_ANON_KEY=anon-falsa\r?$/m);
        expect(env).toMatch(/^SUPABASE_SERVICE_ROLE_KEY=servico-falsa\r?$/m);
        expect(env).toContain(`CRM_ALQUIMIA_JWT_SECRET=${SEGREDO_JA_GRAVADO}`);
        expect(r.tudo).not.toContain("d-privada-falsa-nunca-na-tela");
      },
      T,
    );

    it(
      "a CLI não grava a chave no arquivo (põe no stdout): o instalador para com mensagem, sem mostrar a chave, e não deixa arquivo pela metade",
      async () => {
        const p = criarProjeto();
        const r = await instalar(p, { FAKE_GEN_NA_SAIDA: "1" });
        expect(r.status, r.tudo).not.toBe(0);
        expect(r.tudo).toMatch(/chave de assinatura/);
        expect(r.tudo).not.toContain("d-privada-falsa-nunca-na-tela");
        expect(existsSync(chave(p))).toBe(false);
        expect(linhaDoTempo(join(p.dir, "ordem.log"))).not.toContain("build app");
      },
      T,
    );

    it(
      "o gen falha: o instalador para com o erro da CLI e roda de novo do zero na vez seguinte",
      async () => {
        const p = criarProjeto();
        const r = await instalar(p, { FAKE_GEN_FALHA: "1" });
        expect(r.status, r.tudo).not.toBe(0);
        expect(r.tudo).toContain("GenFalsoError");
        expect(existsSync(chave(p))).toBe(false);
        const r2 = await instalar(p, {});
        expect(r2.status, r2.tudo).toBe(0);
        expect(JSON.parse(readFileSync(chave(p), "utf8"))).toHaveLength(1);
      },
      T,
    );

    it(
      "build que falha depois de parar o Supabase por chave nova: religa e diz para rodar o instalador de novo (as chaves do app são as antigas)",
      async () => {
        const p = criarProjeto();
        writeFileSync(join(p.dir, "supabase-estado"), "de-pe");
        writeFileSync(join(p.dir, ".env.local"), `CRM_ALQUIMIA_JWT_SECRET=${SEGREDO_JA_GRAVADO}\n`);
        const r = await instalar(p, { FAKE_DOCKER_FALHA_BUILD: "app" });
        expect(r.status, r.tudo).not.toBe(0);
        expect(linhaDoTempo(join(p.dir, "ordem.log"))).toEqual(["supabase stop", "build app", "supabase start"]);
        expect(r.tudo).toMatch(/rode o instalador de novo/i);
        expect(r.tudo).not.toMatch(/tem banco de novo\./);
      },
      T,
    );

    it(
      "o start falha duas vezes com o erro no stdout (JSON, como a CLI real): a mensagem final mostra o erro e não o aviso do [inbucket] nem as chaves",
      async () => {
        const p = criarProjeto();
        const r = await instalar(p, {
          FAKE_SUPABASE_START_FALHAS: "2",
          FAKE_SUPABASE_START_MSG: "WARN: config section [inbucket] is deprecated",
          FAKE_SUPABASE_START_STDOUT: '{"_tag":"Error","error":{"code":"StatusDbNotRunningError","message":"tentativa {n}: container is not running"}}',
        });
        expect(r.status, r.tudo).not.toBe(0);
        const final = r.tudo.slice(r.tudo.search(/falhou duas vezes/));
        expect(final).toContain("tentativa 1: container is not running");
        expect(final).toContain("tentativa 2: container is not running");
        expect(final).toContain("StatusDbNotRunningError");
        expect(final).not.toMatch(/\[inbucket\]/);
        expect(r.tudo).not.toContain("chave-do-stdout-nunca-na-tela");
      },
      T,
    );

    it(
      "o start falha com uma linha de erro que cita um JWT, uma sb_secret_, o d de uma chave e um segredo em hex: nenhum deles vai à tela",
      async () => {
        const p = criarProjeto();
        const r = await instalar(p, {
          FAKE_SUPABASE_START_FALHAS: "2",
          FAKE_SUPABASE_START_STDOUT: JSON.stringify({
            _tag: "Error",
            error: { code: "StartInvalidConfigError", message: `tentativa {n}: bad key ${JWT_FALSO} ${SECRETA_FALSA} {"kty":"EC","d":"${D_FALSO}"} secret=${HEX_FALSO}` },
          }),
        });
        expect(r.status, r.tudo).not.toBe(0);
        const final = r.tudo.slice(r.tudo.search(/falhou duas vezes/));
        expect(final).toContain("StartInvalidConfigError");
        expect(final).toContain("<oculto>");
        for (const segredo of [JWT_FALSO, SECRETA_FALSA, D_FALSO, HEX_FALSO]) expect(r.tudo).not.toContain(segredo);
      },
      T,
    );

    it(
      "o gen falha só com mensagem no stderr (npx sem rede): a mensagem aparece, com o que parece chave trocado por <oculto>",
      async () => {
        const p = criarProjeto();
        const r = await instalar(p, { FAKE_GEN_STDERR: `npm error code ENOTFOUND registry ${JWT_FALSO}` });
        expect(r.status, r.tudo).not.toBe(0);
        expect(r.tudo).toContain("npm error code ENOTFOUND");
        expect(r.tudo).toContain("<oculto>");
        expect(r.tudo).not.toContain(JWT_FALSO);
        expect(existsSync(chave(p))).toBe(false);
      },
      T,
    );

    it(
      "uma chave privada que já existia, com outra só pública ao lado (rotação), fica como está: nada é apagado nem gerado",
      async () => {
        const p = criarProjeto();
        jaTinhaSegredo(p);
        const rotacao = JSON.stringify([
          { kty: "EC", kid: "kid-publica-antiga", alg: "ES256", crv: "P-256", x: "x", y: "y" },
          ...(JSON.parse(CHAVE_JA_GRAVADA) as unknown[]),
        ]);
        writeFileSync(chave(p), rotacao);
        const r = await instalar(p, {});
        expect(r.status, r.tudo).toBe(0);
        expect(readFileSync(chave(p), "utf8")).toBe(rotacao);
        expect(npx(p).some((a) => a.includes("signing-key"))).toBe(false);
      },
      T,
    );

    it(
      "um arquivo de chave só com chave pública: o instalador não o apaga, a CLI acrescenta uma privada",
      async () => {
        const p = criarProjeto();
        jaTinhaSegredo(p);
        writeFileSync(chave(p), JSON.stringify([{ kty: "EC", kid: "kid-publica-antiga", alg: "ES256", crv: "P-256", x: "x", y: "y" }]));
        const r = await instalar(p, {});
        expect(r.status, r.tudo).toBe(0);
        const chaves = JSON.parse(readFileSync(chave(p), "utf8")) as Array<{ kid: string; d?: string }>;
        expect(chaves).toHaveLength(2);
        expect(chaves[0]?.kid).toBe("kid-publica-antiga");
        expect(chaves[1]?.d).toBeTruthy();
      },
      T,
    );

    it(
      "um arquivo de chave que não é JSON: para sem apagar nem gerar, e diz o que fazer",
      async () => {
        const p = criarProjeto();
        jaTinhaSegredo(p);
        writeFileSync(chave(p), "isto nao e uma lista de chaves");
        const r = await instalar(p, {});
        expect(r.status, r.tudo).not.toBe(0);
        expect(readFileSync(chave(p), "utf8")).toBe("isto nao e uma lista de chaves");
        expect(npx(p).some((a) => a.includes("signing-key"))).toBe(false);
        expect(r.tudo).toMatch(/signing_keys\.json/);
      },
      T,
    );

    it(
      "config.toml sem uma das linhas das chaves desta instalação: para antes de qualquer comando da CLI e diz qual falta",
      async () => {
        const p = criarProjeto();
        const config = join(p.dir, "supabase", "config.toml");
        writeFileSync(config, readFileSync(config, "utf8").replace(/^secret_key = .*\r?\n/m, ""));
        const r = await instalar(p, {});
        expect(r.status, r.tudo).not.toBe(0);
        expect(r.tudo).toContain("secret_key");
        expect(npx(p).some((a) => a.includes("status") || a.includes("start") || a.includes("gen"))).toBe(false);
      },
      T,
    );

    it(
      "uma execução anterior gerou chaves e parou antes de reiniciar (o marcador ficou no disco): esta para o Supabase de pé, sobe de novo e apaga o marcador",
      async () => {
        const p = criarProjeto();
        writeFileSync(join(p.dir, "supabase-estado"), "de-pe");
        jaTinhaSegredo(p);
        writeFileSync(marcador(p), "");
        const r = await instalar(p, {});
        expect(r.status, r.tudo).toBe(0);
        expect(ordem(p)).toEqual(["supabase stop", "build app", "build worker", "build scheduler", "supabase start", "up -d"]);
        expect(r.tudo).toMatch(/sess.{1,2}es abertas podem pedir novo login/);
        expect(existsSync(marcador(p))).toBe(false);
      },
      T,
    );

    it(
      "o stop falha depois de gerar as chaves: o marcador fica, e a execução seguinte reinicia o Supabase com as mesmas chaves",
      async () => {
        const p = criarProjeto();
        writeFileSync(join(p.dir, "supabase-estado"), "de-pe");
        writeFileSync(join(p.dir, ".env.local"), `CRM_ALQUIMIA_JWT_SECRET=${SEGREDO_JA_GRAVADO}\n`);
        const r = await instalar(p, { FAKE_SUPABASE_STOP: "1" });
        expect(r.status, r.tudo).not.toBe(0);
        expect(existsSync(marcador(p))).toBe(true);
        const chaveGerada = readFileSync(chave(p), "utf8");
        // o stop falhou: o Supabase segue de pé, com as chaves de antes
        writeFileSync(join(p.dir, "supabase-estado"), "de-pe");
        rmSync(join(p.dir, "ordem.log"), { force: true });
        const r2 = await instalar(p, {});
        expect(r2.status, r2.tudo).toBe(0);
        const t = ordem(p);
        expect(t[0]).toBe("supabase stop");
        expect(t).toContain("supabase start");
        expect(readFileSync(chave(p), "utf8")).toBe(chaveGerada);
        expect(npx(p).filter((a) => a.includes("signing-key"))).toHaveLength(1);
        expect(existsSync(marcador(p))).toBe(false);
      },
      T,
    );

    it(
      "o Supabase de pé publica no JWKS a chave da CLI (sem marcador): reinicia, e depois disso o JWKS bate",
      async () => {
        const p = criarProjeto();
        writeFileSync(join(p.dir, "supabase-estado"), "de-pe");
        jaTinhaSegredo(p);
        const api = await jwksDePe(p, "velho-ate-reiniciar");
        const r = await instalar(p, {}, api);
        expect(r.status, r.tudo).toBe(0);
        const t = ordem(p);
        expect(t.filter((x) => x === "supabase stop")).toHaveLength(1);
        expect(t.indexOf("build scheduler")).toBeLessThan(t.indexOf("supabase stop"));
        expect(t.indexOf("supabase stop")).toBeLessThan(t.indexOf("supabase start"));
        expect(r.tudo).toMatch(/n.{1,2}o usa as chaves desta instala/);
        expect(r.tudo).toMatch(/sess.{1,2}es abertas podem pedir novo login/);
      },
      T,
    );

    it(
      "o JWKS do Supabase de pé bate com a chave desta instalação: nada reinicia e não há aviso",
      async () => {
        const p = criarProjeto();
        writeFileSync(join(p.dir, "supabase-estado"), "de-pe");
        jaTinhaSegredo(p);
        const api = await jwksDePe(p, "da-instalacao");
        const r = await instalar(p, {}, api);
        expect(r.status, r.tudo).toBe(0);
        expect(ordem(p)).not.toContain("supabase stop");
        expect(r.tudo).toMatch(/Supabase j.{1,2} est.{1,2} rodando/);
        expect(r.tudo).not.toMatch(/n.{1,2}o consegui conferir/);
      },
      T,
    );

    it(
      "o JWKS segue com a chave da CLI mesmo depois de reiniciar: para com mensagem em vez de dizer que está pronto",
      async () => {
        const p = criarProjeto();
        writeFileSync(join(p.dir, "supabase-estado"), "de-pe");
        jaTinhaSegredo(p);
        const api = await jwksDePe(p, "sempre-velho");
        const r = await instalar(p, {}, api);
        expect(r.status, r.tudo).not.toBe(0);
        expect(r.tudo).toMatch(/n.{1,2}o com as chaves desta instala/);
        expect(ordem(p)).not.toContain("up -d");
      },
      T,
    );

    it(
      "o Auth de pé recebeu o texto literal env(...) como segredo (Supabase subido à mão sem o supabase/.env): reinicia",
      async () => {
        const p = criarProjeto();
        writeFileSync(join(p.dir, "supabase-estado"), "de-pe");
        jaTinhaSegredo(p);
        const r = await instalar(p, {
          FAKE_DOCKER_INSPECT: JSON.stringify({
            [`supabase_auth_${PROJETO}`]: {
              antes: { Env: ["GOTRUE_JWT_SECRET=env(CRM_ALQUIMIA_JWT_SECRET)"] },
              depois: { Env: [`GOTRUE_JWT_SECRET=${SEGREDO_JA_GRAVADO}`] },
            },
          }),
        });
        expect(r.status, r.tudo).toBe(0);
        const t = ordem(p);
        expect(t).toContain("supabase stop");
        expect(t.indexOf("supabase stop")).toBeLessThan(t.indexOf("supabase start"));
        expect(r.tudo).not.toContain(SEGREDO_JA_GRAVADO);
      },
      T,
    );

    it(
      "o Kong de pé troca uma sb_secret_ que não é a desta instalação, e continua depois de reiniciar: para, sem mostrar chave",
      async () => {
        const p = criarProjeto();
        writeFileSync(join(p.dir, "supabase-estado"), "de-pe");
        jaTinhaSegredo(p);
        // as chaves sb_ ficam no kong.yml do contêiner, não no .Config do docker inspect
        const kongYml = `consumers:
  - keyauth_credentials:
      - key: ${SECRETA_FALSA}
`;
        const r = await instalar(p, { FAKE_DOCKER_KONG_YML: JSON.stringify({ [`supabase_kong_${PROJETO}`]: kongYml }) });
        expect(r.status, r.tudo).not.toBe(0);
        expect(r.tudo).toMatch(/n.{1,2}o com as chaves desta instala/);
        expect(r.tudo).not.toContain(SECRETA_FALSA);
        expect(r.tudo).not.toContain(SECRETA_JA_GRAVADA);
      },
      T,
    );
  });
}

// Um TERM no instalador no meio do build encerra o `docker compose build` do projeto antes
// de religar o banco (o build não fica compilando por cima do `supabase start`). Só no bash: no Windows o
// Ctrl+C chega ao compose pelo console, e o PowerShell não recebe TERM.
describe.skipIf(!temBash)("bash: TERM no meio do build encerra o build do projeto antes de religar o banco", () => {
  it(
    "o processo do build morre, e só depois o Supabase volta",
    async () => {
      const p = criarProjeto();
      writeFileSync(join(p.dir, "supabase-estado"), "de-pe");
      const pidArq = join(p.dir, "build.pid");
      const app = await crmDePe();
      const worker = await crmDePe();
      const env = ambiente(p, "bash", {
        ...(await portasLivres()),
        CRM_ALQUIMIA_PORTA_APP: String(app),
        CRM_ALQUIMIA_PORTA_WORKER: String(worker),
        FAKE_DOCKER_PUBLICA: JSON.stringify({ [app]: `${PROJETO}-app-1`, [worker]: `${PROJETO}-worker-1` }),
        FAKE_DOCKER_COMPOSE: conteineres(p.dir, PROJETO, ["app", "worker"]),
        FAKE_ORDEM_LOG: join(p.dir, "ordem.log"),
        FAKE_SUPABASE_ESTADO: join(p.dir, "supabase-estado"),
        CRM_ALQUIMIA_PARAR_BANCO_NO_BUILD: "sempre",
        FAKE_DOCKER_BUILD_PRESO: "app",
        FAKE_DOCKER_BUILD_PID: pidArq,
        CRM_ALQUIMIA_ESPERA_FIM_DO_BUILD_S: "10",
      });
      // O TERM sai de dentro do próprio bash (no Windows, o kill do Node é um TerminateProcess, que não
      // passa pelo trap): o embrulho espera o build começar e manda TERM ao instalador.
      const embrulho = [
        `bash "${join(p.dir, "scripts", "instalar.sh").replace(/\\/g, "/")}" &`,
        "inst=$!",
        "i=0",
        `while [ ! -s "${pidArq.replace(/\\/g, "/")}" ] && [ "$i" -lt 600 ]; do sleep 0.2; i=$((i + 1)); done`,
        "kill -TERM $inst",
        "wait $inst",
      ].join("\n");
      const r = await new Promise<{ status: number; tudo: string }>((resolve) => {
        const filho = execFile("bash", ["-c", embrulho], { cwd: p.dir, env, encoding: "utf8", timeout: 150_000 }, (erro, saida, err) => {
          resolve({ status: erro ? (typeof erro.code === "number" ? erro.code : 1) : 0, tudo: `${saida}\n${err}` });
        });
        filho.stdin?.end();
      });
      expect(r.status, r.tudo).not.toBe(0);
      const pid = Number(readFileSync(pidArq, "utf8"));
      let vivo = true;
      try {
        process.kill(pid, 0);
      } catch {
        vivo = false;
      }
      if (vivo) process.kill(pid);
      expect(vivo, r.tudo).toBe(false);
      const pedido = r.tudo.indexOf("Pedindo o fim do build deste CRM");
      expect(pedido, r.tudo).toBeGreaterThan(-1);
      expect(pedido).toBeLessThan(r.tudo.indexOf("Religando o Supabase"));
      expect(r.tudo).toMatch(/Supabase de volta/);
      expect(linhaDoTempo(join(p.dir, "ordem.log"))).toEqual(["supabase stop", "build app", "supabase start"]);
    },
    T,
  );
});

describe("o build da imagem de quem instala não roda o type-check", () => {
  // O type-check do `next build` levou o host de 3,3 GB livres a 1 MB na prova. O código instalado é o da
  // versão publicada: quem cobra os tipos é o CI e o `pnpm typecheck`. O `next build` fora do Docker segue
  // checando (a variável só existe dentro do Dockerfile, ou quando alguém a define).
  const dockerfile = readFileSync(join(RAIZ, "Dockerfile"), "utf8");
  const compose = readFileSync(join(RAIZ, "docker-compose.yml"), "utf8");
  const nextConfig = readFileSync(join(RAIZ, "next.config.ts"), "utf8");

  it("o Dockerfile tem o ARG BUILD_TYPECHECK (padrão 0) e o passa ao pnpm build, no mesmo estágio", () => {
    expect(dockerfile).toMatch(/^ARG BUILD_TYPECHECK=0$/m);
    const m = /^RUN (?:[^\n]*\\\n)*[^\n]*pnpm build/m.exec(dockerfile);
    expect(m, "o RUN do pnpm build").not.toBeNull();
    expect(m![0]).toContain("CRM_ALQUIMIA_BUILD_TYPECHECK=${BUILD_TYPECHECK}");
    expect(dockerfile.lastIndexOf("FROM ", dockerfile.indexOf("ARG BUILD_TYPECHECK"))).toBe(dockerfile.lastIndexOf("FROM ", m!.index));
  });

  it("o compose passa CRM_ALQUIMIA_BUILD_TYPECHECK ao build do app, padrão 0 (desligado)", () => {
    expect(compose).toContain("BUILD_TYPECHECK: ${CRM_ALQUIMIA_BUILD_TYPECHECK:-0}");
  });

  it("o next.config só pula os tipos quando a variável é 0, explícita (sem ela, o next build checa)", () => {
    const m = /typescript:\s*\{\s*ignoreBuildErrors:\s*([^,}]+?)\s*,?\s*\}/.exec(nextConfig);
    expect(m, "typescript.ignoreBuildErrors no next.config").not.toBeNull();
    const avaliar = (valor: string | undefined) =>
      new Function("process", `return (${m![1]});`)({ env: valor === undefined ? {} : { CRM_ALQUIMIA_BUILD_TYPECHECK: valor } });
    expect(avaliar("0")).toBe(true);
    expect(avaliar(undefined)).toBe(false);
    expect(avaliar("1")).toBe(false);
    expect(avaliar("")).toBe(false);
  });
});
