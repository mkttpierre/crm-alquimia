/** Modelos de mensagem e funis do operador viram os cartões da barra de atalhos do chat. Puro. */
import { duracaoEmTexto } from "../sequencias";
import type { Funil, ItemDeAtalho, TipoDeAtalho } from "./tipos";

type MidiaDoModelo = { kind: "audio" | "image" | "video" | "document" } | null | undefined;

export type ModeloParaAtalho = {
  id: string;
  title: string;
  body: string;
  shortcut: string | null;
  favorito?: boolean;
  palavras_chave?: string[];
  media?: MidiaDoModelo;
};

const TIPO_DA_MIDIA: Record<NonNullable<MidiaDoModelo>["kind"], TipoDeAtalho> = {
  audio: "audio",
  image: "imagem",
  video: "video",
  document: "documento",
};

const ROTULO_DA_MIDIA: Record<TipoDeAtalho, string> = {
  funil: "Funil",
  mensagem: "Mensagem",
  audio: "Áudio",
  imagem: "Imagem",
  video: "Vídeo",
  documento: "Documento",
};

export function itensDeAtalho(modelos: ModeloParaAtalho[], funis: Funil[]): ItemDeAtalho[] {
  const deFunis = funis.map<ItemDeAtalho>((f) => ({
    tipo: "funil",
    id: f.id,
    nome: f.nome,
    atalho: f.atalho,
    palavrasChave: f.palavras_chave ?? [],
    favorito: f.favorito ?? false,
    resumo: `${f.passos.length} ${f.passos.length === 1 ? "mensagem" : "mensagens"} · ${duracaoEmTexto(f.duracao_ms / 1000)}`,
  }));
  const deModelos = modelos.map<ItemDeAtalho>((m) => {
    const tipo = m.media ? TIPO_DA_MIDIA[m.media.kind] : "mensagem";
    return {
      tipo,
      id: m.id,
      nome: m.title,
      atalho: m.shortcut ? m.shortcut.replace(/^\//, "") : null,
      palavrasChave: m.palavras_chave ?? [],
      favorito: m.favorito ?? false,
      resumo: m.body.trim() ? m.body.trim().slice(0, 120) : ROTULO_DA_MIDIA[tipo],
    };
  });
  return [...deFunis, ...deModelos];
}
