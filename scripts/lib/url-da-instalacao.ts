import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const LOCAIS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Só a linha `CRM_ALQUIMIA_PORTA_APP=` do `.env.local` (não é segredo); "" se não houver. */
function portaDoAppNoEnvLocal(raiz: string): string {
  const arquivo = join(raiz, ".env.local");
  if (!existsSync(arquivo)) return "";
  for (const linha of readFileSync(arquivo, "utf8").split(/\r?\n/)) {
    if (linha.startsWith("CRM_ALQUIMIA_PORTA_APP=")) return linha.slice("CRM_ALQUIMIA_PORTA_APP=".length).trim();
  }
  return "";
}

/**
 * O endereço da instalação que a spec de instalação vai medir. A spec CRIA conta e organização no CRM que
 * encontrar, então não há padrão: sem `CRM_ALQUIMIA_URL` recusa (numa máquina que já roda outro sistema na
 * 3000, um padrão `localhost:3000` criaria conta nele). Se o `.env.local` desta pasta diz outra porta do app e
 * a URL é local, também recusa.
 */
export function urlDaInstalacao(env: Record<string, string | undefined>, raiz: string): string {
  const bruta = (env.CRM_ALQUIMIA_URL ?? "").trim();
  if (bruta === "") {
    throw new Error(
      "Defina CRM_ALQUIMIA_URL com o endereço da instalação que você quer medir (ex.: http://localhost:3100). " +
        "Sem ela esta spec não roda: ela cria uma conta no CRM que encontrar, e localhost:3000 pode ser outro sistema nesta máquina.",
    );
  }
  let url: URL;
  try {
    url = new URL(bruta);
  } catch {
    throw new Error(`CRM_ALQUIMIA_URL=${bruta} não é um endereço (ex.: http://localhost:3100).`);
  }
  const porta = url.port || (url.protocol === "https:" ? "443" : "80");
  const daInstalacao = portaDoAppNoEnvLocal(raiz);
  if (daInstalacao !== "" && LOCAIS.has(url.hostname) && porta !== daInstalacao) {
    throw new Error(
      `CRM_ALQUIMIA_URL aponta para a porta ${porta}, mas o app desta instalação está na ${daInstalacao} ` +
        `(CRM_ALQUIMIA_PORTA_APP no .env.local). Use http://localhost:${daInstalacao}.`,
    );
  }
  return bruta.replace(/\/+$/, "");
}
