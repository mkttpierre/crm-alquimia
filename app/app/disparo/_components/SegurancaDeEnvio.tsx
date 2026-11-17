"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { ErroDoMotor, useAjusteDoMotor, useBibliotecaDeMidia } from "@/hooks/disparo/useDisparo";
import { useT } from "@/hooks/i18n/useT";
import { ABERTURA_SO_IMAGEM, type Condicao, MIMES_DA_ABERTURA, RITMO_PADRAO, type Ritmo } from "@/lib/disparo/config";
import type { EdicaoDaConfig, ProblemaDeCampo } from "@/lib/disparo-painel/esquemas";
import { horaParaMinutos } from "@/lib/disparo-painel/estado";
import { Plus, X } from "@/lib/ui/icons";

import {
  type CampoDoRitmo,
  gravarCaminho,
  horaDoMinuto,
  lerCaminho,
  ritmoAlterado,
  SECOES_DO_RITMO,
  textoDoRecomendado,
  voltarSecaoAoRecomendado,
} from "./campos-do-ritmo";

type Faixa = { min: number; max: number };
type Bloco = { inicio: number; fim: number };

/** O problema do servidor que cai neste campo (`ritmo.saude.bloqueio` cai em `saude.bloqueio.amarelo`). */
function problemaDoCampo(caminhoDoCampo: string, problemas: ProblemaDeCampo[]): string | null {
  for (const p of problemas) {
    const c = p.caminho.startsWith("ritmo.") ? p.caminho.slice("ritmo.".length) : p.caminho;
    if (c === caminhoDoCampo || c.startsWith(`${caminhoDoCampo}.`) || caminhoDoCampo.startsWith(`${c}.`)) return p.mensagem;
  }
  return null;
}

/**
 * SEGURANÇA DE ENVIO — a gaveta "Personalizar": todo o ritmo do motor, por seção, cada campo com o recomendado ao
 * lado e cada seção com "Voltar ao recomendado". Salvar manda SÓ o que mudou (`PATCH ritmo` parcial e, no Avançado,
 * `teto_diario`). Não há campo de modo aqui: o modo é do card Modo, e só do admin. Fechar com alteração pede
 * confirmação; campo numérico pode ficar vazio enquanto se redigita (o servidor recusa o vazio ao salvar, no campo).
 */
