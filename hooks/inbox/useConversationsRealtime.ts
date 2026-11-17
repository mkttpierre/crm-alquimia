"use client";
import { invalidarConversasAgrupado } from "@/lib/inbox/invalidar-conversas";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import {
  agendarAtualizacaoDaConversa,
  registrarMeuId,
  removerConversaDasListas,
} from "@/lib/inbox/atualizar-conversa-no-cache";
import { eventoDeConversa, filtrosAvaliaveisNoCliente } from "@/lib/inbox/atualizar-lista-conversas";
import { carregarPaginasEmParalelo } from "@/lib/inbox/carregar-paginas-em-paralelo";
import { useRealtimeChannel } from "@/hooks/realtime/useRealtimeChannel";
import { useRefetchDeSeguranca } from "@/hooks/realtime/useRefetchDeSeguranca";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { Conversation } from "@/lib/types/messaging";
import type { ComandoDoBanco } from "@/lib/inbox/comando-da-conversa";

export interface ContactSummary {
  id: string;
  display_name: string | null;
  name: string | null;
  phone_number: string | null;
  tags: string[];
  is_blocked: boolean;
  is_anonymized: boolean;
  /** Caminho da foto no bucket privado. A tela nunca usa este valor como src —
   *  só para saber SE existe foto; a imagem vem de /api/v1/contacts/{id}/avatar,
   *  que assina a URL. Opcional: conversas em cache de antes do campo existir. */
  avatar_storage_path?: string | null;
  /**
   * A trava irrevogável pelo agente: ligada, NENHUM envio automático sai (o
   * guard de before-send lê esta coluna). É o sinal mais honesto de "a pessoa
   * está no comando desta conversa" — e o que decide se o botão de devolver o
   * atendimento aparece. Opcional: conversas em cache de antes do campo existir.
   */
  force_human?: boolean | null;
}

/**
 * O número POR ONDE a conversa entrou.
 *
 * Não é o número do cliente — é o da empresa. Com um canal só a distinção não
 * existe; com dois, saber por qual linha a pessoa escreveu é o que decide o tom
 * da resposta e qual número ela vai ver respondendo.
 */
export interface ChannelSummary {
  phone_number: string | null;
  display_name: string | null;
  /**
   * Quem impõe a regra deste número. A tela NÃO interpreta este valor — ela o
   * entrega a `estadoDaJanela` (lib/channels), que decide se há relógio a
   * mostrar. Ler o campo não é nomear o provider; o `if (provider === ...)` é
   * que a doutrina proíbe, e ele mora atrás do seam.
   */
  provider: string | null;
}

export type ConversationWithContact = Conversation & {
  contacts?: ContactSummary | null;
  channel_sessions?: ChannelSummary | null;
  /**
   * O nome de quem atende, resolvido no servidor.
   *
   * Opcional e nulável, e as duas coisas significam algo diferente: ausente é
   * resposta em cache de antes deste campo existir; `null` é um estado DECLARADO
   * — self-host sem service role, ou lookup que falhou (ver
   * `lib/users/nome-do-atendente.ts`). Nenhum dos dois quer dizer "sem
   * responsável": o dono é o `assigned_to_user_id`, o nome é a cortesia.
   */
  assigned_to_user_name?: string | null;
};

/** O vocabulário de LEITURA (7), que inclui os dois estados que só o motor escreve. */
export type StatusDeConversa =
  | "open"
  | "pending"
  | "resolved"
  | "claimed"
  | "ai_handling"
  | "closed"
  | "archived";

export interface ConversationsFilters {
  /** Um status ou vários — a aba Fila precisa de dois (open + pending). */
  status?: StatusDeConversa | readonly StatusDeConversa[];
  /** Esconde fechadas/arquivadas — ver `exclude_finished` no schema da rota. */
  exclude_finished?: boolean;
  assigned_to?: "me" | "unassigned" | string;
  /**
   * QUEM MANDA na conversa — o filtro que as abas Fila e Automático passaram a
   * usar (migration 0203). Pergunta diferente de `status`: aquele é ciclo de
   * vida, este é quem responde a próxima mensagem do cliente.
   */
  comando?: readonly ComandoDoBanco[];
  search?: string;
  channel_session_id?: string;
  tag?: string;
}

