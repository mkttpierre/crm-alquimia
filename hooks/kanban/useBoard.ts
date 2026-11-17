"use client";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ehEcoLocal } from "@/lib/kanban/local-echo";
import { useRealtimeChannel } from "@/hooks/realtime/useRealtimeChannel";
import { useRefetchDeSeguranca } from "@/hooks/realtime/useRefetchDeSeguranca";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";
import {
  carregadosNaEtapa,
  mesclarPaginaDaEtapa,
  urlDaPagina,
  urlDoBoard,
} from "@/lib/kanban/board-pagina";
import { filtersToParams, type LeadFilters } from "@/lib/kanban/filters";
import type { BoardData, StagePageData } from "@/lib/kanban/types";

/**
 * Fetch board via API route (NOT direct supabase-js).
 *
 * Why: the auth cookie `sb-crm-alquimia-auth` is httpOnly so the browser Supabase
 * client cannot read it — auth.uid() ends up null, RLS hides the pipeline,
 * and PostgREST returns PGRST116. Routing through /api/v1/pipelines/[id]/board
 * uses the server-side cookie reader, identical to every other authed query.
 */
async function getData<T>(url: string): Promise<T> {
  const res = await apiClient.get<{ data: T }>(url);
  // apiClient unwraps { data, meta } envelope already in some helpers;
  // ours returns the parsed JSON literally. Handle both shapes safely.
  if (res && typeof res === "object" && "data" in res) {
    return (res as { data: T }).data;
  }
  return res as unknown as T;
}

export interface UseBoardOpts {
  /** Filtros da tela — vão para o servidor (a página e o total respeitam). */
  filtros?: LeadFilters;
  /** Deep link `?lead=`: o servidor devolve o lead mesmo fora das páginas. */
  leadEmFoco?: string | null;
}

/**
 * Quanto tempo o card fica marcado como "acabou de chegar".
 *
 * NÃO é para bater com `--duration-slow` (320ms) do CSS, e a diferença é
 * DELIBERADA: com movimento normal a animação dura os 320ms e o resto da
 * janela é invisível; com `prefers-reduced-motion` o fundo estático fica os
 * 1200ms inteiros, que é o que torna a alternativa perceptível — 320ms de
 * fundo estático ninguém vê. Alinhar os dois números "para consertar a
 * divergência" apaga a pista de acessibilidade.
 */
const PULSE_MS = 1_200;

/** O id do lead dentro do payload do postgres_changes (new, ou old no delete). */
function idDoEvento(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as { new?: { id?: unknown }; old?: { id?: unknown } };
  const id = p.new?.id ?? p.old?.id;
  return typeof id === "string" ? id : null;
}

