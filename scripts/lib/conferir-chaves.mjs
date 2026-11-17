#!/usr/bin/env node
// Conferências das chaves desta instalação, usadas pelos dois instaladores (instalar.sh e instalar.ps1).
// NUNCA imprime chave, segredo nem trecho de arquivo: no máximo o NOME do que falta ou um código curto.
//
//   estado-chave SIGNING_KEYS        imprime ausente | sem-privada | valida | invalida
//   config CONFIG_TOML               0 se o [auth] aponta para as chaves desta instalação; 1 e os nomes que faltam
//   jwks SIGNING_KEYS URL [N]        0 o JWKS vivo publica só chaves do arquivo (e a que assina); 1 não bate;
//                                    2 sem resposta (N tentativas, 1 s entre elas)
//   auth SIGNING_KEYS                stdin: `docker inspect --format {{json .Config}}` do contêiner do Auth
//   kong                             stdin: o mesmo, do Kong, mais o kong.yml (onde ficam as chaves sb_)
//                                    0 usa as chaves desta instalação (ou stdin vazio: nada a conferir);
//                                    1 e o motivo (texto-env, segredo-do-jwt, chave-de-assinatura, chave-da-api)
//
// Os segredos vêm do ambiente (CRM_ALQUIMIA_JWT_SECRET, CRM_ALQUIMIA_SECRET_KEY, CRM_ALQUIMIA_PUBLISHABLE_KEY),
// que o instalador já exportou para a CLI do Supabase.
import { readFileSync } from "node:fs";

const [comando, ...args] = process.argv.slice(2);

/** As linhas do [auth] que fazem a CLI usar as chaves desta instalação, e não as dela (públicas). */
const LINHAS_DO_AUTH = {
  signing_keys_path: 'signing_keys_path = "./signing_keys.json"',
  jwt_secret: 'jwt_secret = "env(CRM_ALQUIMIA_JWT_SECRET)"',
  publishable_key: 'publishable_key = "env(CRM_ALQUIMIA_PUBLISHABLE_KEY)"',
  secret_key: 'secret_key = "env(CRM_ALQUIMIA_SECRET_KEY)"',
};

function lerChaves(arquivo) {
  let texto;
  try {
    texto = readFileSync(arquivo, "utf8");
  } catch {
    return { estado: "ausente", chaves: [] };
  }
  if (texto.trim() === "") return { estado: "ausente", chaves: [] };
  let lista;
  try {
    lista = JSON.parse(texto);
  } catch {
    return { estado: "invalida", chaves: [] };
  }
  if (!Array.isArray(lista)) return { estado: "invalida", chaves: [] };
  if (lista.length === 0) return { estado: "ausente", chaves: [] };
  const ok = (c) => c && typeof c === "object" && typeof c.kty === "string" && c.kty && typeof c.kid === "string" && c.kid;
  if (!lista.every(ok)) return { estado: "invalida", chaves: [] };
  // Uma chave com a parte privada (d) basta: as só públicas ao lado são as antigas de uma rotação.
  const temPrivada = lista.some((c) => typeof c.d === "string" && c.d);
  return { estado: temPrivada ? "valida" : "sem-privada", chaves: lista };
}

/**
 * O texto literal `env(NOME)` que a CLI deixa no lugar de uma variável que falta (o segredo vira o próprio texto,
 * público). Só a palavra inteira: `getenv(` e `setenv(`, que podem estar no comando de um contêiner, não contam.
 */
const TEXTO_ENV_LITERAL = /(?<![A-Za-z0-9_])env\([A-Z][A-Z0-9_]*\)/;

function lerStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function secaoAuth(toml) {
  const linhas = toml.split(/\r?\n/);
  const inicio = linhas.findIndex((l) => l.trim() === "[auth]");
  if (inicio < 0) return [];
  const fim = linhas.findIndex((l, i) => i > inicio && /^\s*\[/.test(l));
  return linhas.slice(inicio + 1, fim < 0 ? undefined : fim).map((l) => l.trim());
}

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

async function jwks(arquivo, url, tentativas) {
  const { chaves } = lerChaves(arquivo);
  const daInstalacao = new Set(chaves.map((c) => c.kid));
  const privadas = chaves.filter((c) => typeof c.d === "string" && c.d).map((c) => c.kid);
  for (let i = 0; i < tentativas; i++) {
    if (i > 0) await espera(1000);
    let corpo;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (!r.ok) continue;
      corpo = await r.json();
    } catch {
      continue;
    }
    const publicadas = Array.isArray(corpo?.keys) ? corpo.keys : null;
    if (!publicadas) continue;
    if (publicadas.some((k) => k?.kty === "oct")) return 1;
    if (!publicadas.every((k) => daInstalacao.has(k?.kid))) return 1;
    if (!publicadas.some((k) => privadas.includes(k?.kid))) return 1;
    return 0;
  }
  return 2;
}

function auth(arquivo, entrada) {
  if (entrada.trim() === "") return null;
  if (TEXTO_ENV_LITERAL.test(entrada)) return "texto-env";
  let config;
  try {
    config = JSON.parse(entrada);
  } catch {
    return null;
  }
  const env = new Map();
  for (const linha of Array.isArray(config?.Env) ? config.Env : []) {
    const i = String(linha).indexOf("=");
    if (i > 0) env.set(String(linha).slice(0, i), String(linha).slice(i + 1));
  }
  const nosso = process.env.CRM_ALQUIMIA_JWT_SECRET || "";
  if (env.has("GOTRUE_JWT_SECRET") && env.get("GOTRUE_JWT_SECRET") !== nosso) return "segredo-do-jwt";
  if (env.has("GOTRUE_JWT_KEYS")) {
    const { chaves } = lerChaves(arquivo);
    const daInstalacao = new Set(chaves.map((c) => c.kid));
    let vivas;
    try {
      vivas = JSON.parse(env.get("GOTRUE_JWT_KEYS"));
    } catch {
      return "chave-de-assinatura";
    }
    const kids = (Array.isArray(vivas) ? vivas : []).map((k) => k?.kid).filter(Boolean);
    if (kids.length === 0 || !kids.every((k) => daInstalacao.has(k))) return "chave-de-assinatura";
  }
  return null;
}

function kong(entrada) {
  if (entrada.trim() === "") return null;
  if (TEXTO_ENV_LITERAL.test(entrada)) return "texto-env";
  const nossas = new Set([process.env.CRM_ALQUIMIA_SECRET_KEY || "", process.env.CRM_ALQUIMIA_PUBLISHABLE_KEY || ""].filter(Boolean));
  for (const m of entrada.matchAll(/sb_(?:secret|publishable)_[A-Za-z0-9_-]+/g)) {
    if (!nossas.has(m[0])) return "chave-da-api";
  }
  return null;
}

async function principal() {
  switch (comando) {
    case "estado-chave": {
      process.stdout.write(lerChaves(args[0]).estado + "\n");
      return 0;
    }
    case "config": {
      let toml = "";
      try {
        toml = readFileSync(args[0], "utf8");
      } catch {
        process.stdout.write(Object.keys(LINHAS_DO_AUTH).join(", ") + "\n");
        return 1;
      }
      const auth = secaoAuth(toml);
      const faltam = Object.entries(LINHAS_DO_AUTH)
        .filter(([, linha]) => !auth.includes(linha))
        .map(([nome]) => nome);
      if (faltam.length === 0) return 0;
      process.stdout.write(faltam.join(", ") + "\n");
      return 1;
    }
    case "jwks":
      return jwks(args[0], args[1], Math.max(1, Number(args[2] || "10") || 1));
    case "auth":
    case "kong": {
      const motivo = comando === "auth" ? auth(args[0], lerStdin()) : kong(lerStdin());
      if (!motivo) return 0;
      process.stdout.write(motivo + "\n");
      return 1;
    }
    default:
      process.stderr.write("uso: conferir-chaves.mjs estado-chave|config|jwks|auth|kong ...\n");
      return 64;
  }
}

process.exitCode = await principal();
