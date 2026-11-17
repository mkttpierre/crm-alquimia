/** O que aparece na barra de atalhos do chat (mensagens prontas). */
export type TipoDeAtalho = "funil" | "mensagem" | "audio" | "imagem" | "video" | "documento";

export const ORDEM_DOS_TIPOS: readonly TipoDeAtalho[] = ["funil", "mensagem", "audio", "imagem", "video", "documento"];

export type ItemDeAtalho = {
  tipo: TipoDeAtalho;
  /** id do funil (`operator_funnels`) ou do modelo (`message_templates`). */
  id: string;
  nome: string;
  /** Atalho sem a barra, quando há. */
  atalho: string | null;
  palavrasChave: string[];
  favorito: boolean;
  /** Linha curta do cartão ("7 mensagens · ~1 min 24 s", começo do texto). */
  resumo: string;
};

export type Presenca = "nenhuma" | "digitando" | "gravando";

export type PassoDoFunil = {
  template_id: string;
  atraso_ms: number;
  presenca: Presenca;
  presenca_ms: number;
};

export type Funil = {
  id: string;
  nome: string;
  atalho: string;
  palavras_chave: string[];
  favorito: boolean;
  compartilhado: boolean;
  passos: PassoDoFunil[];
  duracao_ms: number;
};
