"use client";

import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import type { ChannelRoutingSettings } from "@/lib/routing/channel-policies";
import { toast } from "sonner";

import type { ChannelDeletionImpact } from "@/app/api/v1/channel-sessions/[id]/route";
import { copyToClipboard } from "@/lib/clipboard";
import { randomId } from "@/lib/random-id";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import {
  channelLabel,
  useChannelSessions,
  type ChannelSession,
} from "@/hooks/channels/useChannelSessions";
import { usePacingKnobs } from "@/hooks/channels/usePacingKnobs";
import { AntiBanSheet } from "./AntiBanSheet";
import { ChannelAiAccess } from "./ChannelAiAccess";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  ArrowsClockwise,
  CheckCircle,
  CircleNotch,
  Phone,
  Plus,
  ShieldCheck,
  Trash,
  Warning,
} from "@/lib/ui/icons";
import { lerEstadoDoCanal } from "@/lib/channels/estado";
import { useT } from "@/hooks/i18n/useT";

type Variant = "success" | "warning" | "error" | "neutral";

/**
 * O vocabulário saiu daqui para `lib/channels/estado.ts`, sem mudar uma palavra:
 * esta era a tradução mais completa do produto (cobre os cinco valores do CHECK)
 * e virou a fonte única. O que MUDOU foi o fallback — ele devolvia
 * `{ label: status }`, ou seja, o enum cru na tela no dia em que aparecesse um
 * estado fora da lista.
 */
function statusInfo(
  status: string,
  t: (texto: string) => string,
): { label: string; variant: Variant } {
  const l = lerEstadoDoCanal(status);
  return { label: t(l.rotulo), variant: l.tom };
}

function errMsg(err: unknown, fallback: string, t: (texto: string) => string): string {
  return err instanceof ApiError && err.message ? t(err.message) : t(fallback);
}

export function podeReconectar(c: Pick<ChannelSession, "provider" | "waha_session_name">): boolean {
  return c.provider === "evolution" || Boolean(c.waha_session_name);
}

/** "3 conversas" / "1 conversa" — ou nada, quando não há o que contar. */
function contar(
  n: number,
  singular: string,
  plural: string,
  t: (texto: string) => string,
): string | null {
  if (n <= 0) return null;
  return `${n} ${t(n === 1 ? singular : plural)}`;
}

/**
 * O resumo do topo de Conexões. Conta só o que está conectado de fato (o estado utilizável de `lib/channels/estado.ts`): uma conexão esperando o
 * QR não é "número conectado" (a terceira prova de instalação via "2 números conectados." com
 * os dois ainda em "Conectando...").
 */
export function resumoDosNumeros(sessoes: ReadonlyArray<{ status: string }>, t: (texto: string) => string): string {
  if (sessoes.length === 0) return t("Nenhum número conectado ainda.");
  const conectados = sessoes.filter((c) => lerEstadoDoCanal(c.status).utilizavel).length;
  const rotulo = t(sessoes.length === 1 ? "número conectado" : "números conectados");
  return conectados === sessoes.length
    ? `${conectados} ${rotulo}.`
    : `${conectados} ${t("de")} ${sessoes.length} ${rotulo}.`;
}

/** Junta os pedaços que sobraram numa enumeração legível ("a, b e c"). */
function enumerar(partes: (string | null)[], t: (texto: string) => string): string {
  const uteis = partes.filter((p): p is string => p !== null);
  const ultimo = uteis.pop() ?? "";
  return uteis.length > 0 ? `${uteis.join(", ")} ${t("e")} ${ultimo}` : ultimo;
}

/**
 * `wahaConfigured`: há um servidor WAHA configurado (vale para reconectar/checar as sessões dele).
 * `podeGerarQr`: há ALGUM servidor de QR — WAHA ou Evolution — e portanto "Conectar novo WhatsApp" funciona.
 * Sem o segundo, vale o primeiro (compatível com quem só passa `wahaConfigured`).
 */
