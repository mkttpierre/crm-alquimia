/**
 * O ENDEREÇO DO OLLAMA (modelo local) E A POLÍTICA DE REDE QUE O ACOMPANHA.
 *
 * O Ollama roda na máquina de quem opera, ou na rede dela, e não pede chave. Por
 * isso o endereço dele é, ao mesmo tempo, o caso legítimo MAIS local do produto
 * (`http://localhost:11434`) e o que a regra dos outros provedores proíbe
 * (`./endereco-proprio.ts`: https, público, resolvendo para IP público — porque
 * lá ele é para onde a CHAVE vai).
 *
 * As duas regras são separadas de propósito, e esta não afrouxa a outra:
 *
 *  - Para anthropic/openai/google/openrouter nada muda. Endereço local ou
 *    privado continua recusado por `conferirEnderecoProprio`.
 *  - Aqui, endereço local/privado é aceito SÓ para o provedor `ollama` e SÓ
 *    quando quem grava é admin (`porAdmin`). Não há chave para exfiltrar, mas
 *    há SSRF: o servidor faz um GET nesse endereço (e o runtime manda o
 *    prompt, com dado do cliente). Quem pode apontar o servidor para a rede
 *    interna tem de ser quem já administra a instalação.
 *
 * Aceita:
 *  - `localhost` (e `*.localhost`), 127.0.0.0/8, `::1`;
 *  - `host.docker.internal` (o app em contêiner falando com o Ollama do host);
 *  - IPv4 privado (10/8, 172.16/12, 192.168/16) e CGNAT (100.64/10, onde mora o
 *    Tailscale), IPv6 ULA (fc00::/7);
 *  - um nome (rede interna, serviço do compose, domínio próprio) cujos endereços
 *    resolvidos sejam TODOS locais/privados OU TODOS públicos — misturar é a
 *    assinatura de DNS rebinding e é recusado.
 * Recusa SEMPRE, para qualquer papel: link-local (169.254/16 — o metadata da
 * nuvem entrega credencial de instância —, fe80::/10, e o metadata IPv6 da AWS,
 * fd00:ec2::/32), 0.0.0.0, multicast,
 * reservadas, usuário/senha na URL, query e fragmento, caminho (o endereço é do
 * servidor, a aplicação acrescenta `/api/tags` e `/v1`) e protocolo que não seja
 * http/https. Endereço PÚBLICO só com https: o prompt carrega dado do cliente.
 *
 * A guarda de rede do runtime é a mesma de todo egress: o registry contém o
 * `fetch` do SDK na allowlist do host (`lib/agent-engine/edge/egress.ts`), e o
 * validador chama `/api/tags` por `allowlistedFetch` — que também não segue
 * redirecionamento para fora do host.
 *
 * Janela residual declarada (a mesma de `lib/automation/outbound-ip.ts`): entre
 * a resolução de DNS e o `fetch` o nome pode mudar de resposta. Quem aponta
 * para nome (e não IP) aceita isso; admin é o único que pode.
 */
import { lookup } from "node:dns/promises";
import { isIPv4, isIPv6 } from "node:net";

import { ipEhEspecial } from "@/lib/automation/outbound-ip";

/** O endereço que o Ollama usa por padrão quando instalado na própria máquina. */
export const ENDERECO_PADRAO_DO_OLLAMA = "http://localhost:11434";

/** Resolve um nome para seus endereços. Injetável para teste. */
export type ResolvedorDeEnderecos = (hostname: string) => Promise<string[]>;

export const resolverEnderecos: ResolvedorDeEnderecos = async (hostname) => {
  const r = await lookup(hostname, { all: true });
  return r.map((x) => x.address);
};

export type ClasseDeIp = "local" | "privado" | "publico" | "proibido";

function ipv4ParaInt(ip: string): number {
  return ip.split(".").reduce((acc, p) => acc * 256 + Number(p), 0);
}

function dentro(ip: string, base: string, prefixo: number): boolean {
  const mascara = prefixo === 0 ? 0 : (0xffffffff << (32 - prefixo)) >>> 0;
  return ((ipv4ParaInt(ip) & mascara) >>> 0) === ((ipv4ParaInt(base) & mascara) >>> 0);
}

