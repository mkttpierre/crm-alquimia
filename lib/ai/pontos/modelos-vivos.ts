/**
 * OS MODELOS QUE A CHAVE DO OPERADOR DE FATO LIBERA — a lista viva.
 *
 * O seletor de modelo da tela de Provedores lia `ai_models`, um catálogo global
 * semeado à mão (migration 0104) e sincronizado da OpenRouter. Ele não sabe
 * nada da CONTA de quem opera: oferecia modelo que a chave não alcança, e o
 * erro só aparecia no primeiro atendimento. A credencial, por outro lado, já
 * guardava a resposta real do provedor (`models_available`, gravada pelo
 * validador ao cadastrar ou revalidar) — e ninguém a lia.
 *
 * Este módulo é PURO (sem banco, sem rede) e responde quatro perguntas:
 *
 *  1. Este id é de um modelo de CONVERSA? (`ehModeloDeChat`) — a listagem dos
 *     provedores traz embeddings, transcrição, voz, imagem e moderação, que
 *     nenhum ponto de conversa sabe chamar.
 *  2. Quais modelos a credencial libera para um ponto? (`modelosVivos`)
 *  3. Qual o estado de cada provedor para esta organização? (`estadoDosProvedores`)
 *  4. A escolha que chegou para salvar está na lista viva? (`conferirNaListaViva`)
 *
 * A tela, a API com bearer e o MCP usam as mesmas funções: duas leituras da
 * mesma configuração é como se cria a tela que mente.
 */

/**
 * Padrões de id que NÃO são modelo de conversa. Por nome, porque é o único dado
 * que os quatro provedores devolvem em comum na listagem — e a lista é de
 * EXCLUSÃO de propósito: modelo de conversa novo, com nome que ninguém previu,
 * aparece; o que some é só o que tem cara clara de outra coisa.
 */
const NAO_E_CONVERSA: readonly RegExp[] = [
  /embed/i, // text-embedding-3-*, gemini-embedding-*, embedding-gecko
  /whisper/i,
  /transcrib/i, // gpt-4o-transcribe
  /(^|[-_/.])tts([-_/.]|$)/i, // tts-1, gemini-2.5-flash-preview-tts
  /speech/i,
  /dall-e/i,
  /gpt-image/i,
  /imagen/i,
  /image-generation/i,
  /-image(-|$)/i, // gemini-2.5-flash-image, *-image-preview
  /moderation/i,
  /realtime/i,
  /(^|[-_/])audio([-_/]|$)/i, // gpt-4o-audio-preview
  /(^|\/)(sora|veo|lyria)/i, // vídeo e música
  /(^|\/)aqa$/i, // "attributed QA" do Google, não conversa
  /(^|\/)(davinci|babbage)-00\d$/i, // completions legados, sem chat
];

export function ehModeloDeChat(modelId: string): boolean {
  const id = modelId.trim();
  if (id === "") return false;
  return !NAO_E_CONVERSA.some((re) => re.test(id));
}

/** O provedor funciona sem chave (modelo local)? Mesma lista de `provedores.ts`, sem importá-la: este módulo é puro e a lista é só um id. */
const SEM_CHAVE = new Set(["ollama"]);

/** O que a view segura de credenciais devolve — nunca a chave. */
export interface CredencialSegura {
  id: string;
  provider: string;
  label: string;
  api_key_last4: string | null;
  /** Só o provedor sem chave (ollama) tem endereço na credencial (migration 0260). */
  base_url?: string | null;
  validated_at: string | null;
  validation_error: string | null;
  models_available: string[] | null;
  /**
   * Os ids que o PROVEDOR declarou saber usar ferramentas (migration 0259).
   * `null` quando o provedor não informa isso na listagem — aí quem decide é o
   * catálogo `ai_models`, como antes.
   */
  models_tools?: string[] | null;
  is_active: boolean;
}

export interface ModeloVivo {
  model_id: string;
  /** `null` = o provedor não disse; a capacidade vem do catálogo. */
  supports_tools: boolean | null;
}

/** Credencial utilizável: ativa e com teste real bem-sucedido. */
export function credencialConectada(c: CredencialSegura): boolean {
  return c.is_active && c.validated_at !== null;
}