export function ConnectionsClient({
  wahaConfigured,
  podeGerarQr = wahaConfigured,
}: {
  wahaConfigured: boolean;
  podeGerarQr?: boolean;
}) {
  const tagDoIdioma = useTagDeIdioma();
  const t = useT();
  const qc = useQueryClient();
  const {
    data: sessions,
    isLoading,
    isError,
    schemaOutdated,
  } = useChannelSessions({ refetchInterval: 10_000 });
  const [busyId, setBusyId] = useState<string | null>(null);
  const createKey = useRef<string | null>(null);
  const [connectionDetail, setConnectionDetail] = useState<string | null>(null);
  const routing = useQuery({ queryKey: ["channel-routing-settings"], queryFn: () => apiClient.get<{ data: ChannelRoutingSettings }>("/api/v1/settings/routing/channels") });
  const [creating, setCreating] = useState(false);
  const [checking, setChecking] = useState(false);
  const [qr, setQr] = useState<{ sessionId: string; title: string; evolution?: boolean } | null>(null);
  const [antiBanId, setAntiBanId] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<ChannelSession | null>(null);
  const pacingItems = usePacingKnobs().data?.items ?? [];

  const invalidate = useCallback(
    () => qc.invalidateQueries({ queryKey: ["channel-sessions"] }),
    [qc],
  );

  // Health check ao vivo de todos os canais — consulta o WAHA e grava
  // last_health_check_at. É a verificação de saúde de verdade (o status do DB
  // pode estar velho se o WAHA caiu sem emitir evento).
  const runHealthCheck = useCallback(
    async (list: ChannelSession[]) => {
      const elegiveis = list.filter((c) => wahaConfigured || c.provider === "evolution");
      if (elegiveis.length === 0) return;
      setChecking(true);
      try {
        await Promise.allSettled(
          elegiveis.map((c) => apiClient.get(`/api/v1/channel-sessions/${c.id}`)),
        );
        invalidate();
      } finally {
        setChecking(false);
      }
    },
    [wahaConfigured, invalidate],
  );

  const didInitialCheck = useRef(false);
  useEffect(() => {
    if (didInitialCheck.current || !sessions || sessions.length === 0) return;
    didInitialCheck.current = true;
    void runHealthCheck(sessions);
  }, [sessions, runHealthCheck]);

  const handleConnectNew = useCallback(async () => {
    setCreating(true);
    setConnectionDetail(null);
    try {
      const res = await apiClient.post<{ data: ChannelSession }>(
        "/api/v1/channel-sessions",
        {},
        { idempotencyKey: createKey.current ??= randomId(), timeoutMs: 120_000 },
      );
      invalidate();
      createKey.current = null;
      setQr({ sessionId: res.data.id, title: t("Conectar novo WhatsApp"), evolution: res.data.provider === "evolution" });
    } catch (err) {
      toast.error(errMsg(err, "Não foi possível iniciar a conexão.", t));
      if (err instanceof ApiError) setConnectionDetail(JSON.stringify({ code: err.code, request_id: err.requestId, ...err.details }, null, 2));
      invalidate();
    } finally {
      setCreating(false);
    }
  }, [invalidate, t]);

  // Evolution aberta exige confirmação antes de descartar a sessão.
  const handleReconnect = useCallback(
    async (c: ChannelSession) => {
      setBusyId(c.id);
      try {
        let result = await apiClient.post<{ data: { status: string; warning?: string | null } }>(`/api/v1/channel-sessions/${c.id}/reconnect`, {}, { timeoutMs: 60_000 });
        if (c.provider === "evolution" && result.data.status === "WORKING") {
          if (!window.confirm(t("O chip aparece conectado. Derrubar a sessão e parear de novo?"))) return;
          result = await apiClient.post<{ data: { status: string; warning?: string | null } }>(`/api/v1/channel-sessions/${c.id}/reconnect`, { force: true }, { timeoutMs: 60_000 });
        }
        if (result.data.warning) toast.warning(t(result.data.warning));
        invalidate();
        setQr({ sessionId: c.id, title: `${t("Reconectar")} ${channelLabel(c, t)}`, evolution: c.provider === "evolution" });
      } catch (err) {
        toast.error(errMsg(err, "Não foi possível reconectar.", t));
      } finally {
        setBusyId(null);
      }
    },
    [invalidate, t],
  );

  const forcePair = useCallback(
    async (sessionId: string) => {
      const result = await apiClient.post<{ data: { warning?: string | null } }>(`/api/v1/channel-sessions/${sessionId}/reconnect`, { force: true }, { timeoutMs: 60_000 });
      if (result.data.warning) toast.warning(t(result.data.warning));
      invalidate();
    },
    [invalidate, t],
  );

  const handleDeleted = useCallback(() => {
    setToDelete(null);
    invalidate();
  }, [invalidate]);

  const handleConnected = useCallback(() => {
    toast.success(t("WhatsApp conectado!"));
    setQr(null);
    invalidate();
  }, [invalidate, t]);

  const list = sessions ?? [];
  // Fora do JSX: o `=>` do `some`, dentro do `disabled={...}`, encerra a tag do
  // botão para a varredura estática de `tests/unit/controle-decorativo.test.ts`.
  const semProvedorParaSaude =
    !wahaConfigured && !sessions?.some((c) => c.provider === "evolution");

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {isError
            ? t("Não foi possível carregar seus números.")
            : list.length === 0
              ? t("Nenhum número conectado ainda.")
              : resumoDosNumeros(list, t)}
        </p>
        <div className="flex gap-2">
          {list.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              disabled={checking || semProvedorParaSaude}
              onClick={() => void runHealthCheck(list)}
            >
              <ArrowsClockwise
                size={14}
                className={checking ? "animate-spin" : undefined}
                aria-hidden
              />
              {t("Atualizar saúde")}
            </Button>
          )}
          <Button size="sm" disabled={creating || !podeGerarQr} onClick={handleConnectNew}>
            {creating ? (
              <CircleNotch size={14} className="animate-spin" aria-hidden />
            ) : (
              <Plus size={14} aria-hidden />
            )}
            {t("Conectar novo WhatsApp")}
          </Button>
        </div>
      </div>

      <p className="text-sm text-muted-foreground">
        {t("Novos canais começam em modo de teste, sem respostas automáticas até você autorizar números ou liberar o público.")}
      </p>
      {connectionDetail && <details className="rounded-md border p-3 text-sm"><summary>{t("Detalhes para suporte")}</summary><pre className="mt-2 whitespace-pre-wrap break-words">{connectionDetail}</pre><Button variant="outline" size="sm" onClick={async () => {
        if (await copyToClipboard(connectionDetail)) toast.success(t("Copiado!"));
        else toast.error(t("Não foi possível copiar. Selecione e copie manualmente."));
      }}>{t("Copiar detalhes")}</Button></details>}
      <Link href="/app/settings/atendimento" className="text-sm underline">{t("Configurar responsáveis por número")}</Link>
      {!podeGerarQr && (
        <div className="rounded-md border border-warning bg-warning-bg p-4 text-sm text-warning-fg">
          <p className="font-medium">{t("O serviço do WhatsApp não está configurado.")}</p>
          <p className="mt-1">
            {t("Faltam o endereço e a chave do serviço (")}
            <code>WAHA_API_BASE_URL</code> {t("e")} <code>WAHA_API_KEY</code>
            {t(
              ") nas variáveis de ambiente desta instalação. Enquanto isso, não dá para conectar, reconectar nem excluir os números pareados por QR — excluir um número também o desconecta do aparelho, e sem o serviço isso não acontece.",
            )}
          </p>
          <p className="mt-1">
            {t("Se você roda tudo na mesma máquina, o container sobe com")}{" "}
            <code>docker compose up -d waha</code>
            {t(
              ". Já apareceu aqui o caso oposto: o container no ar e o endereço configurado apontando para um lugar que não existe — subir o container de novo não conserta isso.",
            )}
          </p>
        </div>
      )}

      {schemaOutdated && (
        <div className="rounded-md border border-warning bg-warning-bg p-4 text-sm text-warning-fg">
          <p className="font-medium">{t("Esta instalação está com o banco atrasado.")}</p>
          <p className="mt-1">
            {t(
              "Falta aplicar a migration que registra canal excluído. Até lá, um número que você excluir continua aparecendo nesta lista.",
            )}
          </p>
        </div>
      )}

      {isLoading ? (
        <p className="text-sm text-muted-foreground">{t("Carregando conexões…")}</p>
      ) : isError ? (
        // Lista vazia por falha de carregamento renderizava a tela de primeira
        // instalação ("conecte seu primeiro número") para quem já tem número no
        // ar — o convite exato para parear de novo um aparelho que já está
        // conectado. Erro tem que aparecer como erro.
        <Card className="flex flex-col items-center gap-3 p-8 text-center">
          <Warning size={28} className="text-error-fg" aria-hidden />
          <p className="text-sm text-error-fg">
            {t(
              "Não foi possível carregar seus números — esta lista não está mostrando o que existe.",
            )}
          </p>
          <p className="text-xs text-muted-foreground">
            {t(
              "Não conecte um número novo por causa disto: recarregue a página. Se persistir, o servidor do sistema está fora do ar.",
            )}
          </p>
        </Card>
      ) : list.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 p-8 text-center">
          <Phone size={28} className="text-muted-foreground" aria-hidden />
          <p className="text-sm text-muted-foreground">
            {t("Conecte seu primeiro número de WhatsApp para começar a atender.")}
          </p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {list.map((c) => {
            const info = statusInfo(c.status, t);
            const policy = routing.data?.data?.channels?.find((channel) => channel.id === c.id);
            return (
              <Card key={c.id} className="flex flex-col gap-3 p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Phone size={16} className="text-muted-foreground" aria-hidden />
                      <span className="truncate text-sm font-medium">{channelLabel(c, t)}</span>
                    </div>
                    {c.phone_number && c.display_name && (
                      <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                        {c.phone_number}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    <Badge variant={info.variant}>{info.label}</Badge>
                    {c.chip_mudo === true && <Badge variant="warning" title={t("Canal registrado como conectado, com envios e sem entrada há mais de 24 horas. Atualize a saúde e confira o aparelho.")}>{t("Chip mudo")}</Badge>}
                    {c.chip_mudo === null && <Badge variant="neutral">{t("Recebimento não verificado")}</Badge>}
                  </div>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {c.last_health_check_at
                    ? `${t("Verificado")} ${new Date(c.last_health_check_at).toLocaleString(tagDoIdioma)}`
                    : t("Ainda não verificado")}
                </p>
                <ChannelAiAccess channelId={c.id} />
                <p className="text-xs text-muted-foreground">{t(!policy ? "Consulte os responsáveis em Atendimento." : policy.mode === "legacy_unconfigured" ? "Usa todos os atendentes elegíveis da organização." : policy.mode === "restricted_empty" ? "Ninguém configurado — as conversas ficarão na fila." : "Somente as pessoas selecionadas recebem este número.")}</p>
                <div className="mt-auto flex flex-wrap gap-2">
                  {/* Some no canal oficial em vez de aparecer desabilitado: não é
                      indisponibilidade passageira (como o Excluir sem o serviço no
                      ar), é uma ação que não existe para esse canal — e o clique
                      ainda abriria o diálogo de QR, que ele nunca vai ter. */}
                  {podeReconectar(c) && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busyId === c.id || (c.provider !== "evolution" && !wahaConfigured)}
                      onClick={() => handleReconnect(c)}
                    >
                      {busyId === c.id ? (
                        <CircleNotch size={14} className="animate-spin" aria-hidden />
                      ) : (
                        <ArrowsClockwise size={14} aria-hidden />
                      )}
                      {t("Reconectar")}
                    </Button>
                  )}
                  <Button variant="outline" size="sm" onClick={() => setAntiBanId(c.id)}>
                    <ShieldCheck size={14} aria-hidden />
                    {t("Proteção de envio")}
                  </Button>
                  {/* Sempre disponível: com o serviço fora do ar a conexão sai do
                      CRM do mesmo jeito, e a resposta avisa que o aparelho pode
                      continuar conectado. */}
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={`${t("Excluir")} ${channelLabel(c, t)}`}
                    onClick={() => setToDelete(c)}
                  >
                    <Trash size={14} aria-hidden />
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <AntiBanSheet
        item={pacingItems.find((i) => i.channel_session.id === antiBanId) ?? null}
        canWrite
        onClose={() => setAntiBanId(null)}
      />

      {toDelete && (
        <ExcluirCanalDialog
          canal={toDelete}
          onCancel={() => setToDelete(null)}
          onDeleted={handleDeleted}
        />
      )}

      {qr && (
        <QrDialog
          sessionId={qr.sessionId}
          title={qr.title}
          wahaConfigured={wahaConfigured || qr.evolution === true}
          evolution={qr.evolution === true}
          onClose={() => setQr(null)}
          onConnected={handleConnected}
          onForcePair={forcePair}
        />
      )}
    </div>
  );
}

/**
 * O que a exclusão faz com o que está pendurado no canal, em frases que o
 * operador reconhece.
 *
 * Exportada para teste porque é a parte que MENTE quando erra: a régua real de
 * apagar-ou-arquivar mora no servidor (`loadDeletionImpact`), e o diálogo só
 * traduz o preflight dela. Contagem zero não vira frase — "0 conversas" ocupa
 * espaço e não informa nada.
 */
export function frasesDoImpacto(
  impact: ChannelDeletionImpact,
  t: (texto: string) => string = (texto) => texto,
): string[] {
  // O motor de disparo vale nos dois desfechos: apagar ou arquivar, o chip sai do motor e a fila dele é cancelada.
  const doMotor =
    impact.disparo.chips_no_motor > 0
      ? [t("Este número está no motor de disparo; ele sai do motor e os envios pendentes dele são cancelados.")]
      : [];
  if (impact.outcome === "delete") {
    return [t("Este número não tem conversa, mensagem nem configuração ligada a ele."), ...doMotor];
  }

  const noInbox = enumerar(
    [
      contar(impact.history.conversations, "conversa", "conversas", t),
      contar(impact.history.messages, "mensagem", "mensagens", t),
    ],
    t,
  );
  const semNumero = enumerar(
    [
      contar(impact.history.agent_versions, "versão de agente", "versões de agente", t),
      contar(impact.configuration.ai_routers, "roteador de IA", "roteadores de IA", t),
      contar(
        impact.configuration.channel_knobs,
        "ajuste de proteção de envio",
        "ajustes de proteção de envio",
        t,
      ),
    ],
    t,
  );

  const frases: string[] = [];
  if (noInbox) frases.push(`${t("Continua no inbox:")} ${noInbox}.`);
  if (semNumero)
    frases.push(`${t("Fica salvo, mas sem número — para de atender:")} ${semNumero}.`);
  // Sobra o caso em que só há registro interno (auditoria de envio): nada a
  // listar, mas o canal continua sendo arquivado, e prometer "não tem nada
  // ligado" seria falso.
  if (frases.length === 0) {
    frases.push(
      t("Este canal tem registros internos, por isso ele é arquivado em vez de apagado."),
    );
  }
  return [...frases, ...doMotor];
}

/**
 * Confirmação de exclusão que só promete o que o servidor vai fazer.
 *
 * O texto anterior era fixo, e texto fixo não descreve dois desfechos: ele
 * narrava o ramo que ARQUIVA ("as conversas continuam no inbox — só o canal é
 * removido") mesmo quando a linha vai ser apagada, e mandava "escanear o QR de
 * novo", que não existe no canal oficial. E calava justamente sobre o que o
 * operador teme perder — roteador de IA, versões de agente, ajuste de envio —,
 * que agora chega no preflight. O desfecho vem da MESMA função que o DELETE usa
 * para decidir, antes do clique.
 */
function ExcluirCanalDialog({
  canal,
  onCancel,
  onDeleted,
}: {
  canal: ChannelSession;
  onCancel: () => void;
  onDeleted: () => void;
}) {
  const t = useT();
  const [excluindo, setExcluindo] = useState(false);
  const {
    data: impact,
    isPending,
    isError,
  } = useQuery({
    queryKey: ["channel-deletion-impact", canal.id],
    queryFn: async () => {
      const res = await apiClient.get<{ data: { deletion_impact?: ChannelDeletionImpact } }>(
        `/api/v1/channel-sessions/${canal.id}?impact=1`,
      );
      return res.data.deletion_impact ?? null;
    },
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });

  const excluir = async () => {
    setExcluindo(true);
    try {
      const res = await apiClient.delete<{
        data: {
          id: string;
          archived: boolean;
          impact: ChannelDeletionImpact;
          revogado?: boolean;
          aviso?: string | null;
        };
      }>(
        `/api/v1/channel-sessions/${canal.id}`,
        undefined,
        // A rota gasta até 6 s tentando revogar no servidor de WhatsApp antes de
        // tocar no banco. O limite padrão (10 s, com até 3 tentativas) desistia
        // antes da resposta e disparava exclusões concorrentes: aqui espera mais
        // que o orçamento do servidor e não repete sozinho.
        { timeoutMs: 20_000, retryOnNetworkError: false },
      );
      // O canal JÁ saiu do CRM: servidor que não respondeu é aviso, não erro.
      if (res.data.aviso) {
        toast.warning(t(res.data.aviso));
        onDeleted();
        return;
      }
      const conversas = res.data.impact.history.conversations;
      toast.success(
        !res.data.archived
          ? t("Canal excluído.")
          : conversas > 0
            ? `${t("Canal removido.")} ${contar(conversas, "conversa continua", "conversas continuam", t)} ${t("no inbox.")}`
            : t("Canal removido. O que estava ligado a ele continua guardado."),
      );
      onDeleted();
    } catch (err) {
      toast.error(errMsg(err, "Não foi possível excluir o canal.", t));
    } finally {
      setExcluindo(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !excluindo && onCancel()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t("Excluir")} {channelLabel(canal, t)}?
          </DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-2">
              <p>{t("O número será desconectado do WhatsApp e sai desta lista.")}</p>
              <p>{t("Mesmo com o servidor fora do ar, a conexão sai do CRM. Conversas e contatos ficam.")}</p>
              {isPending ? (
                <p>{t("Verificando o que está ligado a este número…")}</p>
              ) : isError || !impact ? (
                <p>
                  {t(
                    "Não foi possível verificar o que está ligado a este número. A exclusão continua possível — quem decide apagar ou arquivar é o servidor, e ele preserva o histórico quando existe.",
                  )}
                </p>
              ) : (
                <ul className="list-disc space-y-1 pl-5">
                  {frasesDoImpacto(impact, t).map((frase) => (
                    <li key={frase}>{frase}</li>
                  ))}
                </ul>
              )}
              <p>{t("Para usar este número de novo, será preciso conectá-lo outra vez.")}</p>
            </div>
          </DialogDescription>
        </DialogHeader>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" disabled={excluindo} onClick={onCancel}>
            {t("Cancelar")}
          </Button>
          {/* Enquanto o preflight não volta, confirmar seria confirmar no escuro:
              o diálogo ainda não sabe o que vai acontecer, então não pode pedir
              a decisão. */}
          <Button variant="destructive" disabled={excluindo || isPending} onClick={excluir}>
            {excluindo ? (
              <CircleNotch size={14} className="animate-spin" aria-hidden />
            ) : (
              <Trash size={14} aria-hidden />
            )}
            {t("Excluir")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Estados em que o modal de QR não tem mais o que esperar do canal. */
const ESTADOS_SEM_ESPERA_NO_QR: ReadonlySet<string> = new Set(["WORKING", "FAILED", "STOPPED"]);

/** Quanto tempo o modal espera o QR de uma instância da Evolution em `close` antes de parar. */
const PRAZO_QR_EVOLUTION_FECHADA_MS = 120_000;

export function QrDialog({
  sessionId,
  title,
  wahaConfigured,
  evolution,
  onClose,
  onConnected,
  onForcePair,
}: {
  sessionId: string;
  title: string;
  wahaConfigured: boolean;
  evolution: boolean;
  onClose: () => void;
  onConnected: () => void;
  onForcePair: (sessionId: string) => Promise<void>;
}) {
  const t = useT();
  const [status, setStatus] = useState<string>("STARTING");
  const [tick, setTick] = useState(0);
  const [pairing, setPairing] = useState(false);
  const done = useRef(false);
  /** Evolution em `close` por 2 min sem QR nenhum: o modal desiste e volta a "desvinculado". */
  const [desistiuDoQr, setDesistiuDoQr] = useState(false);
  const fechadaEsperandoQr = evolution && status === "STOPPED" && !desistiuDoQr;
  // Evolution esperando pareamento fica em `connecting`, que o CRM grava como STARTING.
  // Sem isto a tela mostrava "Preparando o código…" para sempre (bug de 10/11/2026).
  // A conexão nova da Evolution nasce sem sessão, e a Evolution a dá como `close` (STOPPED)
  // até o primeiro `/instance/connect`, que é justamente o pedido do QR. Na Evolution STOPPED é "sem
  // sessão": mostra o QR (o pedido abre a sessão) em vez de "desvinculado". FAILED segue desvinculado.
  const mostraQr = status === "SCAN_QR_CODE" || (evolution && status === "STARTING") || fechadaEsperandoQr;
  const pairingData = useQuery({
    queryKey: ["evolution-pairing", sessionId],
    queryFn: () => apiClient.get<{ data: { base64: string | null; pairing_code: string | null; warning: string | null } }>(
      `/api/v1/channel-sessions/${sessionId}/qr?format=json`, { timeoutMs: 20_000 },
    ),
    enabled: evolution && mostraQr,
    refetchInterval: 15_000,
    staleTime: 0,
    gcTime: 0,
  });

  // Conectado ou desvinculado: nada mais muda sem alguém agir (fechar, ou "Gerar
  // novo QR", que volta o status para STARTING e religa a consulta). Sem esta
  // parada, o modal aberto em "desvinculado" consultava o canal a cada 3 s para
  // sempre (varredura de 10/11/2026).
  const esperando = !ESTADOS_SEM_ESPERA_NO_QR.has(status) || fechadaEsperandoQr;

  // Em `close` o pedido do QR é a ação certa, mas se ele nunca vem (número desvinculado pelo
  // celular, Evolution que não gera), consultar a cada 3 s para sempre era a regressão que a varredura de
  // 10/11 tinha tirado. Depois de 2 min sem QR, para e oferece "Gerar novo QR" (que religa a consulta).
  const temCodigo = Boolean(pairingData.data?.data.base64 || pairingData.data?.data.pairing_code);
  useEffect(() => {
    if (!fechadaEsperandoQr || temCodigo) return;
    const id = setTimeout(() => setDesistiuDoQr(true), PRAZO_QR_EVOLUTION_FECHADA_MS);
    return () => clearTimeout(id);
  }, [fechadaEsperandoQr, temCodigo]);
  useEffect(() => {
    if (!wahaConfigured || !esperando) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await apiClient.get<{ data: { status: string } }>(
          `/api/v1/channel-sessions/${sessionId}`,
        );
        if (cancelled) return;
        const s = res.data.status;
        setStatus(s);
        if (s === "WORKING" && !done.current) {
          done.current = true;
          onConnected();
        }
      } catch {
        // erro transitório de rede — o próximo tick tenta de novo
      }
    };
    void poll();
    const iv = setInterval(poll, 3000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [sessionId, wahaConfigured, onConnected, esperando]);

  // O QR do WhatsApp EXPIRA — medido no WAHA, a imagem muda a cada ~20s. Carregar
  // uma vez só (o que esta tela fazia) deixava um código morto na tela: quem
  // demorasse a pegar o celular escaneava algo que o WhatsApp já tinha
  // invalidado. Recarregamos a cada 15s enquanto estivermos em SCAN_QR_CODE,
  // com folga sobre a expiração.
  // A primeira imagem não precisa de tick novo: o <img> só é montado quando o
  // status vira SCAN_QR_CODE, e essa montagem já busca o QR do momento. O
  // intervalo cuida só das renovações seguintes.
  useEffect(() => {
    if (status !== "SCAN_QR_CODE" || evolution) return;
    const iv = setInterval(() => setTick((v) => v + 1), 15_000);
    return () => clearInterval(iv);
  }, [status, evolution]);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {t(
              "No celular: WhatsApp → Aparelhos conectados → Conectar um aparelho → escaneie o código.",
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-[16rem] flex-col items-center justify-center gap-3 py-2">
          {mostraQr ? (
            // Sem `key={tick}`: trocar só o src reaproveita o mesmo <img>, e o
            // browser segura o frame anterior até decodificar o novo. Remontar o
            // elemento a cada refresh é o que causaria o flash branco.
            <>
            {(!evolution || pairingData.data?.data.base64) && (
              // QR dinâmico servido pelo proxy autenticado, sem otimização/caching.
              // eslint-disable-next-line @next/next/no-img-element
              <img
              src={evolution ? pairingData.data?.data.base64 ?? "" : `/api/v1/channel-sessions/${sessionId}/qr?t=${tick}`}
              alt={t("QR Code para conectar WhatsApp")}
              className="h-64 w-64 rounded-md border bg-white p-2"
              />
            )}
            {evolution && pairingData.data?.data.pairing_code && <p className="font-mono text-xl" aria-label={t("Código de pareamento")}>{pairingData.data.data.pairing_code}</p>}
            {evolution && pairingData.data?.data.warning && <p role="status" className="text-sm text-warning-fg">{t(pairingData.data.data.warning)}</p>}
            {evolution && (pairingData.isError || (!pairingData.isPending && !pairingData.data?.data.base64 && !pairingData.data?.data.pairing_code)) && <p role="status" className="text-sm">{t("O código ainda não está disponível. Aguardando nova tentativa…")}</p>}
            </>
          ) : status === "WORKING" ? (
            <div className="flex flex-col items-center gap-2 text-sm font-medium text-success-fg">
              <CheckCircle size={28} weight="fill" aria-hidden />
              {t("Conectado!")}
            </div>
          ) : status === "FAILED" || status === "STOPPED" ? (
            // Chegar aqui quase sempre significa credencial revogada: o número
            // foi desvinculado pelo celular e o engine não tem como voltar
            // sozinho. Antes esta tela era um beco sem saída ("tente
            // Reconectar" levava de volta ao mesmo FAILED); agora ela oferece a
            // única ação que de fato resolve.
            <div className="flex flex-col items-center gap-3 text-center">
              <p className="text-sm text-error-fg">
                {t(
                  "Este número foi desvinculado do WhatsApp. Para usá-lo de novo é preciso parear outra vez.",
                )}
              </p>
              <Button
                size="sm"
                disabled={pairing}
                onClick={async () => {
                  setPairing(true);
                  try {
                    await onForcePair(sessionId);
                    setDesistiuDoQr(false);
                    setStatus("STARTING");
                  } catch (err) {
                    toast.error(errMsg(err, "Não foi possível gerar um novo QR.", t));
                  } finally {
                    setPairing(false);
                  }
                }}
              >
                {pairing ? (
                  <CircleNotch size={14} className="animate-spin" aria-hidden />
                ) : (
                  <ArrowsClockwise size={14} aria-hidden />
                )}
                {t("Gerar novo QR")}
              </Button>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2 text-sm text-muted-foreground">
              <CircleNotch size={28} className="animate-spin" aria-hidden />
              {t("Preparando o código…")}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