export function SegurancaDeEnvio({
  ritmo,
  tetoDiario = null,
  aberto,
  onFechar,
}: {
  ritmo: Ritmo;
  tetoDiario?: number | null;
  aberto: boolean;
  onFechar: () => void;
}) {
  const t = useT();
  const ajuste = useAjusteDoMotor();
  const [rascunho, setRascunho] = useState<Ritmo>(ritmo);
  const [teto, setTeto] = useState<number | null>(tetoDiario);
  const [problemas, setProblemas] = useState<ProblemaDeCampo[]>([]);
  const [erro, setErro] = useState<string | null>(null);
  const [confirmandoSaida, setConfirmandoSaida] = useState(false);

  const mudar = (caminho: string, valor: unknown) => setRascunho((r) => gravarCaminho(r, caminho, valor));
  const alterado = ritmoAlterado(ritmo, rascunho);
  const tetoMudou = teto !== tetoDiario;
  const temMudanca = Object.keys(alterado).length > 0 || tetoMudou;

  function tentarFechar() {
    if (temMudanca && !confirmandoSaida) setConfirmandoSaida(true);
    else onFechar();
  }

  async function salvar() {
    setErro(null);
    setProblemas([]);
    const edicao: Record<string, unknown> = {};
    if (Object.keys(alterado).length) edicao.ritmo = alterado;
    if (tetoMudou) edicao.teto_diario = teto;
    try {
      await ajuste.mutateAsync(edicao as EdicaoDaConfig);
      onFechar();
    } catch (e) {
      if (e instanceof ErroDoMotor && e.campos.length) setProblemas(e.campos);
      setErro(e instanceof Error ? e.message : "Não foi possível salvar o ajuste.");
    }
  }

  return (
    <Sheet open={aberto} onOpenChange={(v) => (v ? undefined : tentarFechar())}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-y-auto p-0 sm:max-w-[420px]">
        <SheetHeader className="border-b border-border px-5 py-4 pr-12 text-left">
          <div className="flex items-center justify-between gap-2">
            <SheetTitle>{t("Personalizar")}</SheetTitle>
            <Button type="button" variant="ghost" size="sm" className="h-8 px-2 text-xs" onClick={tentarFechar}>
              {t("Fechar")}
            </Button>
          </div>
          <SheetDescription>{t("Cada número tem o recomendado ao lado. Salvar grava só o que você mudou.")}</SheetDescription>
        </SheetHeader>

        {confirmandoSaida ? (
          <div role="alertdialog" aria-label={t("Descartar alterações?")} className="flex flex-wrap items-center gap-2 border-b border-border bg-card px-5 py-3 text-[13px]">
            <span className="mr-auto">{t("Descartar alterações?")}</span>
            <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmandoSaida(false)}>
              {t("Continuar editando")}
            </Button>
            <Button type="button" variant="destructive" size="sm" onClick={onFechar}>
              {t("Descartar")}
            </Button>
          </div>
        ) : null}

        <div className="flex flex-1 flex-col gap-6 px-5 py-4">
          {SECOES_DO_RITMO.map((secao) => (
            <section key={secao.id} aria-labelledby={`secao-${secao.id}`} className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 id={`secao-${secao.id}`} className="text-[12px] font-medium tracking-[0.06em] text-muted-foreground uppercase">
                  {t(secao.titulo)}
                </h3>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 shrink-0 px-2 text-xs"
                  aria-label={`${t("Voltar ao recomendado")}: ${t(secao.titulo)}`}
                  onClick={() => {
                    setRascunho((r) => voltarSecaoAoRecomendado(r, secao));
                    if (secao.id === "avancado") setTeto(null);
                  }}
                >
                  {t("Voltar ao recomendado")}
                </Button>
              </div>
              {secao.descricao ? <p className="text-xs text-muted-foreground">{t(secao.descricao)}</p> : null}
              {secao.id === "avancado" ? (
                <Linha
                  id="campo-teto-diario"
                  rotulo={t("Teto de conversas novas por chip no dia")}
                  recomendado={t("sem teto (só a rampa)")}
                  problema={problemaDoCampo("teto_diario", problemas)}
                >
                  <NumeroEditavel id="campo-teto-diario" valor={teto} onMudar={(v) => setTeto(v)} />
                </Linha>
              ) : null}
              {secao.campos.map((campo) => (
                <Linha
                  key={campo.caminho}
                  id={`campo-${campo.caminho.replaceAll(".", "-")}`}
                  rotulo={t(campo.rotulo)}
                  recomendado={textoDoRecomendado(campo, t("sim"), t("não"), t("igual à comum"), t("nenhum"))}
                  problema={problemaDoCampo(campo.caminho, problemas)}
                >
                  <Editor campo={campo} id={`campo-${campo.caminho.replaceAll(".", "-")}`} valor={lerCaminho(rascunho, campo.caminho)} onMudar={(v) => mudar(campo.caminho, v)} unidade={campo.unidade ? t(campo.unidade) : null} />
                </Linha>
              ))}
            </section>
          ))}
        </div>

        <div className="sticky bottom-0 flex flex-col gap-2 border-t border-border bg-card px-5 py-3">
          {erro ? (
            <p role="alert" className="text-xs text-error-fg">
              {t(erro)}
            </p>
          ) : null}
          <Button type="button" onClick={() => void salvar()} disabled={!temMudanca || ajuste.isPending} className="w-full">
            {ajuste.isPending ? t("Salvando…") : t("Salvar")}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** Rótulo, recomendado e campo. Abaixo de 520 px empilha: o recomendado ganha linha própria e quebra. */
function Linha({ id, rotulo, recomendado, problema, children }: { id: string; rotulo: string; recomendado: string; problema: string | null; children: React.ReactNode }) {
  const t = useT();
  return (
    <div className="flex flex-col gap-1.5 py-1">
      <div className="flex flex-col gap-0.5 min-[521px]:flex-row min-[521px]:items-start min-[521px]:justify-between min-[521px]:gap-3">
        <label htmlFor={id} className="min-w-0 text-[13px]">
          {rotulo}
        </label>
        <span className="min-w-0 text-[11px] break-words text-muted-foreground min-[521px]:max-w-[45%] min-[521px]:text-right">
          {t("recomendado:")} <span className="font-mono">{recomendado}</span>
        </span>
      </div>
      {children}
      {problema ? (
        <p role="alert" className="text-xs text-error-fg">
          {problema}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Número com texto próprio: apagar tudo deixa o campo vazio (não volta ao valor anterior). Vazio vira `null` no
 * rascunho; o servidor o recusa ao salvar e o erro aparece no campo (no teto, vazio é "sem teto").
 */
function NumeroEditavel({
  id,
  valor,
  onMudar,
  escala = 1,
  rotulo,
}: {
  id?: string;
  valor: number | null;
  onMudar: (v: number | null) => void;
  escala?: number;
  rotulo?: string;
}) {
  const mostrar = (v: number | null) => (v === null || Number.isNaN(v) ? "" : String(Math.round(v * escala * 1000) / 1000));
  const [texto, setTexto] = useState(mostrar(valor));
  const [ultimo, setUltimo] = useState(valor);
  if (ultimo !== valor) {
    // Valor trocado por fora ("Voltar ao recomendado"): o texto acompanha.
    setUltimo(valor);
    setTexto(mostrar(valor));
  }
  return (
    <Input
      id={id}
      aria-label={rotulo}
      type="text"
      inputMode="decimal"
      className="h-9 w-24"
      value={texto}
      onChange={(e) => {
        const bruto = e.target.value.replace(",", ".");
        setTexto(e.target.value);
        const n = bruto.trim() === "" ? null : Number(bruto);
        if (n === null || Number.isFinite(n)) {
          const v = n === null ? null : n / escala;
          setUltimo(v);
          onMudar(v);
        }
      }}
    />
  );
}

function Editor({
  campo,
  id,
  valor,
  onMudar,
  unidade,
}: {
  campo: CampoDoRitmo;
  id: string;
  valor: unknown;
  onMudar: (v: unknown) => void;
  unidade: string | null;
}) {
  const t = useT();
  const sufixo = unidade ? <span className="text-xs text-muted-foreground">{unidade}</span> : null;

  switch (campo.tipo) {
    case "booleano":
      return <Switch id={id} checked={valor === true} onCheckedChange={(v) => onMudar(v)} />;
    case "numero":
    case "percentual":
      return (
        <div className="flex items-center gap-2">
          <NumeroEditavel id={id} valor={valor as number | null} onMudar={onMudar} escala={campo.tipo === "percentual" ? 100 : 1} />
          {sufixo}
        </div>
      );
    case "faixa":
    case "faixaOuComum": {
      const f = valor as Faixa | null;
      if (campo.tipo === "faixaOuComum" && f === null) {
        return (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>{t("Igual à faixa comum")}</span>
            <Button type="button" variant="ghost" size="sm" className="h-8 px-2 text-xs" onClick={() => onMudar(structuredClone(lerCaminho(RITMO_PADRAO, campo.caminho) ?? RITMO_PADRAO.pausa))}>
              {t("Usar faixa própria")}
            </Button>
          </div>
        );
      }
      const faixa = f ?? { min: 0, max: 0 };
      return (
        <div className="flex flex-wrap items-center gap-2">
          <NumeroEditavel id={id} rotulo={`${t(campo.rotulo)} (${t("mínimo")})`} valor={faixa.min} onMudar={(v) => onMudar({ ...faixa, min: v })} />
          <span className="text-xs text-muted-foreground">{t("a")}</span>
          <NumeroEditavel rotulo={`${t(campo.rotulo)} (${t("máximo")})`} valor={faixa.max} onMudar={(v) => onMudar({ ...faixa, max: v })} />
          {sufixo}
          {campo.tipo === "faixaOuComum" ? (
            <Button type="button" variant="ghost" size="sm" className="h-8 px-2 text-xs" onClick={() => onMudar(null)}>
              {t("Usar a comum")}
            </Button>
          ) : null}
        </div>
      );
    }
    case "listaDeNumeros":
    case "listaDeFaixas":
    case "datas":
    case "listaDeTextos":
      return <ListaEmTexto id={id} tipo={campo.tipo} valor={valor} onMudar={onMudar} sufixo={sufixo} />;
    case "blocos":
      return <EditorDeBlocos id={id} rotulo={t(campo.rotulo)} blocos={(valor as Bloco[]) ?? []} onMudar={onMudar} />;
    case "mapaDeListas":
    case "mapaDeTextos":
    case "mapaDeNumeros":
      return <EditorDeMapa id={id} tipo={campo.tipo} mapa={(valor as Record<string, unknown>) ?? {}} onMudar={onMudar} />;
    case "condicoes":
      return <EditorDeCondicoes id={id} condicoes={(valor as Condicao[]) ?? []} onMudar={onMudar} />;
    case "midia":
      return <EscolhaDeMidia id={id} valor={(valor as string | null) ?? null} onMudar={onMudar} />;
  }
}

/** Lista editada como texto ("10, 12, 14"; "20-40, 15-30"; datas; nomes). Inválido não muda o valor. */
function ListaEmTexto({
  id,
  tipo,
  valor,
  onMudar,
  sufixo,
}: {
  id: string;
  tipo: "listaDeNumeros" | "listaDeFaixas" | "datas" | "listaDeTextos";
  valor: unknown;
  onMudar: (v: unknown) => void;
  sufixo: React.ReactNode;
}) {
  const formatar = (v: unknown) =>
    tipo === "listaDeFaixas" ? (v as Faixa[]).map((f) => `${f.min}-${f.max}`).join(", ") : (v as (string | number)[]).join(", ");
  const [texto, setTexto] = useState(formatar(valor));
  const [ultimo, setUltimo] = useState(valor);
  if (ultimo !== valor) {
    setUltimo(valor);
    setTexto(formatar(valor));
  }

  function ler(t: string): unknown | null {
    const partes = t.split(/[,\n;]/).map((p) => p.trim()).filter(Boolean);
    if (tipo === "listaDeTextos") return partes;
    if (tipo === "datas") return partes.every((p) => /^\d{4}-\d{2}-\d{2}$/.test(p)) ? partes : null;
    if (tipo === "listaDeNumeros") {
      const n = partes.map(Number);
      return n.every((x) => Number.isInteger(x) && x >= 0) ? n : null;
    }
    const faixas = partes.map((p) => p.split(/\s*[-–]\s*/).map(Number));
    return faixas.every((f) => f.length === 2 && f.every((x) => Number.isFinite(x))) ? faixas.map(([min, max]) => ({ min, max })) : null;
  }

  return (
    <div className="flex items-center gap-2">
      <Input
        id={id}
        className="h-9 min-w-0 font-mono text-xs"
        value={texto}
        onChange={(e) => {
          setTexto(e.target.value);
          const lido = ler(e.target.value);
          if (lido !== null) {
            setUltimo(lido);
            onMudar(lido);
          }
        }}
      />
      {sufixo}
    </div>
  );
}

/** Mapa nome → valor em linhas ("celular-a" → "5, 8, 10"; "porta" → "blindada"; "audio" → 5). */
function EditorDeMapa({
  id,
  tipo,
  mapa,
  onMudar,
}: {
  id: string;
  tipo: "mapaDeListas" | "mapaDeTextos" | "mapaDeNumeros";
  mapa: Record<string, unknown>;
  onMudar: (v: Record<string, unknown>) => void;
}) {
  const t = useT();
  const linhas = Object.entries(mapa);
  const valorEmTexto = (v: unknown) => (Array.isArray(v) ? v.join(", ") : String(v ?? ""));
  const lerValor = (texto: string): unknown =>
    tipo === "mapaDeListas" ? texto.split(",").map((x) => Number(x.trim())).filter((x) => Number.isInteger(x) && x >= 0) : tipo === "mapaDeNumeros" ? Number(texto) : texto;
  const trocar = (i: number, chave: string, valor: unknown) => onMudar(Object.fromEntries(linhas.map(([k, v], j) => (j === i ? [chave, valor] : [k, v]))));
  return (
    <div id={id} className="flex flex-col gap-1.5">
      {linhas.map(([chave, valor], i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <Input aria-label={`${t("Nome")} ${i + 1}`} className="h-9 w-32 min-w-0 font-mono text-xs" value={chave} onChange={(e) => trocar(i, e.target.value, valor)} />
          <TextoQueAcompanha rotulo={`${t("Valor")} ${i + 1}`} className="font-mono" valor={valorEmTexto(valor)} onConfirmar={(texto) => trocar(i, chave, lerValor(texto))} />
          <Button type="button" variant="ghost" size="icon" className="h-9 w-9" aria-label={t("Tirar esta linha")} onClick={() => onMudar(Object.fromEntries(linhas.filter((_, j) => j !== i)))}>
            <X size={14} aria-hidden />
          </Button>
        </div>
      ))}
      <Button type="button" variant="ghost" size="sm" className="h-8 w-fit gap-1 px-2 text-xs" onClick={() => onMudar({ ...mapa, [`novo_${linhas.length + 1}`]: tipo === "mapaDeListas" ? [10] : tipo === "mapaDeNumeros" ? 1 : "" })}>
        <Plus size={12} aria-hidden />
        {t("Acrescentar linha")}
      </Button>
    </div>
  );
}

/** Condições sobre campos do lead: campo, valores aceitos (separados por vírgula) e/ou mínimo. */
function EditorDeCondicoes({ id, condicoes, onMudar }: { id: string; condicoes: Condicao[]; onMudar: (v: Condicao[]) => void }) {
  const t = useT();
  const trocar = (i: number, c: Condicao) => onMudar(condicoes.map((x, j) => (j === i ? c : x)));
  return (
    <div id={id} className="flex flex-col gap-1.5">
      {condicoes.map((c, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <Input aria-label={`${t("Campo")} ${i + 1}`} className="h-9 w-28 min-w-0 font-mono text-xs" value={c.campo} onChange={(e) => trocar(i, { ...c, campo: e.target.value })} />
          <TextoQueAcompanha
            rotulo={`${t("Valores aceitos")} ${i + 1}`}
            valor={Array.isArray(c.igual) ? c.igual.join(", ") : c.igual === undefined ? "" : String(c.igual)}
            onConfirmar={(texto) => {
              const v = texto.split(",").map((x) => x.trim()).filter(Boolean);
              const { igual: _sem, ...resto } = c;
              trocar(i, v.length ? { ...resto, igual: v.length === 1 ? v[0]! : v } : resto);
            }}
          />
          <NumeroEditavel rotulo={`${t("Mínimo")} ${i + 1}`} valor={c.minimo ?? null} onMudar={(v) => {
            const { minimo: _sem, ...resto } = c;
            trocar(i, v === null ? resto : { ...resto, minimo: v });
          }} />
          <Button type="button" variant="ghost" size="icon" className="h-9 w-9" aria-label={t("Tirar esta linha")} onClick={() => onMudar(condicoes.filter((_, j) => j !== i))}>
            <X size={14} aria-hidden />
          </Button>
        </div>
      ))}
      <Button type="button" variant="ghost" size="sm" className="h-8 w-fit gap-1 px-2 text-xs" onClick={() => onMudar([...condicoes, { campo: "campo" }])}>
        <Plus size={12} aria-hidden />
        {t("Acrescentar condição")}
      </Button>
    </div>
  );
}

/**
 * Texto que se confirma ao sair do campo (`onBlur`) e que ACOMPANHA o valor trocado por fora: um "Voltar ao
 * recomendado" com o campo aberto troca o que está escrito, em vez de deixar o texto velho para ser gravado depois.
 */
export function TextoQueAcompanha({
  rotulo,
  valor,
  onConfirmar,
  className,
}: {
  rotulo: string;
  valor: string;
  onConfirmar: (texto: string) => void;
  className?: string;
}) {
  const [texto, setTexto] = useState(valor);
  const [ultimo, setUltimo] = useState(valor);
  if (ultimo !== valor) {
    setUltimo(valor);
    setTexto(valor);
  }
  return (
    <Input
      aria-label={rotulo}
      className={`h-9 min-w-0 flex-1 text-xs ${className ?? ""}`}
      value={texto}
      onChange={(e) => setTexto(e.target.value)}
      onBlur={() => {
        if (texto !== valor) onConfirmar(texto);
      }}
    />
  );
}

/**
 * A imagem da abertura, da biblioteca de mídia. Só imagem (jpeg, png, webp): é o que o motor envia hoje, com a
 * mensagem como legenda. O PATCH recusa o resto também (422 no campo).
 */
function EscolhaDeMidia({ id, valor, onMudar }: { id: string; valor: string | null; onMudar: (v: string | null) => void }) {
  const t = useT();
  const biblioteca = useBibliotecaDeMidia(true);
  const todas = Array.isArray(biblioteca.data) ? biblioteca.data : [];
  const imagens = todas.filter((m) => (MIMES_DA_ABERTURA as readonly string[]).includes(m.mime));
  const gravadaNaoServe = valor !== null && biblioteca.isSuccess && !imagens.some((m) => m.id === valor);
  // Com uma imagem gravada e a biblioteca chegando, um select em branco leria como "sem imagem".
  if (valor !== null && biblioteca.isLoading) {
    return (
      <select id={id} disabled className="h-9 w-full rounded-[8px] border border-border bg-background px-2 text-[13px] opacity-60">
        <option>{t("Carregando…")}</option>
      </select>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <select
        id={id}
        className="h-9 w-full rounded-[8px] border border-border bg-background px-2 text-[13px]"
        value={gravadaNaoServe ? "" : (valor ?? "")}
        onChange={(e) => onMudar(e.target.value || null)}
      >
        <option value="">{t("Sem imagem (só texto)")}</option>
        {imagens.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </select>
      {gravadaNaoServe ? (
        <p role="alert" className="text-xs text-error-fg">
          {t(ABERTURA_SO_IMAGEM)}
        </p>
      ) : null}
      {biblioteca.isError ? <p className="text-xs text-error-fg">{t("Não foi possível ler a biblioteca de mídia.")}</p> : null}
    </div>
  );
}

function EditorDeBlocos({ id, rotulo, blocos, onMudar }: { id: string; rotulo: string; blocos: Bloco[]; onMudar: (v: Bloco[]) => void }) {
  const t = useT();
  const trocar = (i: number, lado: "inicio" | "fim", hora: string) => {
    const min = horaParaMinutos(hora);
    if (min === null) return;
    onMudar(blocos.map((b, j) => (j === i ? { ...b, [lado]: min } : b)));
  };
  return (
    <div id={id} className="flex flex-col gap-1.5">
      {blocos.length === 0 ? <p className="text-xs text-muted-foreground">{t("Sem envio neste dia.")}</p> : null}
      {blocos.map((b, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input type="time" aria-label={`${rotulo} ${i + 1} (${t("início")})`} className="h-9 w-28" value={horaDoMinuto(b.inicio)} onChange={(e) => trocar(i, "inicio", e.target.value)} />
          <span className="text-xs text-muted-foreground">{t("a")}</span>
          <Input type="time" aria-label={`${rotulo} ${i + 1} (${t("fim")})`} className="h-9 w-28" value={horaDoMinuto(Math.min(b.fim, 1439))} onChange={(e) => trocar(i, "fim", e.target.value)} />
          <Button type="button" variant="ghost" size="icon" className="h-9 w-9" aria-label={t("Tirar este horário")} onClick={() => onMudar(blocos.filter((_, j) => j !== i))}>
            <X size={14} aria-hidden />
          </Button>
        </div>
      ))}
      {blocos.length < 4 ? (
        <Button type="button" variant="ghost" size="sm" className="h-8 w-fit gap-1 px-2 text-xs" onClick={() => onMudar([...blocos, { inicio: 8 * 60, fim: 12 * 60 }])}>
          <Plus size={12} aria-hidden />
          {t("Acrescentar horário")}
        </Button>
      ) : null}
    </div>
  );
}
