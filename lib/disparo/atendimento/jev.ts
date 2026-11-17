/**
 * Cliente do Jev (TypeSafe System One) pela OpenRouter: julgamento barato sobre
 * texto. Ele não escreve nem decide o rumo — devolve probabilidade (`noul`),
 * escolha entre opções (`choice`) ou nota (`score`). Portado de um motor anterior
 * (`src/lib/jev.ts`), com duas mudanças: a chave e o `fetch` são INJETADOS (o
 * teste nunca chama a rede e o servidor lê `OPENROUTER_API_KEY` do ambiente,
 * nunca de arquivo do usuário), e a chave nunca aparece em erro nem em log.
 *
 * Sem chave, em erro de rede, em status ruim ou no tempo estourado: null, e o
 * atendimento segue só nas regras (modo seguro).
 */

export type Pergunta =
  | { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> }
  | { type: "score"; instructions: string; criteria: string[] };

export type RespostaJev =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities?: Record<string, number>; confidence: number }
  | { type: "score"; score: number; confidence: number };

export const URL_JEV = "https://openrouter.ai/api/alpha/decisions";
export const MODELO_JEV_PADRAO = "typesafe/jev-1.13";

export type Julgar = <K extends string>(
  state: unknown,
  perguntas: Record<K, Pergunta>,
) => Promise<{ respostas: Partial<Record<K, RespostaJev>>; tokens: number } | null>;

export type OpcoesJev = {
  chave: string | null | undefined;
  modelo?: string | null;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Espera antes da segunda tentativa (429/529). Teste passa 0. */
  esperaMs?: number;
};

/** Julgador ligado à chave do ambiente. Sem chave devolve um que sempre diz null. */
export function criarJulgar(o: OpcoesJev): Julgar {
  const chave = o.chave?.trim();
  if (!chave) return async () => null;
  const f = o.fetch ?? fetch;
  const modelo = o.modelo?.trim() || MODELO_JEV_PADRAO;
  const timeoutMs = o.timeoutMs ?? 8000;
  const esperaMs = o.esperaMs ?? 700;
  return async (state, perguntas) => {
    for (let tentativa = 0; tentativa < 2; tentativa++) {
      try {
        const r = await f(URL_JEV, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${chave}` },
          body: JSON.stringify({ model: modelo, state, questions: perguntas }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        // 429 (limite) e 529 (sobrecarga) merecem mais uma tentativa; o resto é erro de verdade.
        if ((r.status === 429 || r.status === 529) && tentativa === 0) {
          if (esperaMs) await new Promise((ok) => setTimeout(ok, esperaMs));
          continue;
        }
        if (!r.ok) return null;
        const j = (await r.json()) as { answers?: Record<string, RespostaJev>; usage?: { input_tokens?: number; output_tokens?: number } };
        if (!j?.answers || typeof j.answers !== "object") return null;
        return {
          respostas: j.answers as Partial<Record<keyof typeof perguntas & string, RespostaJev>>,
          tokens: (j.usage?.input_tokens ?? 0) + (j.usage?.output_tokens ?? 0),
        };
      } catch {
        return null;
      }
    }
    return null;
  };
}

/** Atalhos para ler uma resposta já no tipo certo (undefined se veio outra coisa). */
export const prob = (r: RespostaJev | undefined) => (r?.type === "noul" && typeof r.noul === "number" ? r.noul : undefined);
export const escolha = (r: RespostaJev | undefined) =>
  r?.type === "choice" && typeof r.choice === "string" && typeof r.confidence === "number"
    ? { opcao: r.choice, confianca: r.confidence }
    : undefined;
