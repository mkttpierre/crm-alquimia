"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ErroDoMotor, useAjusteDoMotor } from "@/hooks/disparo/useDisparo";
import { useT } from "@/hooks/i18n/useT";
import { cadenciaPorId, ehTipoDeProspeccao, type Passo } from "@/lib/disparo/cadencia";
import type { Proibido } from "@/lib/disparo/config";
import { montar, slotsPadrao, verificarTexto } from "@/lib/disparo/textos";
import { Plus, X } from "@/lib/ui/icons";

/** O que o verificador do motor diria deste modelo, preenchido com um lead de exemplo. */
export function conferirModelo(modelo: string, passo: Passo, prospeccao: boolean, proibidos: Proibido[], fusoMinutos: number) {
  const exemplo = slotsPadrao("Maria", new Date(), fusoMinutos);
  const { faltando } = montar(modelo, exemplo);
  // Campo que não é dos atalhos de sempre vem do lead (ex.: {cidade}): não é erro aqui, só aviso.
  const { texto } = montar(modelo, { ...exemplo, ...Object.fromEntries(faltando.map((k) => [k, "x"])) });
  return { problemas: verificarTexto(texto, { prospeccao, ultimoToque: passo.ultimo, proibidos }), camposDoLead: faltando };
}

/**
 * MENSAGENS — as variações de cada passo da cadência escolhida (uma por caixa; o motor alterna entre elas), com o
 * verificador do motor ao vivo e as palavras proibidas da casa. Passo que vira lembrete não tem texto: "vira tarefa,
 * não é enviado".
 */
