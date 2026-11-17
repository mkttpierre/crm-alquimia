/**
 * Revoga a instância Evolution de uma conexão que está sendo excluída.
 *
 * É TENTATIVA, não portão: a exclusão no CRM segue em qualquer desfecho, então
 * esta função NUNCA lança. Servidor fora do ar, apikey errada, instância que já
 * não existe — tudo vira `{ revogado: false, motivo }`, e quem chama avisa o
 * operador de que o aparelho pode continuar conectado.
 *
 * O logout é tentativa: a Evolution recusa (400) o logout de instância já
 * fechada, e o chip desconectado é justamente o caso comum de quem limpa conexão
 * velha. Quem decide é o DELETE da instância — tentado sempre, mesmo quando o
 * logout falha —, e `revogado` é o desfecho dele: instância removida do servidor
 * não tem por onde seguir conectada a este CRM.
 */
import type { EvolutionCredentials } from "./credentials";
import { deslogarInstancia, excluirInstancia } from "./client";

export interface RevogacaoEvolution {
  revogado: boolean;
  /** Só quando `revogado` é false. Para log e auditoria; nunca leva a apikey. */
  motivo?: string;
}

function motivoDo(err: unknown, apiKey: string): string {
  const msg = err instanceof Error ? err.message : String(err);
  return apiKey ? msg.split(apiKey).join("***") : msg;
}

export async function revogarInstanciaEvolution(
  creds: EvolutionCredentials,
  instancia: string,
): Promise<RevogacaoEvolution> {
  const alvo: EvolutionCredentials = { ...creds, instance: instancia };
  let falhaDoLogout: string | null = null;
  try {
    await deslogarInstancia(alvo);
  } catch (err) {
    falhaDoLogout = motivoDo(err, creds.apiKey);
  }
  try {
    await excluirInstancia(alvo);
    return { revogado: true };
  } catch (err) {
    const falhaDoDelete = motivoDo(err, creds.apiKey);
    return {
      revogado: false,
      motivo: falhaDoLogout ? `${falhaDoLogout} | ${falhaDoDelete}` : falhaDoDelete,
    };
  }
}