export function useBoard(pipelineId: string | null, opts: UseBoardOpts = {}) {
  const qc = useQueryClient();
  const filtrosQs = filtersToParams(opts.filtros ?? {});
  // Os filtros entram na chave: trocar de filtro é outra lista. Quem invalida
  // por `["board", pipelineId]` continua alcançando todas (casa por prefixo).
  const queryKey = useMemo(() => ["board", pipelineId, filtrosQs] as const, [pipelineId, filtrosQs]);
  const chave = `${pipelineId}|${filtrosQs}`;

  /**
   * Quantos cards cada etapa tem abertos NESTA lista (chave = pipeline+filtros).
   * O refetch (realtime, rede de segurança, mutação) pede o mesmo tanto, em vez
   * de recolher para a primeira página o que o usuário abriu com "Mostrar mais"
   * — e em vez de rebaixar o funil inteiro, que era o comportamento anterior.
   */
  const abertos = useRef<{ chave: string; limites: Map<string, number> }>({
    chave,
    limites: new Map(),
  });
  const leadEmFocoRef = useRef(opts.leadEmFoco ?? null);
  useEffect(() => {
    leadEmFocoRef.current = opts.leadEmFoco ?? null;
  }, [opts.leadEmFoco]);
  const [carregandoEtapas, setCarregandoEtapas] = useState<Set<string>>(new Set());

  /**
   * Cards que acabaram de mudar POR EVENTO REMOTO — o pulso da Wave 3.
   *
   * Só entra aqui o que veio de fora: a própria ação já tem feedback (o card se
   * move sob o cursor) e pulsar nela seria ruído com cara de novidade. Cada id
   * sai sozinho depois de PULSE_MS: o pulso acontece UMA vez e cessa, em vez de
   * virar destaque persistente.
   */
  const [pulses, setPulses] = useState<Map<string, number>>(new Map());
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const query = useQuery({
    queryKey,
    queryFn: () => {
      const limites =
        abertos.current.chave === chave ? abertos.current.limites : new Map<string, number>();
      return getData<BoardData>(
        urlDoBoard(pipelineId as string, filtrosQs, limites, leadEmFocoRef.current),
      );
    },
    enabled: !!pipelineId,
    // Trocar o filtro troca a chave: sem isto a tela inteira voltava para
    // "Carregando…" a cada tecla da busca. Com isto a lista anterior fica (e o
    // `applyFilters` do cliente já a estreita) até a resposta filtrada chegar.
    placeholderData: keepPreviousData,
  });

  /** "Mostrar mais" de uma etapa: busca a página seguinte e junta no cache. */
  const carregarMais = useCallback(
    async (stageId: string) => {
      if (!pipelineId) return;
      const atual = qc.getQueryData<BoardData>(queryKey);
      if (!atual) return;
      setCarregandoEtapas((s) => new Set(s).add(stageId));
      try {
        const pagina = await getData<StagePageData>(
          urlDaPagina(pipelineId, filtrosQs, stageId, carregadosNaEtapa(atual, stageId)),
        );
        // Um refetch em voo foi disparado com os limites ANTIGOS: se ele chegar
        // depois desta página, recolhe a coluna. Cancela, junta, e refaz já
        // com o limite novo — sem perder a mudança que o refetch ia trazer.
        const refetchEmVoo = qc.isFetching({ queryKey, exact: true }) > 0;
        if (refetchEmVoo) await qc.cancelQueries({ queryKey, exact: true });
        const novo = qc.setQueryData<BoardData>(queryKey, (b) =>
          b ? mesclarPaginaDaEtapa(b, pagina) : b,
        );
        if (abertos.current.chave !== chave) abertos.current = { chave, limites: new Map() };
        if (novo) abertos.current.limites.set(stageId, carregadosNaEtapa(novo, stageId));
        if (refetchEmVoo) void qc.invalidateQueries({ queryKey, exact: true });
      } catch (err) {
        showApiError(err);
      } finally {
        setCarregandoEtapas((s) => {
          const n = new Set(s);
          n.delete(stageId);
          return n;
        });
      }
    },
    [qc, queryKey, pipelineId, filtrosQs, chave],
  );

  const onChange = useCallback(
    (payload: unknown) => {
      // Conservative: invalidate the board on any change. Optimistic patches
      // arrive faster via useMoveCard's onMutate; this just reconciles
      // cross-user changes within ~250ms. O refetch é paginado: traz só as
      // páginas abertas de cada etapa (ver `abertos`), não o funil inteiro.
      qc.invalidateQueries({ queryKey });

      const leadId = idDoEvento(payload);
      // Janela, não marca gasta por evento: uma ação minha chega aqui em DUAS
      // parcelas (o movimento e o carimbo de `last_activity_at` da atividade).
      if (!leadId || ehEcoLocal(leadId)) return;

      // CONTADOR, não booleano. Com um Set, o segundo evento remoto no mesmo
      // card dentro da janela não mudava nada: o id já estava lá, a classe
      // nunca saía do elemento e a animação CSS não reinicia sem a classe
      // sair — pior, o timeout do primeiro evento apagava tudo no meio do
      // segundo. Chegava coisa de fora e a tela não dizia nada, que é o pecado
      // que esta peça existe para matar.
      setPulses((atual) => {
        const proximo = new Map(atual);
        proximo.set(leadId, (proximo.get(leadId) ?? 0) + 1);
        return proximo;
      });

      // Cada evento reinicia a contagem: a janela é do ÚLTIMO evento.
      const anterior = timers.current.get(leadId);
      if (anterior) clearTimeout(anterior);
      timers.current.set(
        leadId,
        setTimeout(() => {
          timers.current.delete(leadId);
          setPulses((atual) => {
            if (!atual.has(leadId)) return atual;
            const proximo = new Map(atual);
            proximo.delete(leadId);
            return proximo;
          });
        }, PULSE_MS),
      );
    },
    [qc, queryKey],
  );

  // O STATUS DO CANAL NÃO PODE SER DESCARTADO. `useRealtimeChannel` calcula
  // SUBSCRIBED / CHANNEL_ERROR / TIMED_OUT / CLOSED e, sem atribuir o retorno,
  // esse valor morria na linha seguinte — enquanto ele é o único que separa
  // DUAS FAMÍLIAS INTEIRAS de causa: "a assinatura morreu" e "nada aconteceu"
  // têm exatamente a mesma aparência na tela, que é silêncio.
  //
  // Assinatura que morre calada é peça sem sinal de vida: o "log morto" do
  // checklist do sistema vivo, na versão cara, porque a tela continua parecendo
  // certa enquanto o board já não escuta mais nada.
  const { status: realtimeStatus, ultimaEntrega } = useRealtimeChannel({
    name: pipelineId ? `kanban-${pipelineId}` : "kanban-disabled",
    postgresChanges: pipelineId
      ? {
          event: "*",
          schema: "public",
          table: "crm_leads",
          filter: `pipeline_id=eq.${pipelineId}`,
        }
      : undefined,
    onChange,
    enabled: !!pipelineId,
  });

  // Timers pendentes morrem com o componente — senão um setState chega depois
  // do unmount e o React reclama (e o Map de timers vaza).
  useEffect(() => {
    const pendentes = timers.current;
    return () => {
      for (const t of pendentes.values()) clearTimeout(t);
      pendentes.clear();
    };
  }, []);

  // A REDE DE SEGURANÇA. Sem ela, um canal que para de entregar deixa o board
  // congelado num passado que parece presente — e nem voltar para a aba
  // conserta. A assinatura é a contagem de leads mais o maior `updated_at`: é
  // sensível a exatamente o que o canal deveria ter trazido (lead novo, lead
  // movido, lead editado) e barata de calcular a cada verificação.
  const seguranca = useRefetchDeSeguranca<BoardData>({
    queryKey,
    assinatura: (d) => {
      const leads = d?.leads ?? [];
      let maior = "";
      for (const l of leads) {
        const u = (l as { updated_at?: string }).updated_at ?? "";
        if (u > maior) maior = u;
      }
      // Com o board paginado, lead novo fora da página não muda `leads`: os
      // totais por etapa entram na assinatura para continuar enxergando-o.
      const totais = Object.entries(d?.stage_pages ?? {})
        .map(([id, p]) => `${id}=${p.total}`)
        .sort()
        .join(",");
      return `${leads.length}:${maior}:${totais}`;
    },
    ultimaEntrega,
    enabled: !!pipelineId,
  });

  return { ...query, pulses, realtimeStatus, seguranca, carregarMais, carregandoEtapas };
}