export function MensagensEditor({
  cadencia,
  modelos,
  proibidos,
  fusoMinutos,
  podeEditar,
}: {
  cadencia: string;
  modelos: Record<string, string[]>;
  proibidos: Proibido[];
  fusoMinutos: number;
  podeEditar: boolean;
}) {
  const t = useT();
  const ajuste = useAjusteDoMotor();
  const cad = cadenciaPorId(cadencia);
  const [rascunho, setRascunho] = useState<Record<string, string[]>>(modelos);
  const [regras, setRegras] = useState<Proibido[]>(proibidos);
  const [erro, setErro] = useState<string | null>(null);
  const [salvo, setSalvo] = useState(false);
  // O servidor mudou (outra aba, outro gestor, o próprio salvar): o rascunho acompanha SÓ se não há edição pendente.
  const [base, setBase] = useState({ modelos, proibidos });
  if (JSON.stringify(base) !== JSON.stringify({ modelos, proibidos })) {
    const limpo = JSON.stringify(rascunho) === JSON.stringify(base.modelos) && JSON.stringify(regras) === JSON.stringify(base.proibidos);
    setBase({ modelos, proibidos });
    if (limpo) {
      setRascunho(modelos);
      setRegras(proibidos);
    }
  }

  const mudarTexto = (tipo: string, i: number, texto: string) =>
    setRascunho((r) => ({ ...r, [tipo]: (r[tipo] ?? []).map((v, j) => (j === i ? texto : v)) }));

  async function salvar() {
    setErro(null);
    setSalvo(false);
    // Caixa vazia não é variação: não vai para o motor.
    const limpos = Object.fromEntries(Object.entries(rascunho).map(([k, v]) => [k, v.filter((x) => x.trim() !== "")]));
    try {
      await ajuste.mutateAsync({ modelos: limpos, proibidos: regras.filter((r) => r.padrao.trim() && r.motivo.trim()) });
      setSalvo(true);
    } catch (e) {
      setErro(e instanceof ErroDoMotor && e.campos.length ? e.campos.map((c) => `${c.caminho}: ${c.mensagem}`).join(" · ") : t(e instanceof Error ? e.message : "Não foi possível salvar o ajuste."));
    }
  }

  return (
    <section id="mensagens" aria-labelledby="titulo-mensagens" className="min-w-0 rounded-[12px] border border-border bg-card p-5 text-card-foreground">
      <h2 id="titulo-mensagens" className="text-[15px] font-semibold">
        {t("Mensagens")}
      </h2>
      <p className="mt-[3px] text-[13px] text-muted-foreground">
        {t("Uma variação por caixa; o motor alterna entre elas. Atalhos: {oi}, {nome}, {saudacao}.")}
      </p>

      <div className="mt-4 flex flex-col gap-5">
        {cad.passos.map((passo) => {
          if (!passo.automatico) {
            return (
              <div key={passo.tipo} className="rounded-[10px] border border-dashed border-border p-3 text-[13px]">
                <p className="font-medium">
                  {t("Dia")} {passo.dia} · {passo.lembrete === "audio" ? t("áudio") : t("ligação")}
                </p>
                <p className="text-[12px] text-muted-foreground">{t("vira tarefa, não é enviado")}</p>
              </div>
            );
          }
          const variacoes = rascunho[passo.tipo]?.length ? rascunho[passo.tipo]! : [""];
          const prospeccao = ehTipoDeProspeccao(cad, passo.tipo);
          return (
            <div key={passo.tipo} className="flex flex-col gap-2">
              <p className="text-[13px] font-medium">
                {passo.tipo === "abertura" ? t("Abertura") : `${t("Toque do dia")} ${passo.dia}`}
              </p>
              {variacoes.map((texto, i) => {
                const { problemas, camposDoLead } = texto.trim()
                  ? conferirModelo(texto, passo, prospeccao, regras, fusoMinutos)
                  : { problemas: [], camposDoLead: [] };
                const id = `modelo-${passo.tipo}-${i}`;
                return (
                  <div key={i} className="flex flex-col gap-1">
                    <div className="flex items-start gap-2">
                      <Textarea
                        id={id}
                        aria-label={`${passo.tipo === "abertura" ? t("Abertura") : `${t("Toque do dia")} ${passo.dia}`}, ${t("variação")} ${i + 1}`}
                        className="min-h-[72px] text-[13px]"
                        value={texto}
                        disabled={!podeEditar}
                        onChange={(e) =>
                          rascunho[passo.tipo]?.length
                            ? mudarTexto(passo.tipo, i, e.target.value)
                            : setRascunho((r) => ({ ...r, [passo.tipo]: [e.target.value] }))
                        }
                      />
                      {podeEditar && variacoes.length > 1 ? (
                        <Button type="button" variant="ghost" size="icon" aria-label={t("Tirar esta variação")} onClick={() => setRascunho((r) => ({ ...r, [passo.tipo]: r[passo.tipo]!.filter((_, j) => j !== i) }))}>
                          <X size={14} aria-hidden />
                        </Button>
                      ) : null}
                    </div>
                    {problemas.length ? (
                      <p role="alert" className="text-[12px] text-error-fg">
                        {t("Não sai assim:")} {problemas.map((p) => t(p)).join("; ")}
                      </p>
                    ) : null}
                    {camposDoLead.length ? (
                      <p className="text-[12px] text-muted-foreground">
                        {t("Usa campos do lead:")} {camposDoLead.map((c) => `{${c}}`).join(", ")}
                      </p>
                    ) : null}
                  </div>
                );
              })}
              {podeEditar ? (
                <Button type="button" variant="ghost" size="sm" className="h-8 w-fit gap-1 px-2 text-xs" onClick={() => setRascunho((r) => ({ ...r, [passo.tipo]: [...(r[passo.tipo]?.length ? r[passo.tipo]! : [""]), ""] }))}>
                  <Plus size={12} aria-hidden />
                  {t("Acrescentar variação")}
                </Button>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="mt-5 flex flex-col gap-2 border-t border-border pt-4">
        <p className="text-[13px] font-medium">{t("Palavras proibidas")}</p>
        <p className="text-[12px] text-muted-foreground">{t("Texto com uma destas não sai. Aceita expressão regular simples.")}</p>
        {regras.map((r, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <Input aria-label={`${t("Proibido")} ${i + 1}`} className="h-9 min-w-0 flex-1 font-mono text-xs" value={r.padrao} disabled={!podeEditar} onChange={(e) => setRegras((rs) => rs.map((x, j) => (j === i ? { ...x, padrao: e.target.value } : x)))} />
            <Input aria-label={`${t("Motivo")} ${i + 1}`} className="h-9 min-w-0 flex-1 text-xs" value={r.motivo} disabled={!podeEditar} onChange={(e) => setRegras((rs) => rs.map((x, j) => (j === i ? { ...x, motivo: e.target.value } : x)))} />
            {podeEditar ? (
              <Button type="button" variant="ghost" size="icon" aria-label={t("Tirar esta palavra")} onClick={() => setRegras((rs) => rs.filter((_, j) => j !== i))}>
                <X size={14} aria-hidden />
              </Button>
            ) : null}
          </div>
        ))}
        {podeEditar ? (
          <Button type="button" variant="ghost" size="sm" className="h-8 w-fit gap-1 px-2 text-xs" onClick={() => setRegras((rs) => [...rs, { padrao: "", motivo: "" }])}>
            <Plus size={12} aria-hidden />
            {t("Acrescentar palavra")}
          </Button>
        ) : null}
      </div>

      {podeEditar ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button type="button" onClick={() => void salvar()} disabled={ajuste.isPending}>
            {ajuste.isPending ? t("Salvando…") : t("Salvar mensagens")}
          </Button>
          {salvo ? <span className="text-[12px] text-muted-foreground">{t("Salvo.")}</span> : null}
          {erro ? (
            <span role="alert" className="text-[12px] text-error-fg">
              {erro}
            </span>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
