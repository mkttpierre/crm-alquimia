"use client";

/**
 * O MODO PERSONALIZAÇÃO da barra lateral: a própria barra vira editável, sem
 * trocar de tela (botão Personalizar, o lápis na linha do usuário, `BarraLateral.tsx`).
 *
 *  - cada tópico de topo tem "remover", "subir", "descer" e uma alça de arrastar;
 *  - o que foi removido aparece em "Adicionar", e um clique devolve o tópico;
 *  - o admin clica no nome e renomeia (vale para a empresa toda);
 *  - Concluir entrega o que mudou a quem salva (`usePersonalizacaoDaBarra`);
 *    Cancelar descarta; "Mais opções" grava o que está pendente e abre a tela de Personalizar.
 *
 * Ocultar NÃO é permissão (a tela segue abrindo pelo link e pelo ⌘K), e
 * Configurações não se remove nem se move: sem ela a pessoa perderia o caminho de
 * volta. As regras de ocultar, mover e montar o que se grava são as de
 * `lib/navigation/personalizar-edicao.ts`, as MESMAS da tela de Personalizar.
 *
 * Arrastar é HTML5 nativo (sem biblioteca) e só funciona com mouse; no celular e
 * no teclado, subir e descer são botões de verdade.
 */
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";

import { useT } from "@/hooks/i18n/useT";
import {
  LIMITE_DO_NOME,
  type NomesDaBarra,
  type PreferenciasDaBarra,
} from "@/lib/navigation/personalizar";
import {
  alternarOculto,
  montarNomes,
  montarPreferencias,
  moverEntreVisiveis,
  moverParaOLugarDe,
} from "@/lib/navigation/personalizar-edicao";
import type { ItemParaPersonalizar } from "@/lib/navigation/registry";
import { CaretDown, CaretUp, DotsSixVertical, Lock, Plus, X } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

import type { PartesDaBarra } from "./usePersonalizacaoDaBarra";

interface Linha {
  chave: string;
  icon: PhosphorIcon;
  nomePadrao: string;
  /** O que o admin deu a esta linha; vazio = usa o padrão. */
  nome: string;
  oculto: boolean;
  fixo: boolean;
}

interface Bloco {
  id: string;
  titulo: string | null;
  itens: Linha[];
}

export type SecaoParaEditar = {
  secao: { id: string; titulo: string | null };
  itens: ItemParaPersonalizar[];
};

/** A tela de Personalizar: o "Mais opções" leva para lá. */
export const ROTA_DE_PERSONALIZAR = "/app/settings/personalizar";

/**
 * 24 px na barra fixa (mouse); 32 px na gaveta do celular, onde são 3 ou 4 botões por
 * linha em 264 px e o dedo precisa de alvo maior (achado 11 da revisão).
 */
const botaoPequeno = (grande: boolean) =>
  cn(
    "grid shrink-0 place-items-center rounded text-lateral-apagado hover:bg-lateral-ativo hover:text-lateral-texto disabled:pointer-events-none disabled:opacity-30",
    grande ? "h-8 w-8" : "h-6 w-6",
  );

/** Há algo a gravar? (o que `concluir()` e o "Mais opções" só gravam se mudou) */
export const temMudanca = (partes: PartesDaBarra) => !!(partes.preferencias || partes.nomes);

function paraBlocos(secoes: readonly SecaoParaEditar[]): Bloco[] {
  return secoes.map(({ secao, itens }) => ({
    id: secao.id,
    titulo: secao.titulo,
    itens: itens.map((i) => ({
      chave: i.chave,
      icon: i.icon,
      nomePadrao: i.nomePadrao,
      nome: i.nomeProprio ? i.label : "",
      oculto: i.oculto,
      fixo: i.fixo,
    })),
  }));
}

const assinaturaDaOrdem = (bs: readonly Bloco[]) =>
  JSON.stringify(bs.map((b) => b.itens.map((i) => [i.chave, i.oculto])));
const assinaturaDosNomes = (bs: readonly Bloco[]) =>
  JSON.stringify(bs.flatMap((b) => b.itens.map((i) => [i.chave, i.nome])));