/**
 * Classifica um IP literal. `proibido` é o que NENHUM papel alcança: link-local
 * (inclui o metadata de nuvem), "este host", multicast, reservada e as faixas de
 * documentação. `local` = loopback; `privado` = rede interna que um admin pode
 * apontar de propósito.
 */
export function classificarIp(ip: string): ClasseDeIp {
  if (isIPv4(ip)) {
    if (dentro(ip, "127.0.0.0", 8)) return "local";
    if (
      dentro(ip, "10.0.0.0", 8) ||
      dentro(ip, "172.16.0.0", 12) ||
      dentro(ip, "192.168.0.0", 16) ||
      dentro(ip, "100.64.0.0", 10)
    ) {
      return "privado";
    }
    // O resto das faixas especiais (0/8, 169.254/16, 192.0.0/24, TEST-NET,
    // benchmark, multicast, reservada) o julgamento de IP do webhook já conhece.
    return ipEhEspecial(ip) ? "proibido" : "publico";
  }
  if (isIPv6(ip)) {
    const normal = ip.toLowerCase();
    const mapeado = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normal);
    if (mapeado?.[1]) return classificarIp(mapeado[1]);
    // `new URL` reescreve `[::ffff:127.0.0.1]` como `[::ffff:7f00:1]`: decide pelo IPv4 embutido.
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(normal);
    if (hex?.[1] && hex[2]) {
      const alto = parseInt(hex[1], 16);
      const baixo = parseInt(hex[2], 16);
      return classificarIp(`${alto >> 8}.${alto & 255}.${baixo >> 8}.${baixo & 255}`);
    }
    if (normal === "::1") return "local";
    // Metadata IPv6 da AWS (fd00:ec2::254) mora DENTRO da faixa ULA que o admin
    // pode apontar de propósito — entrega credencial de instância, como o 169.254.169.254.
    if (/^fd00:0*ec2:/.test(normal)) return "proibido";
    if (/^f[cd]/.test(normal)) return "privado"; // ULA fc00::/7
    if (normal === "::" || normal.startsWith("fe80") || normal.startsWith("ff")) return "proibido";
    return ipEhEspecial(ip) ? "proibido" : "publico";
  }
  return "proibido";
}

export type ResultadoDoEndereco =
  | { ok: true; url: string; local: boolean }
  | { ok: false; codigo: "endereco_invalido" | "endereco_inseguro" | "endereco_local_so_admin"; mensagem: string };

const MENSAGEM_LOCAL_SO_ADMIN =
  "Endereço local ou de rede interna só pode ser definido por uma pessoa com papel admin.";

interface Opcoes {
  /** Quem grava é admin (sessão `requireRole("admin")`)? Sem isso, só endereço público. */
  porAdmin: boolean;
  resolver?: ResolvedorDeEnderecos;
}

/** Só o que não precisa de DNS: forma da URL e host literal. Devolve a URL normalizada. */
function lerForma(
  bruto: string,
): { ok: true; u: URL; host: string; literal: ClasseDeIp | null; nomeLocal: boolean } | Extract<ResultadoDoEndereco, { ok: false }> {
  const invalido = (mensagem: string) => ({ ok: false as const, codigo: "endereco_invalido" as const, mensagem });
  let u: URL;
  try {
    u = new URL(bruto.trim());
  } catch {
    return invalido("O endereço do Ollama não é uma URL válida. Ex.: http://localhost:11434");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return invalido("O endereço do Ollama precisa começar com http:// ou https://.");
  }
  if (u.username !== "" || u.password !== "") {
    return invalido("O endereço do Ollama não pode trazer usuário ou senha na URL.");
  }
  if (u.search !== "" || u.hash !== "") {
    return invalido("O endereço do Ollama não pode ter parâmetros (?…) nem âncora (#…).");
  }
  if (u.pathname !== "/" && u.pathname !== "") {
    return invalido(
      "Informe só o endereço do servidor (ex.: http://localhost:11434), sem caminho: o CRM acrescenta /api/tags e /v1.",
    );
  }

  const host = u.hostname.toLowerCase();
  const semColchete = host.replace(/^\[|\]$/g, "");
  if (isIPv4(semColchete) || isIPv6(semColchete)) {
    return { ok: true, u, host: semColchete, literal: classificarIp(semColchete), nomeLocal: false };
  }
  const nomeLocal = host === "localhost" || host.endsWith(".localhost") || host === "host.docker.internal";
  return { ok: true, u, host, literal: null, nomeLocal };
}

