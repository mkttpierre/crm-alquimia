// @vitest-environment node
/**
 * PORTÃO DE LIMPEZA do CRM ALQUIM(IA) open source (regras GENÉRICAS).
 *
 * Varre os arquivos RASTREADOS pelo git (`git ls-files`, nunca o disco inteiro) e reprova o que
 * não pode viajar num repositório público: marca e autor da origem fora dos créditos, caminho do
 * PC de quem desenvolveu, e-mail pessoal, hostname de rede privada, chaves com formato conhecido,
 * CNPJ/CPF formatado, id de organização real (só por hash), formas proibidas do nome do produto
 * e binários que não estão na lista de permitidos.
 *
 * O que é específico da operação de quem publica (nomes de negócios, clientes, chips, pessoas,
 * hostnames, nomes lidos do banco) NÃO mora aqui: estaria vazando dentro do próprio teste. Vive
 * fora do repositório, em `_oss/auditoria-operacao.mjs` e `_oss/auditoria-telefones.mjs`, que
 * varrem um worktree passado por argumento e imprimem só caminho:linha e a regra.
 *
 * Este arquivo NÃO se isenta: ele também é varrido (e há um teste dedicado para isso). Por isso
 * os padrões e os casos de teste são montados a partir de fragmentos, com valores fictícios.
 *
 * Privacidade: nunca imprime o trecho da linha. Ids de organização entram só como SHA-256.
 * Leve: lê um arquivo por vez e só quebra em linhas quando o texto inteiro pode casar.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const RAIZ = path.resolve(__dirname, "../..");

/** Junta fragmentos: assim o próprio arquivo não contém os padrões que procura. */
const j = (...partes: string[]): string => partes.join("");

/** SHA-256 (minúsculas) dos ids de organização reais de quem publica. O id nunca fica no repositório. */
const HASHES_DE_ORGANIZACAO_REAL = new Set<string>([
  "86813773cb48e91153d2942c002249e8b9edea76cc6645b301f9f9a584bedc0e",
  "dd8c39df99d666ec91ca5498b47d794e304908a264a8c56637561964948b3dc2",
  "52ee89861b5fba492af22f949f3f014ed826d6b5b587f417c533ef10ed202a01",
]);

/** Início do payload (iss = demo) das chaves de demonstração PÚBLICAS do Supabase local. */
const PAYLOAD_JWT_DE_DEMONSTRACAO = j("ey", "Jpc3MiOiJzdXBhYmFzZS1kZW1v");

/** CNPJ/CPF de fixture (só dígitos) aceitos: exemplos públicos conhecidos. Repetição de um dígito também passa. */
const DOCUMENTOS_DE_FIXTURE = new Set<string>([
  "00000000000191",
  "12345678000195",
  "11222333000181",
  "11144477735",
  "12345678909",
]);
const ehDocumentoDeFixture = (trecho: string): boolean => {
  const d = trecho.replace(/\D/g, "");
  return DOCUMENTOS_DE_FIXTURE.has(d) || /^(\d)\1+$/.test(d);
};

const ehJwtDeDemonstracao = (token: string): boolean => (token.split(".")[1] ?? "").startsWith(PAYLOAD_JWT_DE_DEMONSTRACAO);

/** Nomes de usuário claramente genéricos (imagens Docker, CI, exemplos): a pasta de home com eles não identifica ninguém. */
const NOMES_DE_HOME_GENERICOS: ReadonlySet<string> = new Set([
  "node", "runner", "runneradmin", "pwuser", "ubuntu", "user", "username", "usuario", "root", "app", "appuser",
  "vscode", "vagrant", "git", "www-data", "nextjs", "circleci", "jenkins", "builder", "example", "shared",
  // usuário do contêiner do Kong (gateway do Supabase): o kong.yml mora em /home/kong/kong.yml
  "kong",
]);
/** `trecho` é a pasta de home seguida do nome (ex.: "<pasta>/<nome>"). */
const ehHomeGenerica = (trecho: string): boolean => NOMES_DE_HOME_GENERICOS.has((trecho.split("/")[2] ?? "").toLowerCase());

/**
 * Telefone de fixture: o padrão que ninguém confunde com número de verdade fica no FIM do número. Vale um
 * dígito repetido 3 vezes nos 4 últimos (…0001, …7770), uma sequência de 4 no fim (…1234, …4321), três pares
 * no fim (…887766), um dígito repetido 4 vezes nos 8 últimos (…0000-1102) ou uma sequência de 6 em qualquer
 * ponto (12345678900). Aceita menos de 3% dos números ao acaso (antes, cerca de 7%).
 * Número real copiado de um payload ou de uma instalação é dado pessoal e não entra no repositório.
 */
const ehTelefoneDeFixture = (trecho: string): boolean => {
  const d = trecho.replace(/\D/g, "");
  const fim = d.slice(-4);
  return (
    /(\d)\1{2}/.test(fim) ||
    /^(?:0123|1234|2345|3456|4567|5678|6789|9876|8765|7654|6543|5432|4321|3210)$/.test(fim) ||
    /(\d)\1(\d)\2(\d)\3$/.test(d) ||
    /(\d)\1{3}/.test(d.slice(-8)) ||
    /012345|123456|234567|345678|456789|987654|876543|765432|654321|543210/.test(d)
  );
};

/**
 * Segredo de exemplo (a parte privada "d" de uma JWK, uma sb_secret_): um trecho que se repete (`"ef".repeat(16)`,
 * QQQQ…), o alfabeto em sequência ou uma palavra que diz que é falso. Um segredo de verdade é aleatório.
 */
const ehSegredoDeExemplo = (valor: string): boolean =>
  /(.{1,4})\1{3,}/.test(valor) || /abcdefgh|01234567/i.test(valor) || /fals|fake|teste|exemplo/i.test(valor);

/** BSUID fictício (o id de conta da Meta, PY.…): oito zeros seguidos, como o LID de exemplo. */
const ehBsuidDeFixture = (trecho: string): boolean => /0{8,}/.test(trecho);

