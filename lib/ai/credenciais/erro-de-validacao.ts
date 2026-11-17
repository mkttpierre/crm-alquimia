/**
 * Os códigos de `lib/ai/provider-validators.ts` são bons para o banco e para o
 * audit; para quem colou a chave e viu "auth_failed_401", não dizem nada.
 * Esta é a única tradução de código para frase — o card não conhece os códigos.
 *
 * As frases são chaves de `t()`: pt-BR aqui, espanhol em `lib/i18n/dicionario.ts`.
 */
export interface ErroDescrito {
  frase: string;
  /** Vale oferecer o link "pegar chave em…"? Só quando a chave em si é o problema. */
  chaveErrada: boolean;
  /**
   * Caso genérico (código sem tradução conhecida): a `frase` já embute o
   * código cru e por isso NÃO pode passar inteira por `t()` — só a parte fixa
   * "Falha na validação" é chave de tradução. O card usa esta flag para saber
   * qual dos dois caminhos tomar, em vez de inspecionar `frase` por prefixo
   * (um `.startsWith(...)` na JSX do card conta, para o guarda de i18n, como
   * literal renderizado fora de `t()`).
   */
  generico: boolean;
}

const REDE = "Não foi possível falar com o provedor a partir deste servidor. Revalide mais tarde.";

export function descreverErroDeValidacao(codigo: string | null): ErroDescrito {
  if (!codigo) return { frase: "", chaveErrada: false, generico: false };

  if (codigo === "auth_failed_401") {
    return {
      frase: "O provedor recusou a chave. Confira se copiou inteira ou gere uma nova.",
      chaveErrada: true,
      generico: false,
    };
  }

  // Ollama (modelo local, sem chave): o problema é o ENDEREÇO ou o servidor.
  if (codigo === "ollama_inacessivel") {
    return {
      frase:
        "Não consegui falar com o Ollama nesse endereço. Confira se ele está rodando e lembre que \"localhost\" é o servidor do CRM, não o seu computador.",
      chaveErrada: false,
      generico: false,
    };
  }
  if (codigo === "endereco_inseguro" || codigo === "endereco_local_so_admin" || codigo === "endereco_invalido") {
    return {
      frase: "O endereço do Ollama não é aceito pela política de rede. Corrija o endereço em Credenciais.",
      chaveErrada: false,
      generico: false,
    };
  }
  if (codigo === "resposta_invalida") {
    return {
      frase: "O endereço respondeu, mas não parece ser um servidor Ollama (a lista de modelos veio fora do formato).",
      chaveErrada: false,
      generico: false,
    };
  }

  if (codigo === "provider_status_429") {
    return {
      frase: "O provedor limitou as chamadas desta chave. Tente de novo em alguns minutos.",
      chaveErrada: false,
      generico: false,
    };
  }

  if (/^provider_status_5\d\d$/.test(codigo)) {
    return {
      frase: "O provedor está fora do ar. A chave pode estar certa; revalide mais tarde.",
      chaveErrada: false,
      generico: false,
    };
  }

  if (
    codigo === "AbortError" ||
    codigo === "TimeoutError" ||
    codigo === "network_error" ||
    // `fetch` do Node lança `TypeError` para falha de rede/DNS (undici não usa
    // um nome próprio aqui) — sem isto, um self-host com firewall de saída
    // restrito via um "Falha na validação (TypeError)." cru, achado rodando a
    // spec de verdade contra o provedor real (não reproduz com mock).
    codigo === "TypeError"
  ) {
    return { frase: REDE, chaveErrada: false, generico: false };
  }

  return { frase: `Falha na validação (${codigo}).`, chaveErrada: false, generico: true };
}
