"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useChannelSessions } from "@/hooks/channels/useChannelSessions";
import {
  useAjusteDoMotor,
  useChipsDoMotor,
  useConfigDoMotor,
  useCriarMotor,
  useEstadoDoMotor,
  useSimulacaoDoDia,
} from "@/hooks/disparo/useDisparo";
import { useT } from "@/hooks/i18n/useT";
import { PERFIS_DE_RITMO, type PerfilDeRitmo } from "@/lib/disparo/perfis";
import type { EstadoDoMotor } from "@/lib/disparo-painel/esquemas";
import { Pause, Play } from "@/lib/ui/icons";

import { EstadoComErro } from "./apoio";
import { CadenciaDoMotor } from "./CadenciaDoMotor";
import { horaDoMinuto } from "./campos-do-ritmo";
import { ChipsDoMotor } from "./ChipsDoMotor";
import { ChipsEditor, conexaoConectada } from "./ChipsEditor";
import { ConversasDoAtendimento } from "./ConversasDoAtendimento";
import { FilaDeEnvios } from "./FilaDeEnvios";
import { FonteDosLeads } from "./FonteDosLeads";
import { MensagensEditor } from "./MensagensEditor";
import { ModoDoMotor } from "./ModoDoMotor";
import { PerfisDeRitmo } from "./PerfisDeRitmo";
import { passosIniciais, PrimeirosPassos } from "./PrimeirosPassos";
import { SegurancaDeEnvio } from "./SegurancaDeEnvio";
import { SimulacaoDoDia } from "./SimulacaoDoDia";

type Aba = "fila" | "conversas" | "saude";

/**
 * O MOTOR DE DISPARO PELA TELA (variação C aprovada): escolher o ritmo por perfil, ver o dia simulado,
 * personalizar qualquer número, e montar o motor (chips, etapa, mensagens, cadência, modo) sem SQL.
 *
 * Quem chega aqui já é `manager`+ (a página redireciona os outros). Trocar o modo é só do admin (`podeTrocarModo`),
 * e o envio real ainda exige a segunda chave no servidor (`DISPARO_REAL_LIBERADO=sim`).
 */