/** LID de WhatsApp fictício: oito zeros seguidos (70000000000001@lid) ou feito de um telefone de fixture. */
const ehLidDeFixture = (trecho: string): boolean => /0{8,}/.test(trecho) || ehTelefoneDeFixture(trecho.replace(/@lid$/, ""));

/** Fictício de outro país: o mesmo padrão dos 8 últimos dígitos, ou a faixa 555 da América do Norte (inclusive o 1 555 da Meta). */
const ehTelefoneInternacionalDeFixture = (trecho: string): boolean => {
  const d = trecho.replace(/\D/g, "");
  return ehTelefoneDeFixture(trecho) || /^1(?:555\d{7}|\d{3}555\d{4})$/.test(d);
};

type Regra = { regra: string; re: RegExp; permitido?: (trecho: string) => boolean };

/** Regras genéricas. Sem diferenciar maiúsculas, salvo onde o formato da chave pede. */
const REGRAS: ReadonlyArray<Regra> = [
  { regra: "marca-da-origem", re: new RegExp(j("desk", "comm"), "i") },
  { regra: "autor-original", re: new RegExp(j("mel", "garafael", "|", "rafael", "melgaco", "|", "tha", "lena"), "i") },
  { regra: "caminho-do-pc", re: /C:[\\/]+Users/i },
  { regra: "caminho-do-pc", re: new RegExp(j("(^|[\\s\"'(=])\\/(c|mnt\\/c)\\/Us", "ers"), "i") },
  // Home de macOS e Linux: o nome depois da pasta é de uma pessoa, salvo os nomes genéricos de contêiner e de CI.
  { regra: "caminho-do-pc", re: new RegExp(j("(?<![\\w.~$}-])\\/(?:Us", "ers|ho", "me)\\/[^\\/\\s\"'`)<>$*{}%\\[\\]:;,]+")), permitido: ehHomeGenerica },
  { regra: "email-pessoal", re: /[\w.+-]+@(gmail|hotmail|outlook|yahoo|icloud|live|bol|uol)\.com(\.br)?/i },
  { regra: "hostname-de-rede-privada", re: /\.ts\.net/i },
  { regra: "chave-anthropic", re: /sk-ant-[\w-]{20,}/ },
  { regra: "chave-openrouter", re: /sk-or-v1-[\w-]{20,}/ },
  { regra: "chave-openai", re: /sk-proj-[\w-]{20,}/ },
  { regra: "chave-google", re: /AIza[0-9A-Za-z_-]{30,}/ },
  { regra: "chave-github", re: /ghp_[0-9A-Za-z]{20,}|github_pat_[0-9A-Za-z_]{20,}/ },
  { regra: "chave-tailscale", re: /tskey-[0-9A-Za-z-]{8,}/ },
  { regra: "chave-meta", re: /EAA[A-Za-z0-9]{20,}/ },
  { regra: "jwt", re: /eyJ[\w-]+\.[\w-]+\.[\w-]*/, permitido: ehJwtDeDemonstracao },
  { regra: "cnpj-formatado", re: /(?<![\d.])\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}(?!\d)/, permitido: ehDocumentoDeFixture },
  { regra: "cpf-formatado", re: /(?<![\d.])\d{3}\.\d{3}\.\d{3}-\d{2}(?!\d)/, permitido: ehDocumentoDeFixture },
  // LID de WhatsApp: não é discável, mas identifica uma conta.
  { regra: "lid-real", re: /(?<!\d)\d{12,16}@lid/, permitido: ehLidDeFixture },
  // BSUID (o id de conta que a Meta e o Zernio mandam no lugar do telefone: país, ponto, 12 a 16 dígitos).
  { regra: "bsuid-real", re: /(?<![\w.])[A-Z]{2}\.\d{12,16}(?!\d)/, permitido: ehBsuidDeFixture },
  // A parte privada de uma chave JWK (o "d" da supabase/signing_keys.json, por exemplo).
  { regra: "jwk-privada", re: /"d"\s*:\s*"[A-Za-z0-9_-]{40,}"/, permitido: (t) => ehSegredoDeExemplo(t.replace(/^.*:\s*"/, "")) },
  // O segredo do JWT de uma instalação (o instalador o gera em hex; um base64 longo também conta). O de
  // demonstração da CLI ("super-secret-jwt-token-…"), público, e os de exemplo não.
  {
    regra: "jwt-secret-real",
    re: /CRM_ALQUIMIA_JWT_SECRET["']?\s*[=:]\s*["']?[A-Za-z0-9+/_-]{32,}={0,2}/,
    permitido: (t) => {
      const valor = t.replace(/^CRM_ALQUIMIA_JWT_SECRET["']?\s*[=:]\s*["']?/, "");
      return valor.startsWith("super-secret-jwt-token-") || ehSegredoDeExemplo(valor);
    },
  },
  // A chave secreta nova da API do Supabase (a do instalador é desta instalação; a padrão da CLI abre tudo).
  { regra: "sb-secret-real", re: /sb_secret_[A-Za-z0-9_-]{16,}/, permitido: (t) => ehSegredoDeExemplo(t.slice("sb_secret_".length)) },
  // Celular ou fixo com DDI 55, só dígitos ou com máscara (+55 11 9 1234-5678, 55 (11) 91234-5678).
  {
    regra: "telefone-real",
    re: /(?<![\dA-Za-z])\+?55[ .-]?\(?[1-9]\d\)?[ .-]?(?:9[ .-]?)?\d{4}[ .-]?\d{4}(?![\dA-Za-z])/,
    permitido: ehTelefoneDeFixture,
  },
  // Qualquer país em E.164 com `+` (10 a 15 dígitos, com ou sem máscara: +1 (202) 555-0137, +595 (99) 100-0111).
  {
    regra: "telefone-real",
    re: /(?<![\dA-Za-z])\+[1-9](?:[ .()-]{0,2}\d){9,14}(?![\dA-Za-z])/,
    permitido: ehTelefoneInternacionalDeFixture,
  },
  // Só dígitos, sem `+`: só os países vizinhos e os de costume, cada um no seu comprimento exato, para não
  // confundir com id de run do CI, timestamp, versão de migration, CPF ou LID.
  {
    regra: "telefone-real",
    re: /(?<![\dA-Za-z])(?:1[2-9]\d{2}[2-9]\d{6}|595\d{9}|598\d{8}|591\d{8}|593\d{9}|54\d{10,11}|56\d{9}|57\d{10}|51\d{9}|52\d{10,11}|58\d{10}|351\d{9})(?![\dA-Za-z])/,
    permitido: ehTelefoneInternacionalDeFixture,
  },
];

const comFlagGlobal = (re: RegExp): RegExp => new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
const REGRAS_GLOBAIS = REGRAS.map((r) => ({ ...r, re: comFlagGlobal(r.re) }));

/**
 * As únicas formas do nome do produto que contêm a raiz do nome. Exatas (maiúsculas e minúsculas contam)
 * e só como token inteiro: o nome do pacote, as imagens/contêineres do produto e as variáveis CRM_*.
 */
const FORMAS_DO_NOME_DO_PRODUTO = [
  new RegExp(j("CRM ALQ", "UIM\\(IA\\)"), "g"),
  new RegExp(j("(?<![A-Za-z0-9])crm-", "alq", "uimia-(?:app|worker|scheduler)(?![-_A-Za-z0-9])"), "g"),
  new RegExp(j("(?<![A-Za-z0-9])crm-", "alq", "uimia(?![-_A-Za-z0-9])"), "g"),
  new RegExp(j("(?<![A-Za-z0-9])CRM_", "ALQ", "UIMIA_[A-Z0-9_]*(?![A-Za-z0-9_])"), "g"),
  // Prefixo do arquivo de códigos de recuperação (`prefixoDoArquivo` do nome padrão) e prefixo das imagens
  // construídas pelo compose, citado como literal de string. São o nome do produto, não dado da operação.
  new RegExp(j("(?<![A-Za-z0-9])crm-", "alq", "uim-ia(?![-_A-Za-z0-9])"), "g"),
  new RegExp(j("(?<![A-Za-z0-9])crm-", "alq", "uimia-(?=[\"'`])"), "g"),
  // Identificadores de fio que levam o nome do produto: o cookie de sessão, fixo nos três
  // lugares que o leem, e os dois headers do webhook (header HTTP não diferencia maiúsculas). Lista fechada.
  new RegExp(j("(?<![A-Za-z0-9])sb-crm-", "alq", "uimia-auth(?![-_A-Za-z0-9])"), "g"),
  new RegExp(j("(?<![A-Za-z0-9])x-crm-", "alq", "uimia-(?:event|signature)(?![-_A-Za-z0-9])"), "gi"),
];
const NOME_BASE = new RegExp(j("alq", "uim"), "i");

/** O texto sem as formas permitidas do nome do produto. */
export const semFormasPermitidas = (linha: string): string =>
  FORMAS_DO_NOME_DO_PRODUTO.reduce((t, re) => t.replace(re, " "), linha);

/** PRÉ-FILTRO: superconjunto de tudo que as regras procuram; decide se vale quebrar o texto em linhas. */
const PRE_FILTRO = new RegExp([...REGRAS.map((r) => r.re.source), NOME_BASE.source].join("|"), "i");
const UUID_OU_HEX32_NO_TEXTO = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32}/i;

const UUID = /(?<![0-9a-f])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f])/gi;
const HEX32 = /(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/gi;

const sha256 = (texto: string): string => createHash("sha256").update(texto).digest("hex");

/** 32 hex → UUID com hífens. */
const comoUuid = (h: string): string =>
  `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`.toLowerCase();

/** Regras que esta linha infringe (vazio = limpa). `ignorar` são regras isentas para o arquivo em questão. */
export function regrasInfringidas(
  linha: string,
  hashesDeOrg: ReadonlySet<string>,
  ignorar: ReadonlySet<string> = new Set(),
): string[] {
  const regras = new Set<string>();
  if (!ignorar.has("nome-do-produto") && NOME_BASE.test(semFormasPermitidas(linha))) regras.add("nome-do-produto");
  for (const r of REGRAS_GLOBAIS) {
    if (ignorar.has(r.regra)) continue;
    for (const m of linha.matchAll(r.re)) {
      if (!r.permitido || !r.permitido(m[0])) regras.add(r.regra);
    }
  }
  for (const m of linha.match(UUID) ?? []) {
    if (hashesDeOrg.has(sha256(m.toLowerCase()))) regras.add("id-de-organizacao-real");
  }
  for (const m of linha.match(HEX32) ?? []) {
    if (hashesDeOrg.has(sha256(comoUuid(m)))) regras.add("id-de-organizacao-real");
  }
  return [...regras];
}

/** A frase de crédito à origem, exata, no README (o instalador usa este mesmo texto). */
const CREDITO_DO_README = j("Nasceu de um fork do ", "Desk", "commCRM (MIT).");

/** No README.md a frase exata sai da linha antes da checagem; o resto da linha continua conferido. */
export const semCredito = (arquivo: string, linha: string): string =>
  arquivo === "README.md" ? linha.split(CREDITO_DO_README).join(" ") : linha;

/** Isenção POR REGRA (nunca por arquivo inteiro): a atribuição legal à origem. */
const REGRAS_ISENTAS_POR_ARQUIVO: Record<string, ReadonlySet<string>> = {
  LICENSE: new Set(["marca-da-origem", "autor-original"]),
  "NOTICE.md": new Set(["marca-da-origem", "autor-original"]),
  // Hash de integridade (base64) casa o formato de chave por acaso; as demais regras continuam valendo no lockfile.
  "pnpm-lock.yaml": new Set(REGRAS.map((r) => r.regra).filter((r) => r.startsWith("chave-"))),
};
/** No LICENSE, o nome do titular deste produto (empresa + "Performance") é a única forma extra permitida. */
const TITULAR_NO_LICENSE = j("ALQUI", "M(IA) Performance");
/**
 * No NOTICE.md, o mesmo titular vale só nas duas linhas EXATAS do crédito (o copyright e a autoria das
 * mudanças). Qualquer outra linha com o nome, ou a mesma linha editada, volta a ser conferida.
 */
const CREDITO_DO_TITULAR_NO_NOTICE: ReadonlySet<string> = new Set([
  j("Copyright (c) 2026 ", TITULAR_NO_LICENSE, ". Distribuído sob a licença MIT (veja [LICENSE](LICENSE))."),
  j("Evolution API, motor de disparo, marca) são de ", TITULAR_NO_LICENSE, "."),
]);

/** Binários que podem ficar no repositório: ícones do produto e fixtures de teste. Lista explícita. */
export const BINARIOS_PERMITIDOS: ReadonlySet<string> = new Set([
  "public/icone-crm-256.png",
  "public/icone-crm-512.png",
  "tests/fixtures/midia/curto.mp4",
  "tests/fixtures/sample-acentos.pdf",
  "tests/fixtures/sample-corrompido.pdf",
  "tests/fixtures/sample-multipagina.pdf",
  "tests/fixtures/sample-sem-texto.pdf",
  "tests/fixtures/sample-text.pdf",
]);

const EXTENSOES_BINARIAS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "icns", "mp4", "webm", "mov", "mp3", "wav", "ogg",
  "pdf", "woff", "woff2", "ttf", "otf", "eot", "zip", "gz", "tgz", "7z", "wasm", "bin",
]);
/** Texto de código/documento: um byte NUL dentro (ex.: um caractere de controle num caso de teste) não o torna binário. */
const EXTENSOES_DE_TEXTO = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "jsonc", "md", "mdx", "sql", "sh", "ps1", "yml", "yaml", "toml",
  "css", "html", "txt", "env", "example", "csv", "svg", "xml", "conf", "cfg", "ini", "lock", "gitignore", "gitattributes",
]);