/**
 * Os modelos que esta credencial libera para um ponto.
 *
 * Credencial não validada não libera nada: lista de chave que nunca passou no
 * teste é a lista inventada que esta frente veio tirar da tela.
 */
export function modelosVivos(
  c: CredencialSegura,
  opcoes: { exigeFerramentas?: boolean } = {},
): ModeloVivo[] {
  if (!credencialConectada(c)) return [];
  const comFerramentas = c.models_tools == null ? null : new Set(c.models_tools);
  const vistos = new Set<string>();
  const saida: ModeloVivo[] = [];
  for (const bruto of c.models_available ?? []) {
    const id = bruto.trim();
    if (vistos.has(id) || !ehModeloDeChat(id)) continue;
    vistos.add(id);
    const supports_tools = comFerramentas === null ? null : comFerramentas.has(id);
    if (opcoes.exigeFerramentas === true && supports_tools === false) continue;
    saida.push({ model_id: id, supports_tools });
  }
  return saida.sort((a, b) => a.model_id.localeCompare(b.model_id));
}

export interface EstadoDoProvedor {
  provider: string;
  /** Há ao menos uma credencial ativa e validada. */
  conectado: boolean;
  /** Por que não está conectado, em português de gente. `null` se conectado. */
  motivo: string | null;
  /** A instalação tem chave deste provedor no ambiente (só o booleano). */
  daInstalacao: boolean;
  credenciais: Array<{
    id: string;
    label: string;
    api_key_last4: string | null;
    /** O endereço do servidor — só no provedor sem chave (ollama). */
    base_url: string | null;
    conectada: boolean;
    validated_at: string | null;
    validation_error: string | null;
    total_de_modelos: number;
  }>;
  /** Quando a lista mais recente foi lida do provedor (maior `validated_at`). */
  listaAtualizadaEm: string | null;
}

export function estadoDosProvedores(entrada: {
  provedores: readonly string[];
  credenciais: readonly CredencialSegura[];
  chavesDaInstalacao: Readonly<Record<string, boolean>>;
}): EstadoDoProvedor[] {
  return entrada.provedores.map((provider) => {
    const doProvedor = entrada.credenciais.filter((c) => c.provider === provider && c.is_active);
    const credenciais = doProvedor.map((c) => ({
      id: c.id,
      label: c.label,
      api_key_last4: c.api_key_last4,
      base_url: c.base_url ?? null,
      conectada: credencialConectada(c),
      validated_at: c.validated_at,
      validation_error: c.validation_error,
      total_de_modelos: modelosVivos(c).length,
    }));
    const conectado = credenciais.some((c) => c.conectada);
    const datas = credenciais
      .map((c) => c.validated_at)
      .filter((d): d is string => d !== null)
      .sort();
    let motivo: string | null = null;
    if (!conectado && SEM_CHAVE.has(provider)) {
      motivo =
        doProvedor.length === 0
          ? "Nenhum servidor Ollama conectado. Informe o endereço dele em Credenciais."
          : "O servidor Ollama cadastrado não respondeu ao teste. Confira o endereço e o servidor em Credenciais.";
    } else if (!conectado) {
      motivo =
        doProvedor.length === 0
          ? "Nenhuma chave deste provedor cadastrada. Cadastre e teste a chave em Credenciais."
          : "A chave cadastrada ainda não passou no teste com o provedor. Teste de novo em Credenciais.";
    }
    return {
      provider,
      conectado,
      motivo,
      daInstalacao: entrada.chavesDaInstalacao[provider] === true,
      credenciais,
      listaAtualizadaEm: datas.length > 0 ? datas[datas.length - 1]! : null,
    };
  });
}

export type ResultadoDaConferencia =
  | { ok: true }
  | { ok: false; codigo: string; mensagem: string };

/**
 * A escolha que chegou para salvar está na lista viva? (B7)
 *
 * Roda na ESCRITA, como `validarBinding`: na hora de salvar há alguém olhando
 * a tela para ler o motivo. Três situações:
 *
 *  - **Com credencial:** o modelo precisa estar na lista que o provedor
 *    devolveu para ESTA chave. Com endereço próprio (`base_url`) a lista
 *    oficial não vale — o gateway do operador serve os modelos dele — e a
 *    conferência não se aplica, como `validarBinding` já faz com modelo fora
 *    do catálogo.
 *  - **Sem credencial ("da instalação"):** só passa se a instalação tem chave
 *    do provedor (ou um gateway de IA). A lista, aí, segue sendo o catálogo —
 *    é o comportamento de antes, preservado para quem já usa a chave do `.env`.
 *  - **Sem nada:** recusa. Salvar um ponto sem chave nenhuma é configurar para
 *    falhar em silêncio.
 */
