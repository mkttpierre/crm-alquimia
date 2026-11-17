"use client";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useT } from "@/hooks/i18n/useT";
import type { SimulacaoDaTela } from "@/lib/disparo-painel/esquemas";
import { Clock, PaperPlaneTilt, Pause } from "@/lib/ui/icons";

import { horaDoMinuto } from "./campos-do-ritmo";

/** Cores das linhas: o primeiro chip no tom do texto, os outros em cinzas (monocromático, como o layout). */
const CORES = ["var(--foreground)", "#8a8a8a", "#b5b5b5", "#5f5f5f", "#d6d6d6"];
const ALTURA_DA_LINHA = 40;

/** Minuto local do dia (0..1439) de um instante ISO, no fuso do ritmo. */
const minutoLocal = (iso: string, fusoMinutos: number) => {
  const m = Math.floor(Date.parse(iso) / 60_000) + fusoMinutos;
  return ((m % 1440) + 1440) % 1440;
};

/**
 * SIMULAÇÃO DE HOJE — onde cada conversa nova cairia, chip a chip, com as pausas longas tracejadas
 * (`GET /api/v1/disparo/simulacao`, as mesmas regras da fila do motor). Abaixo, os quatro números do dia.
 * No celular, a linha do dia rola por dentro do card; a página não rola para o lado.
 */