const extensao = (arquivo: string): string => (arquivo.includes(".") ? arquivo.split(".").pop()!.toLowerCase() : "");

export type Conteudo = { tipo: "texto"; texto: string } | { tipo: "binario" };

/** Decide se o conteúdo é texto (e o decodifica, inclusive UTF-16 com BOM) ou binário. */
export function decodificar(arquivo: string, buf: Buffer): Conteudo {
  const ext = extensao(arquivo);
  if (EXTENSOES_BINARIAS.has(ext)) return { tipo: "binario" };
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return { tipo: "texto", texto: buf.subarray(2).toString("utf16le") };
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const trocado = Buffer.from(buf.subarray(2));
    trocado.swap16();
    return { tipo: "texto", texto: trocado.toString("utf16le") };
  }
  if (buf.subarray(0, 8000).includes(0) && !EXTENSOES_DE_TEXTO.has(ext)) return { tipo: "binario" };
  return { tipo: "texto", texto: buf.toString("utf8") };
}

export type Achado = { arquivo: string; linha: number; regra: string };

/** Varre um texto linha a linha. */
export function acharNoTexto(
  arquivo: string,
  texto: string,
  hashesDeOrg: ReadonlySet<string> = HASHES_DE_ORGANIZACAO_REAL,
): Achado[] {
  const achados: Achado[] = [];
  const ignorar = REGRAS_ISENTAS_POR_ARQUIVO[arquivo] ?? new Set<string>();
  // Pré-filtro barato no texto inteiro: a maioria dos arquivos não tem nada e nem precisa ser quebrada em linhas.
  if (!PRE_FILTRO.test(texto) && !UUID_OU_HEX32_NO_TEXTO.test(texto)) return achados;
  const linhas = texto.split("\n");
  for (let i = 0; i < linhas.length; i++) {
    let linha = semCredito(arquivo, linhas[i]!);
    if (arquivo === "LICENSE") linha = linha.split(TITULAR_NO_LICENSE).join(" ");
    if (arquivo === "NOTICE.md" && CREDITO_DO_TITULAR_NO_NOTICE.has(linha.trimEnd())) linha = linha.split(TITULAR_NO_LICENSE).join(" ");
    for (const regra of regrasInfringidas(linha, hashesDeOrg, ignorar)) achados.push({ arquivo, linha: i + 1, regra });
  }
  return achados;
}