export function conferirNaListaViva(entrada: {
  provider: string;
  modelId: string;
  exigeFerramentas: boolean;
  baseUrl: string | null;
  credencial: CredencialSegura | null;
  daInstalacao: boolean;
}): ResultadoDaConferencia {
  const { credencial } = entrada;
  if (credencial === null) {
    // Só a chave DO PROVEDOR conta. O gateway de IA da instalação não conta:
    // sem credencial e sem a chave do provedor, o runtime cai no modelo
    // PADRÃO pelo gateway (`lib/ai/gateway-binding.ts`), e não no modelo
    // gravado aqui — salvar seria gravar um modelo que ninguém executa.
    if (entrada.daInstalacao) return { ok: true };
    if (SEM_CHAVE.has(entrada.provider)) {
      return {
        ok: false,
        codigo: "sem_chave",
        mensagem:
          `Escolha o servidor ${entrada.provider} conectado, ou conecte um em Credenciais informando o endereço. ` +
          `Sem conexão testada não há lista de modelos.`,
      };
    }
    return {
      ok: false,
      codigo: "sem_chave",
      mensagem:
        `Não há chave de ${entrada.provider} nesta organização nem na instalação. ` +
        `Cadastre e teste uma chave em Credenciais antes de escolher o modelo.`,
    };
  }

  if (!credencialConectada(credencial)) {
    return {
      ok: false,
      codigo: "credencial_nao_validada",
      mensagem:
        `A chave "${credencial.label}" ainda não passou no teste com o provedor, então não sabemos ` +
        `quais modelos ela libera. Teste a chave em Credenciais e tente de novo.`,
    };
  }

  if (entrada.baseUrl !== null && entrada.baseUrl.trim() !== "") return { ok: true };

  const lista = modelosVivos(credencial);
  const achado = lista.find((m) => m.model_id === entrada.modelId);
  if (achado === undefined) {
    return {
      ok: false,
      codigo: "modelo_fora_da_lista",
      mensagem:
        `"${entrada.modelId}" não está entre os modelos de conversa que a chave "${credencial.label}" libera. ` +
        `Escolha um modelo da lista, ou clique em "Atualizar modelos" se você acabou de ganhar acesso a ele.`,
    };
  }

  if (entrada.exigeFerramentas && achado.supports_tools === false) {
    return {
      ok: false,
      codigo: "modelo_sem_ferramentas",
      mensagem:
        `O provedor informa que "${entrada.modelId}" não sabe usar ferramentas. Neste ponto o agente ` +
        `conversaria normalmente, mas não criaria o lead nem moveria o funil. Escolha um modelo com ferramentas.`,
    };
  }

  return { ok: true };
}

/**
 * O provedor EFETIVO de um ponto (do binding ou do padrão da organização) tem
 * chave de verdade? É o que decide se a tela pode dizer "usando <modelo>".
 *
 * Com credencial escolhida, vale só ela (validada). Sem credencial escolhida,
 * vale o que o runtime usaria: uma credencial validada do provedor nesta
 * organização ou a chave do provedor no ambiente da instalação. Sem nenhuma,
 * o ponto não está conectado — e mostrar o id do modelo ali é mostrar um
 * modelo que não roda.
 */
export function pontoConectado(entrada: {
  provider: string;
  credentialId: string | null;
  credenciais: readonly CredencialSegura[];
  chavesDaInstalacao: Readonly<Record<string, boolean>>;
}): boolean {
  if (entrada.credentialId) {
    const c = entrada.credenciais.find((x) => x.id === entrada.credentialId);
    return c !== undefined && c.provider === entrada.provider && credencialConectada(c);
  }
  return (
    entrada.chavesDaInstalacao[entrada.provider] === true ||
    entrada.credenciais.some((c) => c.provider === entrada.provider && credencialConectada(c))
  );
}