function normalizar(u: URL): string {
  return `${u.protocol}//${u.host}`;
}

const NEGADO_PROIBIDO = {
  ok: false as const,
  codigo: "endereco_inseguro" as const,
  mensagem:
    "Esse endereço não é aceito: link-local (169.254.x.x), 0.0.0.0, multicast e faixas reservadas ficam sempre de fora.",
};

/**
 * A parte SÍNCRONA da política, sem DNS: usada onde não dá para esperar rede
 * (a fábrica do registry, `buildModel`). Recusa o que é proibido para todo mundo
 * e devolve a URL normalizada. NÃO decide o papel nem resolve nomes — quem
 * grava a credencial passa por `conferirEnderecoOllama`.
 */
export function normalizarEnderecoOllama(bruto: string): ResultadoDoEndereco {
  const forma = lerForma(bruto);
  if (!forma.ok) return forma;
  if (forma.literal === "proibido") return NEGADO_PROIBIDO;
  return { ok: true, url: normalizar(forma.u), local: forma.literal === "local" || forma.nomeLocal };
}

/**
 * A política completa, para quem GRAVA ou REVALIDA a credencial. Endereço local
 * ou privado só com `porAdmin`; público só com https; nome resolvido com
 * endereços misturados (públicos e internos) é recusado.
 */
export async function conferirEnderecoOllama(
  bruto: string,
  opcoes: Opcoes,
): Promise<ResultadoDoEndereco> {
  const forma = lerForma(bruto);
  if (!forma.ok) return forma;
  const { u, host } = forma;
  const url = normalizar(u);
  const interno = (local: boolean): ResultadoDoEndereco =>
    opcoes.porAdmin
      ? { ok: true, url, local }
      : { ok: false, codigo: "endereco_local_so_admin", mensagem: MENSAGEM_LOCAL_SO_ADMIN };
  const publico = (): ResultadoDoEndereco =>
    u.protocol === "https:"
      ? { ok: true, url, local: false }
      : {
          ok: false,
          codigo: "endereco_inseguro",
          mensagem:
            "Endereço público do Ollama precisa ser https://: as conversas com o cliente viajam nele.",
        };

  if (forma.literal !== null) {
    if (forma.literal === "proibido") return NEGADO_PROIBIDO;
    if (forma.literal === "publico") return publico();
    return interno(forma.literal === "local");
  }
  if (forma.nomeLocal) return interno(true);

  let enderecos: string[];
  try {
    enderecos = await (opcoes.resolver ?? resolverEnderecos)(host);
  } catch {
    return {
      ok: false,
      codigo: "endereco_inseguro",
      mensagem: "O nome do endereço do Ollama não resolve. Confira se digitou certo e se o servidor está de pé.",
    };
  }
  if (enderecos.length === 0) {
    return {
      ok: false,
      codigo: "endereco_inseguro",
      mensagem: "O nome do endereço do Ollama não resolve. Confira se digitou certo e se o servidor está de pé.",
    };
  }
  const classes = enderecos.map(classificarIp);
  if (classes.includes("proibido")) return NEGADO_PROIBIDO;
  const todosPublicos = classes.every((c) => c === "publico");
  const nenhumPublico = classes.every((c) => c !== "publico");
  if (!todosPublicos && !nenhumPublico) {
    return {
      ok: false,
      codigo: "endereco_inseguro",
      mensagem:
        "Esse nome aponta ao mesmo tempo para endereço público e para rede interna — não é aceito (risco de redirecionamento de DNS).",
    };
  }
  return todosPublicos ? publico() : interno(classes.every((c) => c === "local"));
}