type Entrada = { modo: string; arquivo: string };

function arquivosRastreados(): Entrada[] {
  const saida = execFileSync("git", ["ls-files", "-s", "-z"], { cwd: RAIZ, maxBuffer: 64 * 1024 * 1024 });
  return saida
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((e) => {
      const tab = e.indexOf("\t");
      return { modo: e.slice(0, e.indexOf(" ")), arquivo: e.slice(tab + 1) };
    });
}

/** Caminho seguro para imprimir: sequências longas de dígitos (podem ser telefone) viram #. */
const mascarar = (s: string): string => s.replace(/\d{8,}/g, (d) => "#".repeat(d.length));

/** Varre todos os arquivos rastreados, um por vez. */
export function varrerRepositorio(): { arquivosLidos: number; achados: Achado[] } {
  const achados: Achado[] = [];
  let arquivosLidos = 0;
  for (const { modo, arquivo } of arquivosRastreados()) {
    // O caminho também conta: nome de pasta com dado da operação vaza igual.
    const ignorarNoCaminho = REGRAS_ISENTAS_POR_ARQUIVO[arquivo] ?? new Set<string>();
    for (const regra of regrasInfringidas(arquivo, HASHES_DE_ORGANIZACAO_REAL, ignorarNoCaminho)) {
      achados.push({ arquivo, linha: 0, regra: `${regra} (no caminho)` });
    }
    if (modo === "160000") {
      achados.push({ arquivo, linha: 0, regra: "submodulo" });
      continue;
    }
    const abs = path.join(RAIZ, arquivo);
    let texto: string;
    try {
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) {
        // Link simbólico: o que está rastreado é o destino; confere o destino.
        texto = readlinkSync(abs);
      } else if (!st.isFile()) {
        continue;
      } else {
        const c = decodificar(arquivo, readFileSync(abs));
        if (c.tipo === "binario") {
          if (!BINARIOS_PERMITIDOS.has(arquivo)) achados.push({ arquivo, linha: 0, regra: "binario-fora-da-lista" });
          continue;
        }
        texto = c.texto;
      }
    } catch {
      achados.push({ arquivo, linha: 0, regra: "rastreado-ausente-no-disco" });
      continue;
    }
    arquivosLidos++;
    achados.push(...acharNoTexto(arquivo, texto));
  }
  achados.sort((a, b) => (a.arquivo === b.arquivo ? a.linha - b.linha : a.arquivo < b.arquivo ? -1 : 1));
  return { arquivosLidos, achados };
}

