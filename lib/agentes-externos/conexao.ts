/**
 * O BLOCO DE CONEXÃO por atalho: o que o dono copia da tela e cola no cliente MCP do agente.
 *
 *  - OpenBot e Claude Code: `mcpServers` com `type: "http"`, a URL `<APP_URL>/api/mcp` e o header
 *    `Authorization: Bearer <token>` (o mesmo JSON serve aos dois: `.mcp.json` do Claude Code e a configuração de
 *    servidores MCP do OpenBot).
 *  - Codex: o equivalente em `~/.codex/config.toml`. O Codex lê o bearer de uma VARIÁVEL DE AMBIENTE
 *    (`bearer_token_env_var`), não do arquivo — o token não fica gravado em texto num arquivo de configuração. O bloco
 *    traz a linha de `export` junto, comentada, para o dono saber o que definir.
 *  - Outro: só a URL e o header.
 *
 * O token só existe na tela no momento da criação; depois disso o bloco sai com o marcador `<token>`.
 */
import type { TipoDeAgenteExterno } from "./modelo";

export const NOME_DO_SERVIDOR_MCP = "crm-alquimia";
export const VARIAVEL_DO_TOKEN_NO_CODEX = "CRM_ALQUIMIA_TOKEN";
export const MARCADOR_DO_TOKEN = "<token>";

/** `https://crm.exemplo.com` + `/api/mcp`, sem barra dobrada. */
export function urlDoMcp(appUrl: string): string {
  return `${appUrl.replace(/\/+$/, "")}/api/mcp`;
}

function blocoJson(url: string, token: string): string {
  return JSON.stringify(
    { mcpServers: { [NOME_DO_SERVIDOR_MCP]: { type: "http", url, headers: { Authorization: `Bearer ${token}` } } } },
    null,
    2,
  );
}

function blocoCodex(url: string, token: string): string {
  return [
    `# ~/.codex/config.toml`,
    `[mcp_servers.${NOME_DO_SERVIDOR_MCP}]`,
    `url = "${url}"`,
    `bearer_token_env_var = "${VARIAVEL_DO_TOKEN_NO_CODEX}"`,
    ``,
    `# No terminal, antes de abrir o Codex:`,
    `# export ${VARIAVEL_DO_TOKEN_NO_CODEX}="${token}"`,
  ].join("\n");
}

function blocoOutro(url: string, token: string): string {
  return [`URL: ${url}`, `Header: Authorization: Bearer ${token}`].join("\n");
}

export function blocoDeConexao(tipo: TipoDeAgenteExterno, appUrl: string, token: string = MARCADOR_DO_TOKEN): string {
  const url = urlDoMcp(appUrl);
  if (tipo === "codex") return blocoCodex(url, token);
  if (tipo === "outro") return blocoOutro(url, token);
  return blocoJson(url, token);
}
