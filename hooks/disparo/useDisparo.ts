"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type {
  ChipDaTela,
  ConfigDaTela,
  ConversaDaTela,
  EdicaoDaConfig,
  EnvioDaTela,
  EstadoDoMotor,
  FiltroDaFila,
  Pagina,
  ProblemaDeCampo,
  SimulacaoDaTela,
} from "@/lib/disparo-painel/esquemas";

/**
 * Leituras e edições do motor de disparo (`/api/v1/disparo/*`). Trocar o modo é um `PATCH` como os outros, mas a
 * rota só o aceita de `admin`, e o envio real continua exigindo a segunda chave no servidor.
 *
 * Atualiza sozinho a cada 30 s: é um painel que o operador deixa aberto para ver o motor andar, e
 * cada leitura é uma consulta barata e limitada à página. As abas escondidas não consultam.
 */
const BASE = "/api/v1/disparo";
const CHAVE = ["disparo"] as const;
const A_CADA = 30_000;

/**
 * Erro de uma rota do motor, com os campos que o servidor recusou (422) quando houver. Sem mensagem do servidor, a
 * mensagem é uma frase completa em português que a tela passa por `t()` (nunca uma palavra solta).
 */
export class ErroDoMotor extends Error {
  constructor(
    mensagem: string,
    readonly status: number,
    readonly campos: ProblemaDeCampo[] = [],
  ) {
    super(mensagem);
  }
}

async function lerJson<T>(res: Response, oQueFalhou: string): Promise<T> {
  if (!res.ok) {
    const corpo = (await res.json().catch(() => null)) as {
      error?: { message?: string; details?: { campos?: ProblemaDeCampo[] } };
    } | null;
    throw new ErroDoMotor(corpo?.error?.message ?? oQueFalhou, res.status, corpo?.error?.details?.campos ?? []);
  }
  return ((await res.json()) as { data: T }).data;
}

const enviar = (metodo: "POST" | "PATCH" | "DELETE", caminho: string, corpo?: unknown) =>
  fetch(`${BASE}${caminho}`, {
    method: metodo,
    headers: corpo === undefined ? undefined : { "Content-Type": "application/json" },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });

export type EstadoDaResposta = EstadoDoMotor | { existe: false; agora: string };

export function useEstadoDoMotor() {
  return useQuery({
    queryKey: [...CHAVE, "estado"],
    queryFn: async () => lerJson<EstadoDaResposta>(await fetch(`${BASE}/estado`), "Não foi possível ler o estado do motor."),
    refetchInterval: A_CADA,
    staleTime: 10_000,
  });
}

export function useFilaDoMotor(estado: FiltroDaFila, pagina: number, ativa: boolean) {
  return useQuery({
    queryKey: [...CHAVE, "fila", estado, pagina],
    queryFn: async () =>
      lerJson<Pagina<EnvioDaTela>>(await fetch(`${BASE}/fila?estado=${estado}&pagina=${pagina}`), "Não foi possível ler a fila."),
    enabled: ativa,
    refetchInterval: ativa ? A_CADA : false,
    placeholderData: (anterior) => anterior,
  });
}

export function useChipsDoMotor(ativa = true) {
  return useQuery({
    queryKey: [...CHAVE, "chips"],
    queryFn: async () => lerJson<{ itens: ChipDaTela[] }>(await fetch(`${BASE}/chips`), "Não foi possível ler os chips."),
    enabled: ativa,
    refetchInterval: ativa ? A_CADA : false,
  });
}

export function useConversasDoMotor(filtro: "todas" | "operador" | "quentes", pagina: number, ativa: boolean) {
  return useQuery({
    queryKey: [...CHAVE, "conversas", filtro, pagina],
    queryFn: async () =>
      lerJson<Pagina<ConversaDaTela>>(await fetch(`${BASE}/conversas?filtro=${filtro}&pagina=${pagina}`), "Não foi possível ler as conversas."),
    enabled: ativa,
    refetchInterval: ativa ? A_CADA : false,
    placeholderData: (anterior) => anterior,
  });
}

export function useAjusteDoMotor() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (edicao: EdicaoDaConfig) => lerJson<{ atualizado: string[] }>(await enviar("PATCH", "/config", edicao), "Não foi possível salvar o ajuste."),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: CHAVE }),
  });
}

/** O que a tela edita (`GET /config`): ritmo vigente, perfil, cadência, etapa, mensagens, modo e as etapas. */
export function useConfigDoMotor() {
  return useQuery({
    queryKey: [...CHAVE, "config"],
    queryFn: async () => lerJson<ConfigDaTela>(await fetch(`${BASE}/config`), "Não foi possível ler a configuração do motor."),
    staleTime: 10_000,
  });
}

export function useCriarMotor() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => lerJson<{ criada: boolean }>(await enviar("POST", "/config"), "Não foi possível criar o motor."),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: CHAVE }),
  });
}

/** O dia de hoje simulado; com `perfil`, a prévia daquele perfil sem salvar. */
export function useSimulacaoDoDia(perfil: string | null, habilitada = true) {
  return useQuery({
    queryKey: [...CHAVE, "simulacao", perfil ?? "atual"],
    queryFn: async () =>
      lerJson<SimulacaoDaTela>(await fetch(`${BASE}/simulacao${perfil ? `?perfil=${perfil}` : ""}`), "Não foi possível simular o dia."),
    enabled: habilitada,
    staleTime: 60_000,
    placeholderData: (anterior) => anterior,
  });
}

export function useRegistrarChip() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (channelSessionId: string) =>
      lerJson<{ chip_id: string }>(await enviar("POST", "/chips", { channel_session_id: channelSessionId }), "Não foi possível registrar o chip."),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: CHAVE }),
  });
}

export function useAcaoNoChip() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, acao }: { id: string; acao: "pausar" | "retomar" | "retirar" }) =>
      acao === "retirar"
        ? lerJson<{ chip_id: string; cancelados: number }>(await enviar("DELETE", `/chips/${id}`), "Não foi possível tirar o chip do motor.")
        : lerJson<{ chip_id: string; aviso: string | null }>(await enviar("PATCH", `/chips/${id}`, { acao }), "Não foi possível mudar o chip."),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: CHAVE }),
  });
}

/** Um item da biblioteca de mídia (`GET /api/v1/media-library`), para escolher a imagem da abertura. */
export type MidiaDaBiblioteca = { id: string; name: string; kind: string; mime: string; size_bytes: number };

export function useBibliotecaDeMidia(habilitada: boolean) {
  return useQuery({
    queryKey: ["media-library", "disparo"],
    queryFn: async () => lerJson<MidiaDaBiblioteca[]>(await fetch("/api/v1/media-library"), "Não foi possível ler a biblioteca de mídia."),
    enabled: habilitada,
    staleTime: 60_000,
  });
}
