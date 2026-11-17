"use client";

import { Badge } from "@/components/ui/badge";
import { useT } from "@/hooks/i18n/useT";
import type { ChipDaTela } from "@/lib/disparo-painel/esquemas";
import { cn } from "@/lib/utils";

/** Quantas aberturas a janela longa precisa ter para a taxa de resposta valer (o mesmo `ritmo.saude.resposta.minAberturas`). */
const AMOSTRA_DA_TAXA = 30;

const pct = (n: number, de: number) => `${((n / de) * 100).toFixed(1).replace(".", ",")}%`;

/**
 * O PAINEL DIÁRIO DE SAÚDE — uma linha por chip, com o motivo do amarelo ou do vermelho.
 *
 * Só leitura: os números vêm de `disparo_saude_dia`, que o motor calcula a cada volta
 * (`lib/disparo/saude.ts`). Amarelo segura a rampa; vermelho para o chip por 48 horas, volta ao dia 1 e
 * só volta pela mão do operador — esta tela mostra, não devolve.
 */
export function SaudeDoDia({ chips }: { chips: ChipDaTela[] }) {
  const t = useT();
  const saude = (s: ChipDaTela["saude"]) =>
    ({
      verde: { texto: t("Saúde boa"), cor: "bg-success-fg" },
      amarelo: { texto: t("Saúde em atenção"), cor: "bg-warning-fg" },
      vermelho: { texto: t("Saúde ruim"), cor: "bg-error-fg" },
    })[s];
  const estado = (e: ChipDaTela["estado"]) =>
    ({
      rampa: { texto: t("Em rampa"), variante: "info" as const },
      ativo: { texto: t("Ativo"), variante: "success" as const },
      pausado: { texto: t("Pausado"), variante: "warning" as const },
      desligado: { texto: t("Desligado"), variante: "neutral" as const },
    })[e];

  return (
    <section aria-labelledby="saude-do-dia-titulo" className="flex flex-col gap-2" data-testid="disparo-saude-do-dia">
      <div>
        <h2 id="saude-do-dia-titulo" className="text-sm font-semibold text-text">
          {t("Saúde de hoje, chip a chip")}
        </h2>
        <p className="mt-0.5 max-w-3xl text-xs text-text-muted">
          {t(
            "Calculada pelo motor sobre as aberturas do dia. Amarelo segura a rampa; vermelho para o chip por 48 horas, volta ao dia 1 e só retorna pela sua mão.",
          )}
        </p>
      </div>
      <div className="overflow-x-auto rounded-lg border border-border bg-surface-elevated">
        <table className="w-full min-w-[56rem] text-left text-xs">
          <thead className="border-b border-border text-text-muted">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">{t("Chip")}</th>
              <th scope="col" className="px-3 py-2 font-medium">{t("Saúde")}</th>
              <th scope="col" className="px-3 py-2 font-medium">{t("Dia da rampa")}</th>
              <th scope="col" className="px-3 py-2 font-medium">{t("Aberturas")}</th>
              <th scope="col" className="px-3 py-2 font-medium">{t("Respostas")}</th>
              <th scope="col" className="px-3 py-2 font-medium">{t("Taxa de resposta")}</th>
              <th scope="col" className="px-3 py-2 font-medium">{t("Bloqueio provável")}</th>
              <th scope="col" className="px-3 py-2 font-medium">{t("Não quero")}</th>
              <th scope="col" className="px-3 py-2 font-medium">{t("Irritação")}</th>
              <th scope="col" className="px-3 py-2 font-medium">{t("Estado")}</th>
            </tr>
          </thead>
          <tbody>
            {chips.map((c) => {
              const d = c.saude_do_dia;
              const s = saude(c.saude);
              const e = estado(c.estado);
              // Os motivos do cálculo de hoje; o do freio de restrição (erro de envio) mora só em `saude_motivo`.
              const motivos = d?.motivos.length ? d.motivos.map((m) => m.texto) : c.saude_motivo ? [c.saude_motivo] : [];
              return (
                <tr key={c.id} className="border-b border-border last:border-b-0 align-top">
                  <th scope="row" className="px-3 py-2 font-semibold text-text">{c.nome}</th>
                  <td className="px-3 py-2">
                    <span className="flex items-center gap-1.5 font-medium text-text">
                      <span aria-hidden className={cn("size-2 rounded-full", s.cor)} />
                      {s.texto}
                    </span>
                    {c.saude !== "verde" && motivos.length > 0 ? (
                      <ul className="mt-1 max-w-72 list-disc space-y-0.5 pl-4 font-normal text-text-muted">
                        {motivos.map((m) => (
                          <li key={m} className="break-words">{m}</li>
                        ))}
                      </ul>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-text">{c.dia_rampa}</td>
                  {d ? (
                    <>
                      <td className="px-3 py-2 text-text">{d.aberturas}</td>
                      <td className="px-3 py-2 text-text">{d.respostas}</td>
                      <td className="px-3 py-2 text-text">
                        {d.aberturas_janela >= AMOSTRA_DA_TAXA ? pct(d.respostas_janela, d.aberturas_janela) : "—"}
                      </td>
                      <td className="px-3 py-2 text-text">
                        {d.com_ack > 0 && d.maduras > 0 ? (
                          <>
                            {d.bloqueio_provavel} {t("de")} {d.com_ack}
                            <span className="text-text-muted"> · {pct(d.bloqueio_provavel, d.com_ack)}</span>
                          </>
                        ) : (
                          <span className="text-text-muted">{t("sem dado")}</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-text">
                        {d.nao_quero}
                        {d.aberturas > 0 ? <span className="text-text-muted"> · {pct(d.nao_quero, d.aberturas)}</span> : null}
                      </td>
                      <td className="px-3 py-2 text-text">{d.irritacao}</td>
                    </>
                  ) : (
                    <td colSpan={6} className="px-3 py-2 text-text-muted">{t("Ainda sem cálculo hoje.")}</td>
                  )}
                  <td className="px-3 py-2">
                    <Badge variant={e.variante}>{e.texto}</Badge>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-text-muted">
        {t("Bloqueio provável usa o status de entrega da Evolution; sem esse retorno aparece como sem dado, nunca como problema.")}
      </p>
    </section>
  );
}