export function DisparoClient({ podeEditar, podeTrocarModo }: { podeEditar: boolean; podeTrocarModo: boolean }) {
  const t = useT();
  const estado = useEstadoDoMotor();
  const config = useConfigDoMotor();
  const existe = config.data?.existe === true;
  const chips = useChipsDoMotor(existe);
  const conexoes = useChannelSessions();
  const [previa, setPrevia] = useState<PerfilDeRitmo | null>(null);
  const simulacao = useSimulacaoDoDia(previa, existe);
  const ajuste = useAjusteDoMotor();
  const criar = useCriarMotor();
  const [personalizando, setPersonalizando] = useState(false);
  const [aberturas, setAberturas] = useState(0);
  const [aba, setAba] = useState<Aba>("fila");
  const [confirmandoLigar, setConfirmandoLigar] = useState(false);
  const queryClient = useQueryClient();

  // O /estado é o único que sabe da segunda chave. Sem ele, a tela não afirma que algo sai ou não sai.
  const dadosDoEstado = estado.data && estado.data.existe ? estado.data : null;
  const efetivoReal = dadosDoEstado?.modo_efetivo === "real";
  const conectado = (conexoes.data ?? []).some(conexaoConectada);

  if (config.isLoading) {
    return (
      <div className="mx-auto flex w-full max-w-[1240px] flex-col gap-5" aria-busy="true" role="status">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (config.isError || !config.data) {
    return (
      <div className="mx-auto w-full max-w-[1240px]">
        <EstadoComErro onTentar={() => void config.refetch()} />
      </div>
    );
  }

  const cfg = config.data;
  const passos = passosIniciais({
    conectado,
    temChip: (chips.data?.itens ?? []).some((c) => c.estado !== "desligado"),
    temEtapa: cfg.existe && !!cfg.fonte_stage_id,
    temAbertura: cfg.existe && (cfg.modelos.abertura ?? []).some((m) => m.trim() !== ""),
    envioReal: cfg.existe && cfg.modo === "real",
    existe: cfg.existe,
    podeTrocarModo,
  });
  const modoGravado = cfg.existe ? cfg.modo : "simulado";
  const selo =
    modoGravado === "simulado"
      ? t("Simulado · nada sai")
      : !dadosDoEstado
        ? t("Real · aguardando confirmação do servidor")
        : efetivoReal
          ? t("Enviando de verdade")
          : t("Real · o servidor ainda não libera (nada sai)");
  const ligarOuPausar = (ligado: boolean) => {
    setConfirmandoLigar(false);
    ajuste.mutate({ ligado });
  };

  return (
    <div className="mx-auto flex w-full max-w-[1240px] flex-col gap-5">
      {/* O título visível é o do topo da casca ("Motor de disparo"); aqui fica só para leitor de tela. */}
      <h1 className="sr-only">{t("Motor de disparo")}</h1>
      <header className="flex flex-wrap items-center gap-3">
        <span className="rounded-full border border-border px-[9px] py-[5px] text-[11px] leading-none font-medium whitespace-nowrap">{selo}</span>
        {dadosDoEstado ? <LinhaDoEstado estado={dadosDoEstado} ligado={cfg.existe && cfg.ligado} /> : null}
        {cfg.existe && podeEditar ? (
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {confirmandoLigar ? (
              <>
                <span className="text-[12px]">{t("As mensagens vão sair de verdade pelos chips.")}</span>
                <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmandoLigar(false)}>
                  {t("Cancelar")}
                </Button>
                <Button type="button" variant="destructive" size="sm" disabled={ajuste.isPending} onClick={() => ligarOuPausar(true)}>
                  {t("Ligar e enviar de verdade")}
                </Button>
              </>
            ) : (
              <Button
                type="button"
                size="sm"
                variant={cfg.ligado ? "outline" : "primary"}
                className="gap-1.5"
                disabled={ajuste.isPending}
                // Modo gravado real pede confirmação SEMPRE: sem o /estado, a tela não sabe se a segunda chave está aberta.
                onClick={() => (cfg.ligado ? ligarOuPausar(false) : cfg.modo === "real" ? setConfirmandoLigar(true) : ligarOuPausar(true))}
              >
                {cfg.ligado ? <Pause size={14} aria-hidden /> : <Play size={14} aria-hidden />}
                {cfg.ligado ? t("Pausar o motor") : t("Ligar o motor")}
              </Button>
            )}
          </div>
        ) : null}
      </header>
      {ajuste.isError ? (
        <p role="alert" className="rounded-[10px] border border-border bg-error-bg px-3 py-2 text-[13px] text-error-fg">
          {t(ajuste.error.message)}
        </p>
      ) : null}

      {!cfg.existe ? (
        <>
          <PrimeirosPassos passos={passos} />
          <section className="rounded-[12px] border border-border bg-card p-5 text-card-foreground">
            <h2 className="text-[15px] font-semibold">{t("Criar o motor desta organização")}</h2>
            <p className="mt-[3px] max-w-[70ch] text-[13px] text-muted-foreground">
              {t("Ele nasce no modo simulado e desligado, com o ritmo recomendado: nada sai até você escolher os chips, a etapa, a mensagem e ligar.")}
            </p>
            {podeEditar ? (
              <Button type="button" className="mt-4" disabled={criar.isPending} onClick={() => criar.mutate()}>
                {criar.isPending ? t("Criando…") : t("Criar o motor")}
              </Button>
            ) : null}
            {criar.isError ? (
              <p role="alert" className="mt-2 text-[12px] text-error-fg">
                {t(criar.error.message)}
              </p>
            ) : null}
          </section>
        </>
      ) : (
        <>
          <PerfisDeRitmo
            atual={cfg.perfil}
            previa={previa}
            onPrevia={setPrevia}
            aplicando={ajuste.isPending}
            podeEditar={podeEditar}
            onAplicar={(p) => ajuste.mutate({ perfil: p }, { onSuccess: () => setPrevia(null) })}
          />
          <SimulacaoDoDia
            simulacao={simulacao.data}
            carregando={simulacao.isLoading}
            erro={simulacao.isError}
            onTentar={() => void simulacao.refetch()}
            previa={previa ? t(NOME_DO_PERFIL[previa]) : null}
            // Enquanto a prévia não chega, a tela segue mostrando a simulação anterior (placeholderData): não é a prévia.
            previaCarregando={!!previa && (simulacao.isPlaceholderData || simulacao.data?.perfil !== previa)}
            pausa={previa ? PERFIS_DE_RITMO[previa].pausa! : cfg.ritmo.pausa}
            podeEditar={podeEditar}
            onPersonalizar={() => {
              setAberturas((n) => n + 1);
              setPersonalizando(true);
            }}
          />
          {podeEditar ? (
            <SegurancaDeEnvio key={aberturas} ritmo={cfg.ritmo} tetoDiario={cfg.teto_diario} aberto={personalizando} onFechar={() => setPersonalizando(false)} />
          ) : null}

          <PrimeirosPassos passos={passos} />

          <div className="grid grid-cols-1 gap-5 min-[1101px]:grid-cols-2">
            <ChipsEditor
              chips={chips.data?.itens ?? []}
              conexoes={conexoes.data ?? []}
              podeEditar={podeEditar}
              carregando={chips.isLoading || conexoes.isLoading}
              erro={chips.isError || conexoes.isError}
              onTentar={() => {
                void chips.refetch();
                void queryClient.invalidateQueries({ queryKey: ["channel-sessions"] });
              }}
            />
            <FonteDosLeads
              etapas={cfg.etapas}
              etapaAtual={cfg.fonte_stage_id}
              etapaArquivada={cfg.etapa_arquivada}
              leadsNaEtapa={cfg.leads_na_etapa}
              podeEditar={podeEditar}
            />
            <MensagensEditor
              cadencia={cfg.cadencia}
              modelos={cfg.modelos}
              proibidos={cfg.proibidos}
              fusoMinutos={cfg.ritmo.fusoMinutos}
              podeEditar={podeEditar}
            />
            <div className="flex min-w-0 flex-col gap-5">
              <CadenciaDoMotor atual={cfg.cadencia} podeEditar={podeEditar} />
              <ModoDoMotor
                modo={cfg.modo}
                chaveDoServidor={dadosDoEstado ? dadosDoEstado.chave_do_servidor : null}
                estado={dadosDoEstado}
                podeTrocar={podeTrocarModo}
              />
            </div>
          </div>

          <section aria-labelledby="titulo-acompanhar" className="flex flex-col gap-3">
            <h2 id="titulo-acompanhar" className="text-[15px] font-semibold">
              {t("Acompanhar o motor")}
            </h2>
            <Tabs value={aba} onValueChange={(v) => setAba(v as Aba)} className="flex flex-col gap-4">
              <TabsList>
                <TabsTrigger value="fila">{t("Fila")}</TabsTrigger>
                <TabsTrigger value="conversas">{t("Conversas")}</TabsTrigger>
                <TabsTrigger value="saude">{t("Saúde dos chips")}</TabsTrigger>
              </TabsList>
              <TabsContent value="fila" className="mt-0">
                <FilaDeEnvios ativa={aba === "fila"} />
              </TabsContent>
              <TabsContent value="conversas" className="mt-0">
                <ConversasDoAtendimento ativa={aba === "conversas"} />
              </TabsContent>
              <TabsContent value="saude" className="mt-0">
                <ChipsDoMotor ativa={aba === "saude"} />
              </TabsContent>
            </Tabs>
          </section>
        </>
      )}
    </div>
  );
}

const NOME_DO_PERFIL: Record<PerfilDeRitmo, string> = { conservador: "Conservador", recomendado: "Recomendado", acelerado: "Acelerado" };

const minutoLocal = (iso: string, fusoMinutos: number) => (((Math.floor(Date.parse(iso) / 60_000) + fusoMinutos) % 1440) + 1440) % 1440;

/** O agora do motor numa linha: pausado ou ligado, janela de hoje (ou feriado) e o próximo envio. */
function LinhaDoEstado({ estado, ligado }: { estado: EstadoDoMotor; ligado: boolean }) {
  const t = useT();
  const partes = [
    ligado ? t("Motor ligado") : t("Motor pausado: nada é planejado"),
    estado.hoje.feriado
      ? t("hoje é feriado: sem envio")
      : estado.hoje.janela.length === 0
        ? t("hoje não há janela de envio")
        : estado.hoje.dentro_da_janela
          ? t("dentro da janela agora")
          : t("fora da janela agora"),
  ];
  if (estado.proximo_envio) partes.push(`${t("próximo envio às")} ${horaDoMinuto(minutoLocal(estado.proximo_envio.quando, estado.fuso_minutos))}`);
  return <span className="text-[12px] text-muted-foreground">{partes.join(" · ")}</span>;
}