describe("o detector (a rede em si, só com valores fictícios)", () => {
  const FAKE = "11111111-2222-4333-8444-555555555555";
  const hashes = new Set([sha256(FAKE)]);
  const regras = (linha: string) => regrasInfringidas(linha, hashes);

  it("aceita as formas exatas do nome do produto", () => {
    expect(regras(j("# CRM ALQ", "UIM(IA)"))).toEqual([]);
    expect(regras(j('name: "crm-', 'alq', 'uimia" // servidor MCP'))).toEqual([]);
    expect(regras(j("CRM_", "ALQ", "UIMIA_PORTA=3000"))).toEqual([]);
  });

  it("as formas permitidas valem só como token inteiro", () => {
    const c = j("crm-", "alq", "uimia");
    const v = j("CRM_", "ALQ", "UIMIA_");
    for (const ok of [
      c, `${c}.`, `"${c}"`, `(${c})`, `ghcr.io/dono/${c}:1.0.0`,
      `${c}-app`, `${c}-worker`, `image: ${c}-scheduler:1`,
      `${v}TOKEN`, `${v}PORTA_APP`, `process.env.${v}PORTA_APP;`, `${v}PORTA_APP=3000`,
      j("# CRM ALQ", "UIM(IA)."),
      `sb-${c}-auth`, `name: "sb-${c}-auth"`, `sb-${c}-auth.0`,
      `x-${c}-signature`, `X-${c.toUpperCase()}-EVENT`, j("X-CRM-Alq", "uimia-Signature"), `"x-${c}-event":`,
    ]) expect(regras(ok), ok).toEqual([]);
    for (const ruim of [`sb-${c}-authx`, `sb-${c}-sessao`, `x-${c}-token`, `x-${c}-signatures`, `xx-${c}-event`]) {
      expect(regras(ruim), ruim).toContain("nome-do-produto");
    }
    for (const ruim of [
      `${c}-previa`, `${c}_previa`, `${c}X`, `${c}2`, `my${c}`, `${c}-apps`, `${c}-workers`,
      `${v}previa`, `${v}PORTAx`, `x${v}TOKEN`, `${v.toLowerCase()}token`,
      j("CRM ALQ", "UIM"), j("alq", "uimia-previa"), j("a ALQ", "UIM abriu"),
    ]) expect(regras(ruim), ruim).toContain("nome-do-produto");
    expect(regras(`${c} e ${c}-previa`)).toContain("nome-do-produto");
  });

  it("reprova marca e autor da origem, caminho do PC, e-mail pessoal e hostname de rede privada", () => {
    const casos: Array<[string, string]> = [
      [j("Desk", "commCRM"), "marca-da-origem"],
      [j("DESK", "COMM"), "marca-da-origem"],
      [j("github.com/mel", "garafael"), "autor-original"],
      [j("Tha", "lena"), "autor-original"],
      [j("C:\\", "Users\\fulano"), "caminho-do-pc"],
      [j("c:/", "users/fulano"), "caminho-do-pc"],
      [j("cd /c/Us", "ers/fulano"), "caminho-do-pc"],
      [j('"/mnt/c/Us', 'ers/fulano"'), "caminho-do-pc"],
      [j("fulano@", "gmail.com"), "email-pessoal"],
      [j("a.b+c@", "hotmail.com.br"), "email-pessoal"],
      [j("x@", "UOL.com.br"), "email-pessoal"],
      [j("meu-pc.tail1234.ts", ".net"), "hostname-de-rede-privada"],
    ];
    for (const [linha, regra] of casos) expect(regras(linha), linha).toContain(regra);
    for (const ok of ["dev@example.com", "contato@minhaempresa.com.br", j("src/c/Us", "ers/x"), "gmail", "ts.net.example"]) {
      expect(regras(ok), ok).toEqual([]);
    }
  });

  it("caminho de home de macOS e Linux: nome de pessoa reprova, nome genérico de contêiner/CI passa", () => {
    const reprova = [
      j("/Us", "ers/fulano/projeto"),
      j("cd /ho", "me/fulano/app"),
      j('"/Us', 'ers/fulano"'),
      j("file:///Us", "ers/fulano/x"),
      j("WORKDIR=/ho", "me/Fulano"),
      j("x /Us", "ers/ciclano e /ho", "me/node/app"),
    ];
    for (const l of reprova) expect(regras(l), l).toContain("caminho-do-pc");
    const passa = [
      j("WORKDIR /ho", "me/node/app"),
      j("/Us", "ers/runner/work/repo"),
      j("/ho", "me/runner/work"),
      j("/ho", "me/pwuser/.cache/ms-playwright"),
      j("/ho", "me/ubuntu/.ssh"),
      j("/Us", "ers/Shared/x"),
      j("~/ho", "me/x"),
      j("src/ho", "me/pagina.tsx"),
      j("/ho", "me/<usuario>/app"),
      j("/ho", "me/$USER/app"),
      j("/Us", "ers/*/Library"),
      j("/ho", "me"),
      j("/ho", "me/"),
      j("GET /us", "ers/fulano"),
    ];
    for (const l of passa) expect(regras(l), l).toEqual([]);
  });

  it("pnpm-lock.yaml: isento só das regras chave-*; o resto continua conferido", () => {
    const hash = j("sha512-", "E", "AA", "B".repeat(25), "==");
    const lock = `  resolution: {integrity: ${hash}}`;
    expect(acharNoTexto("pnpm-lock.yaml", lock, hashes)).toEqual([]);
    expect(acharNoTexto("pnpm-lock.yaml", j("  a: ", "AI", "za", "B".repeat(35)), hashes)).toEqual([]);
    expect(acharNoTexto("package.json", lock, hashes).map((a) => a.regra)).toEqual(["chave-meta"]);
    expect(acharNoTexto("pnpm-lock.yaml", j("dono: fulano@", "gmail.com"), hashes).map((a) => a.regra)).toEqual(["email-pessoal"]);
    expect(acharNoTexto("pnpm-lock.yaml", j("# ", "Desk", "commCRM"), hashes).map((a) => a.regra)).toEqual(["marca-da-origem"]);
    expect(acharNoTexto("pnpm-lock.yaml", j("# a ALQ", "UIM"), hashes).map((a) => a.regra)).toEqual(["nome-do-produto"]);
    expect(acharNoTexto("sub/pnpm-lock.yaml", lock, hashes).map((a) => a.regra)).toEqual(["chave-meta"]);
  });

  it("reprova chaves com formato conhecido (valores fictícios) e aceita placeholders", () => {
    const corpo = "x".repeat(24);
    const casos: Array<[string, string]> = [
      [j("sk-", "ant-api03-", corpo), "chave-anthropic"],
      [j("sk-or", "-v1-", corpo), "chave-openrouter"],
      [j("sk-", "proj-", corpo), "chave-openai"],
      [j("AI", "za", "B".repeat(35)), "chave-google"],
      [j("gh", "p_", "A".repeat(30)), "chave-github"],
      [j("github", "_pat_", "A".repeat(30)), "chave-github"],
      [j("ts", "key-auth-", "abc12345"), "chave-tailscale"],
      [j("E", "AA", "B".repeat(25)), "chave-meta"],
      [j("ey", "JhbGciOiJIUzI1NiJ9.", "cGF5bG9hZA.", "c2ln"), "jwt"],
    ];
    for (const [linha, regra] of casos) expect(regras(linha), regra).toContain(regra);
    for (const ok of [j("sk-", "ant-..."), j("sk-", "ant-<sua-chave>"), j("sk-", "proj-curta"), j("sk-", "ant-api03-abc123"), "KEY=", "ghp"]) expect(regras(ok), ok).toEqual([]);
  });

  it("aceita só as chaves de demonstração PÚBLICAS do Supabase local", () => {
    const demo = j("ey", "JhbGciOiJIUzI1NiJ9.", PAYLOAD_JWT_DE_DEMONSTRACAO, "LCJyb2xlIjoiYW5vbiJ9.", "assinatura");
    expect(regras(demo)).toEqual([]);
    const outro = j("ey", "JhbGciOiJIUzI1NiJ9.", "ey", "Jyb2xlIjoic2VydmljZSJ9.", "assinatura");
    expect(regras(outro)).toContain("jwt");
    expect(regras(`${demo} ${outro}`)).toContain("jwt");
  });

  it("reprova CNPJ/CPF formatado, menos as fixtures conhecidas", () => {
    expect(regras(j("98.765.432/", "0001-10"))).toContain("cnpj-formatado");
    expect(regras(j("987.654.321-", "00"))).toContain("cpf-formatado");
    for (const ok of ["00.000.000/0001-91", "11.222.333/0001-81", "111.444.777-35", "123.456.789-09", "000.000.000-00", "111.111.111-11"]) {
      expect(regras(ok), ok).toEqual([]);
    }
    expect(regras("1.234.567,89 e 12.345-678")).toEqual([]);
  });

  it("reprova telefone que não é de fixture, com ou sem máscara, e aceita os padrões fictícios", () => {
    // DDD 20 e 23 não existem: o exemplo nunca coincide com o número de alguém.
    for (const real of [j("55209", "1726384"), j("55239", "47261835"), j("+55 20 9 ", "4726-1835"), j("55 (23) 9", "4726-1835")]) {
      expect(regras(real), real).toContain("telefone-real");
    }
    for (const ok of ["5511999990001", "+5511900000258", "551199990001", "5585987654321", "+55 11 9 0000-1102", "5531988887777", "555540008000"]) {
      expect(regras(ok), ok).toEqual([]);
    }
    // hash ou id hex com dígitos colados não é telefone
    expect(regras("a5511947261835b")).toEqual([]);
  });

  it("reprova telefone de outro país (E.164, 10 a 15 dígitos), com ou sem máscara, e aceita os fictícios", () => {
    // Prefixos e códigos de área escolhidos para não existirem (NANP 999, Paraguai 20).
    for (const real of [
      j("+1 999 ", "472 6183"), j("1999", "4726183"), j("+1 (999) ", "472-6183"),
      j("+595 (20) ", "472-6183"), j("595204", "726183"), j("+598 20", "47 2618"), j("+44 20 ", "4726 1835"),
    ]) {
      expect(regras(real), real).toContain("telefone-real");
    }
    for (const ok of [
      "+1 202 555 0137", "+12025550137", "15556320979", "+15556320979",
      "+595 (99) 100-0111", "595991000111", "+44 20 7946 0000",
      // não são telefone: id de run do CI, timestamp em segundos e em ms, versão de migration, CPF, LID
      "run 34072172013", "1785342028", "1785342028000", "20260428195354", "52998224726", "70000000000003@lid",
    ]) {
      expect(regras(ok), ok).toEqual([]);
    }
  });

  it("o padrão de fixture tem de estar no FIM do número: no começo do assinante não basta", () => {
    // Antes passava qualquer número com um dígito triplo ou até 3 dígitos distintos em qualquer ponto dos
    // 8 últimos: cerca de 7% dos números ao acaso. DDD 20 não existe.
    for (const real of [j("55209", "1114735"), j("55209", "4447261"), j("55209", "1213148"), j("+55 20 9 ", "1234-7261")]) {
      expect(regras(real), real).toContain("telefone-real");
    }
    for (const ok of ["5511999990001", "+5511900000258", "551199990001", "5585987654321", "+55 11 9 0000-1102", "5531988887777", "555540008000"]) {
      expect(regras(ok), ok).toEqual([]);
    }
  });

  it("a lista de permitidos aceita menos de 3% dos números ao acaso", () => {
    // Gerador fixo (LCG): o mesmo resultado em toda máquina. DDD 20, que não existe.
    let x = 20261114;
    let aceitos = 0;
    const total = 20_000;
    for (let i = 0; i < total; i++) {
      x = (Math.imul(x, 1103515245) + 12345) >>> 0;
      const assinante = String(x % 100_000_000).padStart(8, "0");
      if (regras(`55209${assinante}`).length === 0) aceitos++;
    }
    expect(aceitos / total).toBeLessThan(0.03);
  });

  it("reprova LID de WhatsApp com cara de real e aceita o fictício (zeros e o índice no fim)", () => {
    // Um LID não é discável, mas identifica uma conta de WhatsApp.
    for (const real of [j("4813926", "0571358@lid"), j("31950287", "6649173@lid")]) {
      expect(regras(real), real).toContain("lid-real");
    }
    for (const ok of ["70000000000001@lid", "70000000000006@lid", "700000000000007@lid", "60100000000002@lid"]) {
      expect(regras(ok), ok).toEqual([]);
    }
  });

  it("reprova BSUID (o id de conta da Meta, PY.…/BR.…) com cara de real e aceita o fictício (zeros)", () => {
    // Como o LID, não é discável, mas identifica uma conta de WhatsApp.
    for (const real of [j("PY.", "4719305826613"), j("BR.", "3918402755193617"), j("lid:PY.", "861203957741")]) {
      expect(regras(real), real).toContain("bsuid-real");
    }
    for (const ok of ["PY.7000000000000", "PY.70000000000001", "BR.7000000000000002", "v1.2", "MX.123"]) {
      expect(regras(ok), ok).toEqual([]);
    }
  });

  it("reprova a parte privada de uma chave JWK (\"d\") e aceita a de exemplo", () => {
    const d = j("Xb7Qp2LmZ9vR4tYc8", "NwKs1HfJ6gUe3aDo5iTqP0rVxW");
    expect(regras(`{"kty":"EC","d":"${d}"}`)).toContain("jwk-privada");
    expect(regras(`{"kty":"EC", "d" : "${d}"}`)).toContain("jwk-privada");
    for (const ok of [`"d":"d-privada-falsa-nunca-na-tela"`, `"d":"${"Q".repeat(43)}"`, `"d":"curto"`]) {
      expect(regras(ok), ok).toEqual([]);
    }
  });

  it("reprova uma sb_secret_ com cara de real e aceita as de exemplo (repetidas ou em sequência)", () => {
    expect(regras(j("sb_", "secret_", "N7qPz2Lm9VxR4tYc8KsH1fJ6"))).toContain("sb-secret-real");
    for (const ok of [`sb_secret_${"ef".repeat(16)}`, "sb_secret_abcdefghijklmnopqrstuvwxyz012345", `sb_secret_${"f00d".repeat(16)}`, "sb_secret_"]) {
      expect(regras(ok), ok).toEqual([]);
    }
  });

  it("reprova o segredo do JWT de uma instalação (CRM_ALQUIMIA_JWT_SECRET=<hex ou base64 longo>) e aceita o vazio e o de exemplo", () => {
    const hex = j("9f3a61c07d2e4b58", "a1c6e0f47b3d9285", "6e1f0a4c2b7d9e3f", "58a0c4e16b2d7f93");
    const b64 = j("Qm9vT2xpdmVyLXRl", "c3RlLWZpY3RpY2lv", "LTIwMjYtMTEtMTU+", "Pz8/");
    for (const real of [j("CRM_ALQUIMIA_JWT_SECRET=", hex), j('CRM_ALQUIMIA_JWT_SECRET="', b64, '"'), j("CRM_ALQUIMIA_JWT_SECRET: ", hex)]) {
      expect(regras(real), real).toContain("jwt-secret-real");
    }
    for (const ok of [
      "CRM_ALQUIMIA_JWT_SECRET=",
      "CRM_ALQUIMIA_JWT_SECRET=${SEGREDO_JA_GRAVADO}",
      "CRM_ALQUIMIA_JWT_SECRET=$(segredo_hex)",
      `CRM_ALQUIMIA_JWT_SECRET=${"c0de".repeat(16)}`,
      "CRM_ALQUIMIA_JWT_SECRET: super-secret-jwt-token-with-at-least-32-characters-long",
      "CRM_ALQUIMIA_JWT_SECRET=<gerado-pelo-instalador>",
    ]) {
      expect(regras(ok), ok).toEqual([]);
    }
  });

  it("reprova id de organização real (por hash), com ou sem hífens, e ignora outros UUIDs", () => {
    expect(regras(`org = '${FAKE}'`)).toContain("id-de-organizacao-real");
    expect(regras(`org = '${FAKE.toUpperCase()}'`)).toContain("id-de-organizacao-real");
    expect(regras(`org = '${FAKE.replaceAll("-", "")}'`)).toContain("id-de-organizacao-real");
    expect(regras("org = '00000000-0000-4000-8000-000000000001'")).toEqual([]);
    // a janela é exata: hex colado antes ou depois não é o UUID; uma letra não-hex ao lado não impede
    expect(regras(`a${FAKE}`)).toEqual([]);
    expect(regras(`${FAKE}a`)).toEqual([]);
    expect(regras(`g${FAKE}`)).toContain("id-de-organizacao-real");
  });

  it("não reprova texto neutro", () => {
    expect(regras("const chip = { nome: 'chip-exemplo' }; // organização de teste")).toEqual([]);
    expect(regras("<line x1='0' x2='10' />")).toEqual([]);
  });

  it("isenção por REGRA, não por arquivo: LICENSE e NOTICE só da atribuição legal", () => {
    const marca = j("Desk", "commCRM");
    const autor = j("mel", "garafael");
    const titular = j("ALQUI", "M(IA) Performance");
    for (const arq of ["LICENSE", "NOTICE.md"]) {
      expect(acharNoTexto(arq, `${marca} ${autor}`, hashes)).toEqual([]);
      expect(acharNoTexto(arq, j("contato: fulano@", "gmail.com"), hashes)).toEqual([
        { arquivo: arq, linha: 1, regra: "email-pessoal" },
      ]);
      expect(acharNoTexto(arq, j("C:\\", "Users\\x"), hashes).map((a) => a.regra)).toEqual(["caminho-do-pc"]);
    }
    expect(acharNoTexto("LICENSE", `Copyright (c) 2026 ${titular}`, hashes)).toEqual([]);
    expect(acharNoTexto("LICENSE", j("Copyright a ALQ", "UIM"), hashes).map((a) => a.regra)).toEqual(["nome-do-produto"]);
    expect(acharNoTexto("NOTICE.md", titular, hashes).map((a) => a.regra)).toEqual(["nome-do-produto"]);
    // As duas linhas exatas do crédito passam (com ou sem \r); editadas, ou noutro arquivo, não.
    const copyright = j("Copyright (c) 2026 ", titular, ". Distribuído sob a licença MIT (veja [LICENSE](LICENSE)).");
    const mudancas = j("Evolution API, motor de disparo, marca) são de ", titular, ".");
    expect(acharNoTexto("NOTICE.md", `${copyright}\n${mudancas}\r\n`, hashes)).toEqual([]);
    expect(acharNoTexto("NOTICE.md", `${copyright} e mais`, hashes).map((a) => a.regra)).toEqual(["nome-do-produto"]);
    expect(acharNoTexto("NOTICE.md", `${mudancas} ${j("a ALQ", "UIM")}`, hashes).map((a) => a.regra)).toEqual(["nome-do-produto"]);
    expect(acharNoTexto("README.md", copyright, hashes).map((a) => a.regra)).toEqual(["nome-do-produto"]);
    expect(acharNoTexto("docs/NOTICE.md", marca, hashes).map((a) => a.regra)).toEqual(["marca-da-origem"]);
    expect(acharNoTexto("README.en.md", marca, hashes).map((a) => a.regra)).toEqual(["marca-da-origem"]);
  });

  it("README.md: só a frase de crédito exata sai da linha", () => {
    const credito = CREDITO_DO_README;
    expect(credito.endsWith("(MIT).")).toBe(true);
    expect(acharNoTexto("README.md", credito, hashes)).toEqual([]);
    expect(acharNoTexto("README.md", `> *${credito}*`, hashes)).toEqual([]);
    expect(acharNoTexto("README.md", credito.slice(0, -1), hashes).map((a) => a.regra)).toEqual(["marca-da-origem"]);
    expect(acharNoTexto("README.en.md", credito, hashes).map((a) => a.regra)).toEqual(["marca-da-origem"]);
    expect(acharNoTexto("README.md", `${credito} ${j("fulano@", "gmail.com")}`, hashes).map((a) => a.regra)).toEqual(["email-pessoal"]);
    expect(acharNoTexto("README.md", `${credito}\n${j("Desk", "commCRM de novo")}`, hashes)).toEqual([
      { arquivo: "README.md", linha: 2, regra: "marca-da-origem" },
    ]);
  });

  it("devolve o número da linha (1-based) e o relatório não carrega o trecho", () => {
    const a = acharNoTexto("lib/x.ts", `ok\nok\n${j("Desk", "comm")} aqui\nok`, hashes);
    expect(a).toEqual([{ arquivo: "lib/x.ts", linha: 3, regra: "marca-da-origem" }]);
    expect(mascarar("evidence/5511999998888.png")).toBe("evidence/#############.png");
  });

  it("binários: só os da lista passam; UTF-16 com BOM é decodificado; NUL em .ts continua texto", () => {
    expect(decodificar("a/b.png", Buffer.from([1, 2, 3])).tipo).toBe("binario");
    expect(decodificar("a/b.dat", Buffer.from([65, 0, 66, 0, 67, 0, 1])).tipo).toBe("binario");
    expect(decodificar("a/caso.test.ts", Buffer.from("const s = '\0';")).tipo).toBe("texto");
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(j("Desk", "comm"), "utf16le")]);
    const rLe = decodificar("a/b.txt", le);
    expect(rLe.tipo === "texto" && rLe.texto).toBe(j("Desk", "comm"));
    const be = Buffer.from(le);
    be.subarray(2).swap16();
    be[0] = 0xfe;
    be[1] = 0xff;
    const rBe = decodificar("a/b.txt", be);
    expect(rBe.tipo === "texto" && rBe.texto).toBe(j("Desk", "comm"));
    expect(acharNoTexto("a/b.txt", rLe.tipo === "texto" ? rLe.texto : "", hashes).map((x) => x.regra)).toEqual(["marca-da-origem"]);
    expect(BINARIOS_PERMITIDOS.has("public/icone-crm-512.png")).toBe(true);
    expect(BINARIOS_PERMITIDOS.has("evidence/qualquer.png")).toBe(false);
  });
});