export function EdicaoDaBarra({
  secoes,
  preservados,
  ehAdmin,
  podeOrdenar,
  botoesGrandes = false,
  aoConcluir,
  aoCancelar,
  aoMaisOpcoes,
}: {
  secoes: readonly SecaoParaEditar[];
  /** O gravado que não aparece agora (interface restrita, papel): volta no envio. */
  preservados: { preferencias: PreferenciasDaBarra; nomes: NomesDaBarra };
  /** Pode renomear (vale para a empresa toda). */
  ehAdmin: boolean;
  /** Pode remover e reordenar a barra DA PESSOA (em suporte, ou sem vínculo na organização, não há barra própria). */
  podeOrdenar: boolean;
  /** Alvo de toque maior (32 px): a gaveta do celular. */
  botoesGrandes?: boolean;
  aoConcluir: (partes: PartesDaBarra) => void;
  aoCancelar: () => void;
  /** Recebe o que está pendente: quem navega grava ANTES (o trabalho feito não se perde). */
  aoMaisOpcoes: (partes: PartesDaBarra) => void;
}) {
  const t = useT();
  const base = useId();
  const raiz = useRef<HTMLDivElement>(null);
  const [inicial] = useState(() => paraBlocos(secoes));
  const [blocos, setBlocos] = useState<Bloco[]>(inicial);
  const [renomeando, setRenomeando] = useState<{ chave: string; valor: string } | null>(null);
  const [arrastando, setArrastando] = useState<{ chave: string; bloco: string } | null>(null);
  const [sobre, setSobre] = useState<string | null>(null);
  // Escape no campo de nome: ligada no Escape e checada em `confirmarNome`. Sem ela, o
  // navegador pode disparar `blur` ao tirar o campo da tela, e o `onBlur` do render
  // anterior (que ainda vê o valor digitado) CONFIRMARIA o nome que se queria descartar.
  const cancelado = useRef(false);
  // Onde o foco do teclado deve cair depois do próximo render: os controles candidatos
  // (`data-foco`), em ordem. Depois de mover, remover ou devolver uma linha o botão clicado
  // pode ter sumido ou ficado desabilitado — sem isto o foco cai no <body> e o leitor de
  // tela perde o contexto.
  const foco = useRef<string[] | null>(null);
  const botao = botaoPequeno(botoesGrandes);

  const nomeDe = (l: Linha) => l.nome || t(l.nomePadrao);

  function iniciarRenomear(chave: string, valor: string) {
    cancelado.current = false;
    setRenomeando({ chave, valor });
  }

  function mover(blocoId: string, chave: string, delta: -1 | 1) {
    const acao = delta < 0 ? "subir" : "descer";
    foco.current = [`${chave}|${acao}`, `${chave}|${acao === "subir" ? "descer" : "subir"}`];
    setBlocos((atual) =>
      atual.map((b) =>
        b.id === blocoId ? { ...b, itens: moverEntreVisiveis(b.itens, chave, delta) } : b,
      ),
    );
  }

  /** Tira o tópico da barra; o foco vai ao vizinho (o de baixo, senão o de cima) ou, sem ninguém, ao "Adicionar" dele. */
  function remover(blocoId: string, chave: string) {
    const visiveis = (blocos.find((b) => b.id === blocoId)?.itens ?? []).filter((i) => !i.oculto);
    const i = visiveis.findIndex((x) => x.chave === chave);
    const vizinhos = [...visiveis.slice(i + 1), ...visiveis.slice(0, Math.max(i, 0)).reverse()];
    foco.current = [
      ...vizinhos.filter((v) => !v.fixo).map((v) => `${v.chave}|remover`),
      `${chave}|adicionar`,
    ];
    setBlocos((atual) => alternarOculto(atual, chave));
  }

  function devolver(chave: string) {
    foco.current = [`${chave}|remover`, `${chave}|subir`, `${chave}|descer`];
    setBlocos((atual) => alternarOculto(atual, chave));
  }

  useEffect(() => {
    const alvos = foco.current;
    if (!alvos) return;
    foco.current = null;
    for (const alvo of alvos) {
      const el = raiz.current?.querySelector<HTMLButtonElement>(`[data-foco="${alvo}"]`);
      if (el && !el.disabled) {
        el.focus();
        return;
      }
    }
  }, [blocos]);

  // Ao entrar no modo o foco vai para o primeiro controle utilizável (o botão que ligou o
  // modo some da tela, e o foco cairia no <body>).
  useEffect(() => {
    raiz.current?.querySelector<HTMLElement>("button:not(:disabled), input")?.focus();
  }, []);

  function confirmarNome(linha: Linha) {
    if (cancelado.current) {
      cancelado.current = false;
      return;
    }
    if (!renomeando || renomeando.chave !== linha.chave) return;
    const digitado = renomeando.valor.trim().slice(0, LIMITE_DO_NOME);
    // Igual ao padrão (ou vazio) volta ao padrão: nunca grava o nome de fábrica como nome próprio.
    const novo =
      digitado === "" || digitado === linha.nomePadrao || digitado === t(linha.nomePadrao)
        ? ""
        : digitado;
    setBlocos((atual) =>
      atual.map((b) => ({
        ...b,
        itens: b.itens.map((i) => (i.chave === linha.chave ? { ...i, nome: novo } : i)),
      })),
    );
    setRenomeando(null);
  }

  function soltar(blocoId: string, alvo: string) {
    const de = arrastando;
    setArrastando(null);
    setSobre(null);
    if (!de || de.bloco !== blocoId) return;
    setBlocos((atual) =>
      atual.map((b) =>
        b.id === blocoId ? { ...b, itens: moverParaOLugarDe(b.itens, de.chave, alvo) } : b,
      ),
    );
  }

  /** O que mudou desde que o modo abriu: o MESMO cálculo do Concluir e do "Mais opções". */
  function partesMudadas(): PartesDaBarra {
    const ordemMudou = podeOrdenar && assinaturaDaOrdem(blocos) !== assinaturaDaOrdem(inicial);
    const nomesMudaram = ehAdmin && assinaturaDosNomes(blocos) !== assinaturaDosNomes(inicial);
    return {
      ...(ordemMudou ? { preferencias: montarPreferencias(blocos, preservados.preferencias) } : {}),
      ...(nomesMudaram
        ? {
            nomes: montarNomes(
              blocos.flatMap((b) => b.itens),
              preservados.nomes,
            ),
          }
        : {}),
    };
  }

  function concluir() {
    aoConcluir(partesMudadas());
  }

  const ocultos = blocos.flatMap((b) => b.itens.filter((i) => i.oculto));

  return (
    <>
      <div
        ref={raiz}
        role="group"
        aria-label={t("Personalizando a barra")}
        className="flex min-h-0 flex-1 [scrollbar-width:thin] [scrollbar-color:var(--color-lateral-ativo)_transparent] flex-col gap-[14px] overflow-y-auto"
      >
        <p className="px-[10px] text-[12px] leading-snug text-lateral-suave">
          {[
            podeOrdenar && t("Arraste os tópicos para mudar a ordem, ou use as setas."),
            ehAdmin && t("Clique no nome para renomear."),
          ]
            .filter(Boolean)
            .join(" ")}
        </p>
        {blocos.map((bloco) => {
          const tituloId = `${base}-edicao-${bloco.id}`;
          const visiveis = bloco.itens.filter((i) => !i.oculto);
          return (
            <section
              key={bloco.id}
              aria-labelledby={bloco.titulo ? tituloId : undefined}
              aria-label={bloco.titulo ? undefined : t("Dia a dia")}
            >
              {bloco.titulo && (
                <h2
                  id={tituloId}
                  className="px-[10px] pb-1.5 text-[11px] leading-none font-medium tracking-[0.06em] text-lateral-apagado uppercase"
                >
                  {t(bloco.titulo)}
                </h2>
              )}
              <ul className="flex flex-col gap-px">
                {visiveis.map((linha, indice) => {
                  const nome = nomeDe(linha);
                  const Icone = linha.icon;
                  const movel = podeOrdenar && !linha.fixo;
                  const primeira = indice === 0;
                  const ultima = indice === visiveis.length - 1 || !!visiveis[indice + 1]?.fixo;
                  const editando = renomeando?.chave === linha.chave ? renomeando : null;
                  return (
                    <li
                      key={linha.chave}
                      data-chave={linha.chave}
                      draggable={movel && !editando}
                      onDragStart={(e) => {
                        if (!movel) return;
                        setArrastando({ chave: linha.chave, bloco: bloco.id });
                        e.dataTransfer?.setData("text/plain", linha.chave);
                        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
                      }}
                      onDragOver={(e) => {
                        if (!arrastando || arrastando.bloco !== bloco.id) return;
                        e.preventDefault();
                        setSobre(linha.chave);
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        soltar(bloco.id, linha.chave);
                      }}
                      onDragEnd={() => {
                        setArrastando(null);
                        setSobre(null);
                      }}
                      className={cn(
                        "flex items-center gap-1 rounded-md border-t-2 border-transparent px-1 py-1 text-[14px] font-medium text-lateral-item",
                        arrastando?.chave === linha.chave && "opacity-40",
                        sobre === linha.chave &&
                          arrastando?.chave !== linha.chave &&
                          "border-lateral-texto",
                      )}
                    >
                      {linha.fixo ? (
                        <Lock
                          size={14}
                          aria-hidden
                          className="mx-[5px] shrink-0 text-lateral-apagado"
                        />
                      ) : (
                        podeOrdenar && (
                          <DotsSixVertical
                            size={16}
                            aria-hidden
                            className="mx-[3px] shrink-0 cursor-grab text-lateral-apagado"
                          />
                        )
                      )}
                      <Icone size={18} aria-hidden className="shrink-0" />
                      {editando ? (
                        <input
                          autoFocus
                          aria-label={t("Nome do tópico")}
                          value={editando.valor}
                          maxLength={LIMITE_DO_NOME}
                          placeholder={t(linha.nomePadrao)}
                          onChange={(e) =>
                            setRenomeando({ chave: linha.chave, valor: e.target.value })
                          }
                          onBlur={() => confirmarNome(linha)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              confirmarNome(linha);
                            } else if (e.key === "Escape") {
                              e.preventDefault();
                              cancelado.current = true;
                              setRenomeando(null);
                            }
                          }}
                          className="min-w-0 flex-1 rounded border border-lateral-linha bg-lateral-hover px-1.5 py-0.5 text-[13px] text-lateral-texto outline-none focus:border-lateral-texto"
                        />
                      ) : ehAdmin ? (
                        <button
                          type="button"
                          aria-label={`${t("Renomear")} ${nome}`}
                          onClick={() => iniciarRenomear(linha.chave, nome)}
                          className="min-w-0 flex-1 truncate rounded px-1 text-left hover:bg-lateral-hover hover:text-lateral-texto"
                        >
                          {nome}
                        </button>
                      ) : (
                        <span className="min-w-0 flex-1 truncate px-1">{nome}</span>
                      )}
                      {linha.fixo && <span className="sr-only">{t("Sempre visível")}</span>}
                      {movel && (
                        <>
                          <button
                            type="button"
                            data-foco={`${linha.chave}|subir`}
                            aria-label={`${t("Subir")} ${nome}`}
                            disabled={primeira}
                            onClick={() => mover(bloco.id, linha.chave, -1)}
                            className={botao}
                          >
                            <CaretUp size={14} aria-hidden />
                          </button>
                          <button
                            type="button"
                            data-foco={`${linha.chave}|descer`}
                            aria-label={`${t("Descer")} ${nome}`}
                            disabled={ultima}
                            onClick={() => mover(bloco.id, linha.chave, 1)}
                            className={botao}
                          >
                            <CaretDown size={14} aria-hidden />
                          </button>
                          <button
                            type="button"
                            data-foco={`${linha.chave}|remover`}
                            aria-label={`${t("Remover")} ${nome}`}
                            onClick={() => remover(bloco.id, linha.chave)}
                            className={botao}
                          >
                            <X size={14} aria-hidden />
                          </button>
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}

        {podeOrdenar && ocultos.length > 0 && (
          <section aria-labelledby={`${base}-adicionar`}>
            <h2
              id={`${base}-adicionar`}
              className="px-[10px] pb-1.5 text-[11px] leading-none font-medium tracking-[0.06em] text-lateral-apagado uppercase"
            >
              {t("Adicionar")}
            </h2>
            <ul className="flex flex-col gap-px">
              {ocultos.map((linha) => {
                const Icone = linha.icon;
                const nome = nomeDe(linha);
                return (
                  <li key={linha.chave}>
                    <button
                      type="button"
                      data-foco={`${linha.chave}|adicionar`}
                      aria-label={`${t("Adicionar")} ${nome}`}
                      onClick={() => devolver(linha.chave)}
                      className="flex w-full items-center gap-[11px] rounded-md px-[10px] py-1.5 text-left text-[14px] font-medium text-lateral-item hover:bg-lateral-hover hover:text-lateral-texto"
                    >
                      <Icone size={18} aria-hidden className="shrink-0" />
                      <span className="min-w-0 flex-1 truncate">{nome}</span>
                      <Plus size={14} aria-hidden className="shrink-0 text-lateral-apagado" />
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </div>

      <div className="flex flex-col gap-1.5 border-t border-lateral-linha pt-2">
        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={concluir}
            className="flex-1 rounded-md bg-lateral-texto px-2 py-1.5 text-[13px] font-semibold text-lateral hover:opacity-90"
          >
            {t("Concluir")}
          </button>
          <button
            type="button"
            onClick={aoCancelar}
            className="flex-1 rounded-md border border-lateral-linha px-2 py-1.5 text-[13px] font-medium text-lateral-item hover:bg-lateral-hover hover:text-lateral-texto"
          >
            {t("Cancelar")}
          </button>
        </div>
        <Link
          href={ROTA_DE_PERSONALIZAR}
          prefetch={false}
          onClick={(e) => {
            const partes = partesMudadas();
            // Com mudança pendente, quem navega grava primeiro e só então vai (a tela de
            // Personalizar abriria com a barra antiga, e o trabalho feito seria perdido).
            if (temMudanca(partes)) e.preventDefault();
            aoMaisOpcoes(partes);
          }}
          className="rounded-md px-2 py-1 text-center text-[12px] text-lateral-suave hover:bg-lateral-hover hover:text-lateral-texto"
        >
          {t("Mais opções")}
        </Link>
      </div>
    </>
  );
}
