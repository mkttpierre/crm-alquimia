/**
 * O ENDEREÇO PRÓPRIO (`base_url`) DE UM PONTO É PARA ONDE A CHAVE VAI.
 *
 * O runtime decifra a chave da credencial e a manda, no cabeçalho, para o
 * `base_url` do binding (`lib/ai/gateway-binding.ts`). Aceitar qualquer URL ali
 * é abrir um canal de exfiltração: quem grava `https://meu-servidor/v1` recebe
 * a chave do operador na primeira chamada. E, apontado para a rede interna, é
 * SSRF com credencial.
 *
 * Por isso a regra, nesta ordem (`definirModeloDoPonto`):
 *  1. Só pela TELA, com sessão de admin. Pela API com bearer e pelo MCP, quem
 *     manda `base_url` recebe 422 — um token vazado não troca o destino da chave.
 *  2. Só `https:` e sem usuário/senha na URL.
 *  3. Nunca localhost, IP privado, link-local, nem literal IPv6 (o mesmo julgamento
 *     de IP do webhook de automação, `lib/automation/outbound-ip.ts`), e o nome
 *     precisa RESOLVER para endereço público.
 *
 * Modelo local (Ollama na própria máquina) fica, de propósito, fora deste
 * caminho: ele exige a política própria do item B4, que não entrou.
 */
import { isIPv4, isIPv6 } from "node:net";

import { assertDestinoResolvidoSeguro, ipEhEspecial } from "@/lib/automation/outbound-ip";

/** Lança quando o nome resolve para endereço que não é público. Injetável para teste. */
export type ResolvedorSeguro = (hostname: string) => Promise<void>;

const SUFIXOS_LOCAIS = [".localhost", ".local", ".internal", ".lan", ".home.arpa"];

export async function conferirEnderecoProprio(
  url: string,
  resolver: ResolvedorSeguro = assertDestinoResolvidoSeguro,
): Promise<{ ok: true } | { ok: false; mensagem: string }> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, mensagem: "O endereço próprio não é uma URL válida." };
  }
  if (u.protocol !== "https:") {
    return { ok: false, mensagem: "O endereço próprio precisa começar com https:// — a chave viaja nele." };
  }
  if (u.username !== "" || u.password !== "") {
    return { ok: false, mensagem: "O endereço próprio não pode trazer usuário ou senha na URL." };
  }

  const host = u.hostname.toLowerCase();
  const semColchete = host.replace(/^\[|\]$/g, "");
  const recusaLocal = {
    ok: false as const,
    mensagem:
      "O endereço próprio precisa ser público: localhost, rede interna, link-local e IPv6 local não são aceitos.",
  };
  if (host.startsWith("[") || isIPv6(semColchete)) return recusaLocal;
  if (host === "localhost" || SUFIXOS_LOCAIS.some((s) => host.endsWith(s))) return recusaLocal;
  if (isIPv4(host)) return ipEhEspecial(host) ? recusaLocal : { ok: true };

  try {
    await resolver(host);
  } catch {
    return {
      ok: false,
      mensagem:
        "O endereço próprio não resolve para um endereço público. Confira o nome — rede interna não é aceita.",
    };
  }
  return { ok: true };
}