describe("portão de limpeza: nada que não possa ser público nos arquivos rastreados", () => {
  it("este próprio arquivo não carrega nenhum dos padrões que procura (não se autoisenta)", () => {
    const meu = readFileSync(__filename, "utf8");
    expect(acharNoTexto("tests/unit/sem-dado-de-operacao.test.ts", meu)).toEqual([]);
  });

  it("nenhum arquivo rastreado carrega dado que não pode ser público", { timeout: 120_000 }, () => {
    const t0 = Date.now();
    const { arquivosLidos, achados } = varrerRepositorio();
    const ms = Date.now() - t0;

    const porRegra = new Map<string, number>();
    for (const a of achados) porRegra.set(a.regra, (porRegra.get(a.regra) ?? 0) + 1);
    const arquivosComAchado = new Set(achados.map((a) => a.arquivo)).size;

    const resumo = [...porRegra.entries()].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r}=${n}`).join(", ");
    const primeiras = achados
      .slice(0, 20)
      .map((a) => `  ${mascarar(a.arquivo)}:${a.linha} [${a.regra}]`)
      .join("\n");

    const mensagem =
      `${achados.length} ocorrência(s) em ${arquivosComAchado} arquivo(s), de ${arquivosLidos} lidos (${ms} ms).\n` +
      `Por regra: ${resumo || "nenhuma"}.\n` +
      `Primeiras ${Math.min(20, achados.length)}:\n${primeiras}\n` +
      `(O trecho da linha não é impresso de propósito. Termos da operação: _oss/auditoria-operacao.mjs; telefones: _oss/auditoria-telefones.mjs.)`;

    expect(achados.length, mensagem).toBe(0);
  });
});