interface ListResponse {
  data: ConversationWithContact[];
  meta?: { cursor?: string | null; has_more?: boolean };
}

/** Carga completa: página no teto da API e teto de pedidos em voo ao mesmo tempo. */
const PAGINA_DA_CARGA_COMPLETA = 100;
const PEDIDOS_SIMULTANEOS_DA_CARGA_COMPLETA = 4;

/** Foco/volta à aba só recarrega tudo se a última recarga completa for mais velha que isto. */
export const RECARGA_NO_FOCO_APOS_MS = 60_000;

export function useConversationsRealtime(
  filters: ConversationsFilters,
  orgId: string | null,
  opts: {
    enabled?: boolean;
    todasAsPaginas?: boolean;
    /** Quem está olhando — necessário para decidir `assigned_to=me` no cliente. */
    meuId?: string | null;
  } = {},
) {
  const qc = useQueryClient();
  const queryKey = ["conversations", filters, opts.todasAsPaginas ?? false] as const;

  const query = useInfiniteQuery({
    queryKey,
    enabled: opts.enabled ?? true,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const qs = new URLSearchParams();
      // Lista vira `open,pending`; valor único continua saindo como antes.
      if (filters.status) {
        const lista: readonly StatusDeConversa[] =
          typeof filters.status === "string" ? [filters.status] : filters.status;
        qs.set("status", lista.join(","));
      }
      // O `qs.set` é metade do trabalho, e é a metade que o typecheck NÃO pega:
      // com o campo no tipo e sem esta linha, a aba Fila pediria filtro nenhum e
      // mostraria a lista inteira — parecendo funcionar.
      if (filters.comando && filters.comando.length > 0) {
        qs.set("comando", filters.comando.join(","));
      }
      if (filters.exclude_finished) qs.set("exclude_finished", "true");
      if (filters.assigned_to) qs.set("assigned_to", filters.assigned_to);
      if (filters.search) qs.set("search", filters.search);
      if (filters.channel_session_id) qs.set("channel_session_id", filters.channel_session_id);
      if (filters.tag) qs.set("tag", filters.tag);
      if (pageParam) qs.set("cursor", pageParam);
      // Carga completa (abas por estado do multiatendimento): página no teto da API (100) para metade das voltas.
      qs.set("limit", opts.todasAsPaginas ? String(PAGINA_DA_CARGA_COMPLETA) : "50");
      try {
        if (!opts.todasAsPaginas) return await apiClient.get<ListResponse>(`/api/v1/conversations?${qs.toString()}`);
        // Por deslocamento e em paralelo (até 4 em voo), não mais uma página por
        // vez pelo cursor: ver lib/inbox/carregar-paginas-em-paralelo.ts.
        const data = await carregarPaginasEmParalelo(
          (offset) => {
            const daPagina = new URLSearchParams(qs);
            daPagina.set("offset", String(offset));
            return apiClient.get<ListResponse>(`/api/v1/conversations?${daPagina.toString()}`);
          },
          { tamanho: PAGINA_DA_CARGA_COMPLETA, simultaneas: PEDIDOS_SIMULTANEOS_DA_CARGA_COMPLETA },
        );
        return { data, meta: { has_more: false } };
      } catch (err) {
        showApiError(err);
        throw err;
      }
    },
    getNextPageParam: (last) =>
      last.meta?.has_more && last.meta.cursor ? last.meta.cursor : undefined,
    // Mesma razão do hilo de mensagens: o inbox é a tela em que a informação
    // chega de fora enquanto ninguém olha, e voltar para a aba é quando a
    // defasagem aparece. Segunda rede — a primeira é o Realtime.
    //
    // Mas só recarrega TUDO se a última recarga completa for velha: os eventos
    // do canal já mantêm a lista em dia conversa a conversa (ver `onChange`), e
    // a lista inteira custa ~1 s de banco.
    refetchOnWindowFocus: (q) => Date.now() - q.state.dataUpdatedAt > RECARGA_NO_FOCO_APOS_MS,
  });

  // Estado lido de dentro do `onChange`: ref, para ele ficar estável.
  const vivo = useRef({ filters, meuId: opts.meuId ?? null });
  useEffect(() => {
    vivo.current = { filters, meuId: opts.meuId ?? null };
    registrarMeuId(qc, opts.meuId ?? null);
  });

  const onChange = useCallback(
    (payload: unknown) => {
      const ev = eventoDeConversa(payload);
      const { filters: f, meuId } = vivo.current;
      // Sem id de conversa (reconexão) ou com filtro que só o servidor avalia
      // (busca): recarga completa, agrupada — como sempre foi.
      if (!ev || !filtrosAvaliaveisNoCliente(f, meuId)) {
        invalidarConversasAgrupado(qc);
        return;
      }
      if (ev.tipo === "DELETE") removerConversaDasListas(qc, ev.id);
      else agendarAtualizacaoDaConversa(qc, ev.id);
    },
    [qc],
  );

  // G4-01 (visibility_mode): a subscription postgres_changes HERDA a RLS de
  // SELECT de `conversations` — o Supabase Realtime avalia as policies do usuário
  // autenticado antes de entregar cada change (docs: "Realtime respects RLS
  // policies"; requer a tabela na publication `supabase_realtime` + REPLICA
  // IDENTITY, já configurados na migration 0025). Como a policy `conversations_select`
  // (migration 0035) agora aplica fn_can_view_conversation(role + visibility_mode +
  // assigned_to), um agent NÃO recebe changes de conversa fora do seu escopo, mesmo
  // com o filtro amplo `organization_id=eq.<org>` abaixo. Prova do filtro em
  // tests/invariants/gov-5-visibility-scope.test.ts (SELECT sob role agent = 0 rows
  // para conversa de outro atendente — o mesmo SELECT que o Realtime executa).
  const { status: realtimeStatus, ultimaEntrega } = useRealtimeChannel({
    name: orgId ? `inbox-${orgId}` : "inbox-disabled",
    postgresChanges: orgId
      ? {
          event: "*",
          schema: "public",
          table: "conversations",
          filter: `organization_id=eq.${orgId}`,
        }
      : undefined,
    onChange,
    enabled: !!orgId,
  });

  /**
   * A REDE DE SEGURANÇA — o inbox era a única tela viva que não tinha.
   *
   * O board e a linha do tempo do lead já a usavam; a lista de conversas só
   * tinha `refetchOnWindowFocus`, que exige a pessoa TROCAR DE ABA para
   * ressincronizar. Só que o inbox é a tela em que se fica parado olhando: com
   * o canal morto e a aba em foco, ela ficava congelada indefinidamente num
   * passado que parece presente — e o único conserto era o F5, que foi
   * exatamente o sintoma relatado.
   *
   * A assinatura é a contagem de conversas mais o maior `last_message_at`: é
   * sensível a tudo que o canal deveria ter trazido (conversa nova, mensagem
   * nova numa existente) e barata de calcular. `updated_at` não serviria
   * sozinho — o que muda a ordem da lista é a última mensagem.
   */
  const seguranca = useRefetchDeSeguranca<{ pages: ListResponse[] }>({
    queryKey,
    assinatura: (d) => {
      const conversas = d?.pages.flatMap((p) => p.data) ?? [];
      let maior = "";
      for (const c of conversas) {
        const t = c.last_message_at ?? "";
        if (t > maior) maior = t;
      }
      return `${conversas.length}:${maior}`;
    },
    ultimaEntrega,
    enabled: !!orgId,
    aoVoltarSeMaisVelhoQueMs: RECARGA_NO_FOCO_APOS_MS,
  });

  return { ...query, realtimeStatus, seguranca };
}
