"use client";
/**
 * Barra de atalhos do chat (estilo das ferramentas de atalho do WhatsApp): o operador digita uma palavra na caixa e, logo acima dela,
 * aparecem cartões com as mensagens, áudios, mídias, documentos e funis cujo nome, atalho ou palavra-chave casa com o
 * que foi digitado. Um clique (ou Enter num cartão em foco) escolhe; quem envia é o composer.
 *
 * Nunca envia sozinha: Enter na caixa de texto continua sendo "enviar o texto". A busca espera 400 ms sem digitação
 * para não piscar a cada letra. O filtro por tipo fica salvo neste navegador (conveniência; falha de storage é ignorada).
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { useT } from "@/hooks/i18n/useT";
import { buscarAtalhos } from "@/lib/inbox/atalhos/busca";
import { ORDEM_DOS_TIPOS, type ItemDeAtalho, type TipoDeAtalho } from "@/lib/inbox/atalhos/tipos";
import { ChatCircle, FileText, FilmStrip, Funnel, ImageIcon, Microphone, SlidersHorizontal, Star } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

export const DEBOUNCE_DA_BARRA_MS = 400;
const CHAVE_DO_FILTRO = "crm:atalhos:filtro";

const ROTULO: Record<TipoDeAtalho, string> = {
  funil: "Funis",
  mensagem: "Mensagens",
  audio: "Áudios",
  imagem: "Imagens",
  video: "Vídeos",
  documento: "Documentos",
};

const ESTILO: Record<TipoDeAtalho, string> = {
  funil: "border-accent/40 bg-accent-soft text-accent",
  mensagem: "border-info/40 bg-info-bg text-info-fg",
  audio: "border-warning/40 bg-warning-bg text-warning-fg",
  imagem: "border-success/40 bg-success-bg text-success-fg",
  video: "border-success/40 bg-success-bg text-success-fg",
  documento: "border-border bg-muted text-muted-foreground",
};

const ICONE: Record<TipoDeAtalho, typeof Funnel> = {
  funil: Funnel,
  mensagem: ChatCircle,
  audio: Microphone,
  imagem: ImageIcon,
  video: FilmStrip,
  documento: FileText,
};

function filtroSalvo(): TipoDeAtalho[] {
  try {
    const v = JSON.parse(window.localStorage.getItem(CHAVE_DO_FILTRO) ?? "null") as unknown;
    if (Array.isArray(v)) return v.filter((x): x is TipoDeAtalho => ORDEM_DOS_TIPOS.includes(x as TipoDeAtalho));
  } catch {
    /* storage indisponível: todos os tipos */
  }
  return [...ORDEM_DOS_TIPOS];
}

interface Props {
  texto: string;
  itens: ItemDeAtalho[];
  onEscolher: (item: ItemDeAtalho) => void;
  onFechar: () => void;
}

export function ItemsBar({ texto, itens, onEscolher, onFechar }: Props) {
  const t = useT();
  const [busca, setBusca] = useState("");
  const [filtro, setFiltro] = useState<TipoDeAtalho[]>(() => filtroSalvo());
  const [filtroAberto, setFiltroAberto] = useState(false);
  const cartoes = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    const id = setTimeout(() => setBusca(texto), DEBOUNCE_DA_BARRA_MS);
    return () => clearTimeout(id);
  }, [texto]);

  const achados = useMemo(() => buscarAtalhos(itens, busca, filtro), [itens, busca, filtro]);

  function trocarFiltro(tipo: TipoDeAtalho, ligado: boolean) {
    const novo = ligado ? [...filtro, tipo] : filtro.filter((x) => x !== tipo);
    setFiltro(novo);
    try {
      window.localStorage.setItem(CHAVE_DO_FILTRO, JSON.stringify(novo));
    } catch {
      /* conveniência: segue sem salvar */
    }
  }

  function noCartao(e: KeyboardEvent<HTMLButtonElement>, i: number) {
    if (e.key === "Escape") {
      e.preventDefault();
      onFechar();
    } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const prox = Math.min(achados.length - 1, Math.max(0, i + (e.key === "ArrowRight" ? 1 : -1)));
      cartoes.current[prox]?.focus();
    } else if (e.key === "Enter") {
      e.preventDefault();
      onEscolher(achados[i]!);
    }
  }

  if (!busca.trim()) return null;

  return (
    <div className="mb-2 flex items-stretch gap-2" role="region" aria-label={t("Atalhos")}>
      <div className="relative shrink-0">
        <button
          type="button"
          aria-label={t("Filtrar atalhos")}
          aria-expanded={filtroAberto}
          onClick={() => setFiltroAberto((v) => !v)}
          className="flex h-16 w-9 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted"
        >
          <SlidersHorizontal size={18} />
        </button>
        {filtroAberto && (
          <div className="absolute bottom-full left-0 z-30 mb-1 w-44 rounded-md border border-border bg-popover p-2 shadow-lg">
            {ORDEM_DOS_TIPOS.map((tipo) => (
              <label key={tipo} className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-sm hover:bg-muted">
                <input type="checkbox" checked={filtro.includes(tipo)} onChange={(e) => trocarFiltro(tipo, e.target.checked)} />
                {t(ROTULO[tipo])}
              </label>
            ))}
          </div>
        )}
      </div>

      {achados.length === 0 ? (
        <div className="flex h-16 flex-1 items-center rounded-md border border-dashed border-border px-3 text-xs text-muted-foreground">
          {t("Nenhum atalho com essa palavra. Crie mensagens e funis em Atalhos, ou mude a busca.")}
        </div>
      ) : (
        <div className="flex h-16 flex-1 gap-2 overflow-x-auto [contain:inline-size]" onWheel={(e) => (e.currentTarget.scrollLeft += e.deltaY)}>
          {achados.map((item, i) => {
            const Icone = ICONE[item.tipo];
            return (
              <button
                key={`${item.tipo}-${item.id}`}
                ref={(el) => {
                  cartoes.current[i] = el;
                }}
                type="button"
                onClick={() => onEscolher(item)}
                onKeyDown={(e) => noCartao(e, i)}
                title={item.resumo}
                className={cn(
                  "flex h-16 w-48 shrink-0 flex-col justify-center gap-0.5 rounded-md border px-2.5 text-left transition-colors hover:brightness-95 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
                  ESTILO[item.tipo],
                )}
              >
                <span className="flex w-full items-center gap-1.5 text-sm font-medium">
                  <Icone size={16} className="shrink-0" />
                  <span className="truncate">{item.nome}</span>
                  {item.favorito && <Star size={12} weight="fill" className="ml-auto shrink-0" aria-label={t("Favorito")} />}
                </span>
                <span className="line-clamp-1 text-xs opacity-80">{item.resumo}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
