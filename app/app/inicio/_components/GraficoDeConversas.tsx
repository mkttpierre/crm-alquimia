import Link from "next/link";

import { traduzir } from "@/lib/i18n/dicionario";
import { localeDeData, tagDeIdioma } from "@/lib/i18n/datas";
import type { Idioma } from "@/lib/i18n/idiomas";
import type { SemanaDoGrafico } from "@/lib/inicio/resumo";
import { format } from "date-fns";

import { Cartao, SemDado } from "./Cartao";

// Geometria do protótipo A: 240px de altura, 36px de calha à esquerda para a
// escala, 28px embaixo para as semanas. O SVG estica na largura
// (`preserveAspectRatio="none"`), por isso os TEXTOS ficam fora dele, em HTML —
// texto dentro de um SVG esticado sai deformado.
const W = 900;
const H = 212;

/** Teto "redondo" da escala: 4 divisões inteiras que cobrem o maior valor. */
function tetoDaEscala(maximo: number): number {
  if (maximo <= 4) return 4;
  const bruto = maximo / 4;
  const potencia = 10 ** Math.floor(Math.log10(bruto));
  const passo = [1, 2, 2.5, 5, 10].map((m) => m * potencia).find((p) => p >= bruto) ?? bruto;
  return Math.ceil(passo) * 4;
}

export function GraficoDeConversas({
  semanas,
  idioma,
}: {
  semanas: SemanaDoGrafico[];
  idioma: Idioma;
}) {
  const t = (texto: string) => traduzir(texto, idioma);
  const vazio = semanas.every((s) => s.iniciadas === 0);
  const titulo = t("Conversas iniciadas e respondidas");
  const subtitulo = t("Últimas 8 semanas, todas as conexões");

  if (vazio) {
    return (
      <Cartao titulo={titulo} subtitulo={subtitulo}>
        <SemDado
          texto={t(
            "Aqui aparecem, semana a semana, as conversas que começaram e as que tiveram resposta. Elas chegam quando um WhatsApp está conectado.",
          )}
          acao={
            <Link
              href="/app/connections"
              prefetch={false}
              className="font-medium text-foreground underline underline-offset-4"
            >
              {t("Conectar um WhatsApp")}
            </Link>
          }
        />
      </Cartao>
    );
  }

  const teto = tetoDaEscala(Math.max(...semanas.map((s) => s.iniciadas)));
  const x = (i: number) => (i * W) / (semanas.length - 1);
  const y = (v: number) => H * (1 - v / teto);
  const linha = (vs: number[]) => vs.map((v, i) => `${i ? "L" : "M"}${x(i)},${y(v)}`).join(" ");
  const iniciadas = semanas.map((s) => s.iniciadas);
  const respondidas = semanas.map((s) => s.respondidas);
  const ultima = semanas.length - 1;
  const n = (v: number) => new Intl.NumberFormat(tagDeIdioma(idioma)).format(v);
  const dia = (iso: string) => format(new Date(iso), "dd/MM", { locale: localeDeData(idioma) });

  return (
    <Cartao titulo={titulo} subtitulo={subtitulo}>
      <div className="relative mt-[14px] h-[240px] pb-7 pl-9" aria-hidden>
        {[0, 1, 2, 3, 4].map((k) => (
          <span
            key={k}
            className="absolute left-0 w-7 -translate-y-1/2 text-right font-mono text-[11px] text-muted-foreground tabular-nums"
            style={{ top: `${(1 - k / 4) * H}px` }}
          >
            {n((teto * k) / 4)}
          </span>
        ))}
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className="h-[212px] w-full overflow-visible text-foreground"
        >
          <defs>
            <linearGradient id="inicio-area" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="currentColor" stopOpacity="0.22" />
              <stop offset="1" stopColor="currentColor" stopOpacity="0.02" />
            </linearGradient>
          </defs>
          {[0, 1, 2, 3, 4].map((k) => (
            <line
              key={k}
              x1={0}
              x2={W}
              y1={(1 - k / 4) * H}
              y2={(1 - k / 4) * H}
              stroke="var(--color-border)"
              strokeDasharray="3 4"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          <path d={`${linha(respondidas)} L${x(ultima)},${H} L0,${H} Z`} fill="url(#inicio-area)" />
          <path
            d={linha(iniciadas)}
            fill="none"
            stroke="var(--color-text-subtle)"
            strokeWidth={2}
            strokeDasharray="5 5"
            vectorEffect="non-scaling-stroke"
          />
          <path
            d={linha(respondidas)}
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        <div className="absolute right-0 bottom-0 left-9 flex justify-between text-[11px] text-muted-foreground">
          {semanas.map((s, i) => (
            <span
              key={s.inicio}
              title={dia(s.inicio)}
              className={i === 0 ? "-translate-x-1/4" : i === ultima ? "translate-x-1/4" : ""}
            >
              {t("Sem")} {i + 1}
            </span>
          ))}
        </div>
      </div>
      <div className="mt-1.5 flex justify-center gap-[18px] text-[12px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <i className="inline-block h-[9px] w-[9px] rounded-[2px] bg-[var(--color-text-subtle)]" />
          {t("Iniciadas")}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <i className="inline-block h-[9px] w-[9px] rounded-[2px] bg-foreground" />
          {t("Respondidas")}
        </span>
      </div>
      <p className="mt-2 text-center text-[12px] text-muted-foreground">
        {t(
          "Respondida: conversa que teve mensagem do cliente e da sua equipe (ou da IA), seja quem começou.",
        )}
      </p>
      {/* Os mesmos números para leitor de tela: o desenho acima é `aria-hidden`. */}
      <table className="sr-only">
        <caption>{titulo}</caption>
        <thead>
          <tr>
            <th scope="col">{t("Semana")}</th>
            <th scope="col">{t("Iniciadas")}</th>
            <th scope="col">{t("Respondidas")}</th>
          </tr>
        </thead>
        <tbody>
          {semanas.map((s) => (
            <tr key={s.inicio}>
              <th scope="row">{dia(s.inicio)}</th>
              <td>{n(s.iniciadas)}</td>
              <td>{n(s.respondidas)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Cartao>
  );
}
