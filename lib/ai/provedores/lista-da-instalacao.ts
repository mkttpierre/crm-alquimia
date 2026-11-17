/**
 * A LISTA VIVA DO PROVEDOR QUE TEM CHAVE NO AMBIENTE DA INSTALAÇÃO.
 *
 * Quando o ponto usa "da instalação", a tela listava o catálogo `ai_models`
 * como se fosse o que a chave libera. Não é: o catálogo é global e semeado à
 * mão. Aqui o servidor pergunta ao provedor com a chave do `.env`, pelo MESMO
 * validador das credenciais (`lib/ai/provider-validators.ts`, paginado na
 * Anthropic) e pela MESMA filtragem de conversa e ferramentas
 * (`lib/ai/pontos/modelos-vivos.ts`).
 *
 *  - **A chave nunca sai daqui.** Ela é lida do ambiente só dentro desta
 *    função, vai no cabeçalho do validador e não entra no resultado nem em log.
 *  - **Cache em memória de 1 h por provedor** (5 min para a falha): a tela
 *    abre muitas vezes, e cada abertura não pode virar uma ida ao provedor.
 *  - **Falhou, não conferiu.** Sem lista viva, o resultado diz "não conferida"
 *    e não traz modelo nenhum — a tela não pode trocar a falha pelo catálogo.
 */
import { modelosVivos, type ModeloVivo } from "@/lib/ai/pontos/modelos-vivos";
import { validateProviderKey, type Provider } from "@/lib/ai/provider-validators";
import { lerChaveDaInstalacao, type FonteDeAmbiente } from "@/lib/instalacao/ambiente";

export interface ListaDaInstalacao {
  conferida: boolean;
  /** Por que não conferiu (`sem_chave`, `auth_failed_401`, `catalogo_indisponivel_503`…). */
  motivo?: string;
  modelos: ModeloVivo[];
  lidaEm: string | null;
}

const VALIDADE_MS = 60 * 60 * 1000;
const VALIDADE_DA_FALHA_MS = 5 * 60 * 1000;

const cache = new Map<string, { expiraEm: number; lista: ListaDaInstalacao }>();

export function __limparCacheParaTeste(): void {
  cache.clear();
}

export async function listaDaInstalacao(
  provider: string,
  opcoes: { fonte?: FonteDeAmbiente; agora?: Date } = {},
): Promise<ListaDaInstalacao> {
  const agora = opcoes.agora ?? new Date();
  const chave = lerChaveDaInstalacao(provider, opcoes.fonte);
  if (chave === null) return { conferida: false, motivo: "sem_chave", modelos: [], lidaEm: null };

  const guardada = cache.get(provider);
  if (guardada && guardada.expiraEm > agora.getTime()) return guardada.lista;

  let lista: ListaDaInstalacao;
  const r = await validateProviderKey(provider as Provider, chave);
  if (!r.ok) {
    lista = { conferida: false, motivo: r.error, modelos: [], lidaEm: null };
  } else if (r.models === undefined) {
    lista = { conferida: false, motivo: r.aviso ?? "catalogo_indisponivel", modelos: [], lidaEm: null };
  } else {
    const lidaEm = agora.toISOString();
    lista = {
      conferida: true,
      modelos: modelosVivos({
        id: `instalacao:${provider}`,
        provider,
        label: "instalação",
        api_key_last4: null,
        validated_at: lidaEm,
        validation_error: null,
        models_available: r.models,
        models_tools: r.modelsTools ?? null,
        is_active: true,
      }),
      lidaEm,
    };
  }
  cache.set(provider, {
    expiraEm: agora.getTime() + (lista.conferida ? VALIDADE_MS : VALIDADE_DA_FALHA_MS),
    lista,
  });
  return lista;
}