export function SimulacaoDoDia({
  simulacao,
  carregando,
  erro = false,
  onTentar,
  previa = null,
  previaCarregando = false,
  pausa,
  onPersonalizar,
  podeEditar,
}: {
  simulacao: SimulacaoDaTela | undefined;
  carregando: boolean;
  /** A leitura falhou: a tela diz isso, e não "hoje não há janela". */
  erro?: boolean;
  onTentar?: () => void;
  /** Nome do perfil em prévia (ainda não aplicado); null = o ritmo em uso. */
  previa?: string | null;
  /** A prévia foi pedida e a simulação na tela ainda é a anterior. */
  previaCarregando?: boolean;
  /** Faixa da pausa longa do ritmo mostrado (o atual ou o da prévia), para o detalhe do número. */
  pausa: { min: number; max: number };
  onPersonalizar: () => void;
  podeEditar: boolean;
}) {
  const t = useT();
  const ativos = simulacao?.porChip.filter((c) => c.parado === null) ?? [];
  const parados = simulacao?.porChip.filter((c) => c.parado !== null) ?? [];
  const janela = simulacao?.janela ?? [];
  const inicio = janela.length ? Math.min(...janela.map((b) => b.inicio)) : 8 * 60;
  const fim = janela.length ? Math.max(...janela.map((b) => b.fim)) : 19 * 60;
  const largura = Math.max(60, fim - inicio);
  const pos = (min: number) => `${(((min - inicio) / largura) * 100).toFixed(2)}%`;
  const horas: number[] = [];
  for (let h = Math.ceil(inicio / 60); h * 60 <= fim; h++) horas.push(h);
  const fuso = simulacao?.fuso_minutos ?? -180;
  const hora = (iso: string | null) => (iso ? horaDoMinuto(minutoLocal(iso, fuso)) : "—");

  return (
    <>
      <section className="min-w-0 rounded-[12px] border border-border bg-card p-5 text-card-foreground" aria-labelledby="titulo-simulacao">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="titulo-simulacao" className="text-[15px] leading-tight font-semibold">
              {t("Simulação de hoje")}
            </h2>
            <p className="mt-[3px] text-[13px] text-muted-foreground">
              {t("Onde cada conversa nova cairia com o ritmo escolhido")} ({ativos.length} {ativos.length === 1 ? t("chip") : t("chips")})
            </p>
            {previa && previaCarregando ? (
              <p className="mt-1 text-[12px] text-muted-foreground" role="status">
                {t("Carregando prévia…")}
              </p>
            ) : previa ? (
              <p className="mt-1 text-[12px] font-medium">
                {t("Prévia do perfil")} {previa} — {t("ainda não aplicado")}
              </p>
            ) : null}
          </div>
          {podeEditar ? (
            <Button type="button" variant="outline" size="sm" onClick={onPersonalizar}>
              {t("Personalizar")}
            </Button>
          ) : null}
        </div>

        {erro && !simulacao ? (
          <div role="alert" className="mt-4 flex flex-wrap items-center gap-3 text-[13px]">
            <span className="text-error-fg">{t("Não foi possível simular o dia.")}</span>
            {onTentar ? (
              <Button type="button" variant="outline" size="sm" onClick={onTentar}>
                {t("Tentar de novo")}
              </Button>
            ) : null}
          </div>
        ) : carregando && !simulacao ? (
          <Skeleton className="mt-4 h-24 w-full" />
        ) : janela.length === 0 ? (
          <p className="mt-4 text-[13px] text-muted-foreground">{t("Hoje não há janela de envio (feriado ou dia sem horário).")}</p>
        ) : ativos.length === 0 ? (
          <p className="mt-4 text-[13px] text-muted-foreground">{t("Nenhum chip ativo no motor: use um chip no card Chips para ver o dia.")}</p>
        ) : (
          <div className="mt-[18px] overflow-x-auto" data-testid="linha-do-dia">
            <div
              className="relative min-w-[560px]"
              style={{ height: ativos.length * ALTURA_DA_LINHA + 26 }}
              role="img"
              aria-label={`${t("Linha do dia de")} ${horaDoMinuto(inicio)} ${t("a")} ${horaDoMinuto(Math.min(fim, 1439))}, ${simulacao?.totalNovas ?? 0} ${t("conversas novas")}`}
            >
              {ativos.map((c, i) => {
                const topo = 18 + i * ALTURA_DA_LINHA;
                const cor = CORES[i % CORES.length];
                return (
                  <div key={c.nome}>
                    <div className="absolute right-0 left-0 h-px bg-border" style={{ top: topo }} />
                    {c.envios.map((e) => (
                      <span
                        key={e}
                        data-envio
                        className="absolute -ml-1 h-2 w-2 rounded-full"
                        style={{ left: pos(minutoLocal(e, fuso)), top: topo - 4, background: cor }}
                      />
                    ))}
                    {c.pausas.map((p) => {
                      const a = minutoLocal(p.inicio, fuso);
                      const b = Math.min(fim, a + (Date.parse(p.fim) - Date.parse(p.inicio)) / 60_000);
                      return (
                        <span
                          key={p.inicio}
                          data-pausa
                          className="absolute h-3.5 rounded-[4px] border border-dashed border-muted-foreground"
                          style={{ left: pos(a), width: `${(((b - a) / largura) * 100).toFixed(2)}%`, top: topo - 7 }}
                        />
                      );
                    })}
                  </div>
                );
              })}
              <div className="absolute right-0 bottom-0 left-0 h-[18px] border-t border-border">
                {horas.map((h, i) => (
                  <span
                    key={h}
                    className="absolute top-1 font-mono text-[10px] leading-none text-muted-foreground"
                    style={{ left: pos(h * 60), transform: i === 0 ? "none" : i === horas.length - 1 ? "translateX(-100%)" : "translateX(-50%)" }}
                  >
                    {String(h).padStart(2, "0")}h
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}

        {ativos.length > 0 ? (
          <div className="mt-2.5 flex flex-wrap gap-x-[18px] gap-y-1 text-[12px] text-muted-foreground">
            {ativos.map((c, i) => (
              <span key={c.nome}>
                <i className="mr-1.5 inline-block h-[9px] w-[9px] rounded-[2px] align-[-1px]" style={{ background: CORES[i % CORES.length] }} />
                {c.nome} ({t("dia")} {c.diaRampa})
              </span>
            ))}
            <span>
              <i className="mr-1.5 inline-block h-[9px] w-[9px] rounded-[2px] border border-dashed border-muted-foreground align-[-1px]" />
              {t("Pausa longa")}
            </span>
          </div>
        ) : null}

        {parados.length > 0 ? (
          <ul className="mt-3 flex flex-col gap-1 border-t border-border pt-3 text-[12px]" aria-label={t("Chips parados hoje")}>
            {parados.map((c) => (
              <li key={c.nome}>
                <span className="font-medium">{c.nome}</span> <span className="text-muted-foreground">— {t("parado")}: {t(c.parado!)}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      {/* Sem simulação (carregando ou com erro), nenhum número: zero aqui leria como "o dia não manda nada". */}
      {simulacao ? (
      <div className="grid grid-cols-1 gap-4 min-[521px]:grid-cols-2 min-[1101px]:grid-cols-4">
        <Numero titulo={t("Conversas novas hoje")} icone={<PaperPlaneTilt size={18} aria-hidden />} valor={String(simulacao?.totalNovas ?? 0)} detalhe={ativos.map((c) => c.envios.length).join(" + ") || t("nenhum chip ativo")} />
        <Numero titulo={t("Primeira mensagem")} icone={<Clock size={18} aria-hidden />} valor={hora(simulacao?.primeira ?? null)} detalhe={t("sorteada, nunca em ponto")} />
        <Numero titulo={t("Última mensagem")} icone={<Clock size={18} aria-hidden />} valor={hora(simulacao?.ultima ?? null)} detalhe={t("antes do fim da janela")} />
        <Numero titulo={t("Pausas longas")} icone={<Pause size={18} aria-hidden />} valor={String(simulacao?.pausasLongas ?? 0)} detalhe={`${t("de")} ${pausa.min} ${t("a")} ${pausa.max} min`} />
      </div>
      ) : null}
    </>
  );
}

function Numero({ titulo, icone, valor, detalhe }: { titulo: string; icone: React.ReactNode; valor: string; detalhe: string }) {
  return (
    <section className="flex min-w-0 flex-col gap-[14px] rounded-[12px] border border-border bg-card p-5 text-card-foreground">
      <div className="flex items-center justify-between text-[13px] font-medium">
        <h3>{titulo}</h3>
        <span className="shrink-0 text-muted-foreground">{icone}</span>
      </div>
      <p className="text-[28px] leading-none font-semibold tracking-[-0.01em] tabular-nums">{valor}</p>
      <p className="-mt-1 text-[12px] text-muted-foreground">{detalhe}</p>
    </section>
  );
}
