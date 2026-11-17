/**
 * Conectar um NOVO número pela Evolution API (WhatsApp por QR) — o caminho da instalação local de
 * um comando, que não sobe WAHA.
 *
 * Fluxo: o clique em "Conectar novo WhatsApp" chega aqui, a instância é criada no servidor Evolution
 * (`criarInstancia`) e a linha de `channel_sessions` nasce `STARTING`. O QR é pedido depois pela rota
 * `channel-sessions/[id]/qr` (que já sabia falar com a Evolution); as mensagens voltam pelo webhook
 * GLOBAL (`app/api/v1/webhooks/channel/[token]`), que acha a conexão por `evolution_instance_name`.
 *
 * ─── Idempotência ───────────────────────────────────────────────────────────
 * O nome da instância deriva da organização e do `Idempotency-Key`: o mesmo clique reenviado dá o mesmo
 * nome, e o `criarInstancia` trata "nome em uso" como sucesso. Duas conexões distintas têm chaves
 * distintas e portanto nomes distintos (o índice único é `(evolution_base_url, evolution_instance_name)`).
 *
 * ─── O que NÃO grava ────────────────────────────────────────────────────────
 * `evolution_base_url` e `evolution_token_encrypted` ficam NULOS de propósito: servidor único da
 * instalação, cujas credenciais vêm do ambiente (`credentials.ts` cai em `EVOLUTION_API_BASE_URL` e
 * `EVOLUTION_API_KEY`). A chave do servidor nunca é copiada para o banco.
 */
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import { metadataInicialDoCanal } from "@/lib/ai/elegibilidade/pre-go-live";

import { ChannelConnectionError } from "./connect-waha";
import { criarInstancia } from "./evolution/client";
import { evolutionBaseUrlFromEnv } from "./evolution/credentials";

/** As colunas que a lista de conexões devolve (`CHANNEL_COLUMNS` da rota). */
const COLUNAS =
  "id, provider, waha_session_name, display_name, phone_number, status, status_reason, last_health_check_at, last_status_change_at, daily_message_limit, is_warmup_complete, created_at";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ConnectEvolutionInput {
  organizationId: string;
  idempotencyKey: string;
  userId: string;
  requestId: string;
  displayName?: string;
  /**
   * Passo "Conectar WhatsApp" do wizard: UMA conexão por organização (nome da instância fixo, sem depender do
   * `Idempotency-Key`), marcada em `metadata.onboarding` para as rotas do wizard a acharem de novo.
   */
  onboarding?: boolean;
}

export interface CanalConectado {
  id: string;
  provider: string;
  status: string;
  [coluna: string]: unknown;
}

/** O servidor Evolution desta instalação está apontado (endereço E chave)? */
export function servidorDeQrConfigurado(): boolean {
  return Boolean(evolutionBaseUrlFromEnv() && (process.env.EVOLUTION_API_KEY || "").trim());
}

/** `crm_<8 do id da organização>_<12 do hash da chave>`: só [a-z0-9_], estável por clique. */
export function nomeDaInstancia(organizationId: string, idempotencyKey: string): string {
  const org = organizationId.replace(/-/g, "").slice(0, 8).toLowerCase();
  const chave = createHash("sha256").update(idempotencyKey.trim().toLowerCase()).digest("hex").slice(0, 12);
  return `crm_${org}_${chave}`;
}

/** O nome da instância do passo do wizard: um só por organização. */
export function nomeDaInstanciaDoOnboarding(organizationId: string): string {
  return `crm_${organizationId.replace(/-/g, "").slice(0, 8).toLowerCase()}_onboarding`;
}

export async function connectEvolutionChannel(
  admin: SupabaseClient,
  input: ConnectEvolutionInput,
): Promise<{ channel: CanalConectado; replay: boolean }> {
  if (!input.onboarding && !UUID.test(input.idempotencyKey)) {
    throw new ChannelConnectionError("idempotency_key_required", 422);
  }

  const baseUrl = evolutionBaseUrlFromEnv();
  const apiKey = (process.env.EVOLUTION_API_KEY || "").trim();
  if (!baseUrl || !apiKey) throw new ChannelConnectionError("evolution_not_configured", 503);

  const instancia = input.onboarding
    ? nomeDaInstanciaDoOnboarding(input.organizationId)
    : nomeDaInstancia(input.organizationId, input.idempotencyKey);

  const buscar = () =>
    admin
      .from("channel_sessions")
      .select(COLUNAS)
      .eq("organization_id", input.organizationId)
      .eq("provider", "evolution")
      .eq("evolution_instance_name", instancia)
      .is("archived_at", null)
      .maybeSingle();

  const existente = await buscar();
  if (existente.data) return { channel: existente.data as unknown as CanalConectado, replay: true };

  try {
    await criarInstancia({ baseUrl, apiKey }, instancia);
  } catch {
    // Sem o corpo do servidor: pode carregar detalhe que a tela não deve mostrar.
    throw new ChannelConnectionError("connection_repair_required", 502, { operation: "create_instance" });
  }

  const inserido = await admin
    .from("channel_sessions")
    .insert({
      organization_id: input.organizationId,
      provider: "evolution",
      evolution_instance_name: instancia,
      display_name: input.displayName ?? null,
      status: "STARTING",
      // Coluna NOT NULL herdada do canal por webhook assinado. A Evolution não assina; o valor é só o
      // marcador "sem segredo" (o mesmo que a conexão por WAHA grava).
      webhook_secret_encrypted: "\\x00",
      created_by: input.userId,
      metadata: input.onboarding ? { ...metadataInicialDoCanal(), onboarding: true } : metadataInicialDoCanal(),
    })
    .select(COLUNAS)
    .single();

  if (inserido.error || !inserido.data) {
    // 23505: outro pedido com a mesma chave ganhou a corrida — devolve a linha dele.
    if (inserido.error?.code === "23505") {
      const outra = await buscar();
      if (outra.data) return { channel: outra.data as unknown as CanalConectado, replay: true };
    }
    throw new ChannelConnectionError("connection_checkpoint_failed", 503);
  }

  const canal = inserido.data as unknown as CanalConectado;
  void audit({
    action: "channel.connected",
    actorUserId: input.userId,
    organizationId: input.organizationId,
    resourceType: "channel_session",
    resourceId: canal.id,
    requestId: input.requestId,
    metadata: { provider: "evolution", origin: input.onboarding ? "onboarding" : "connections" },
  });
  return { channel: canal, replay: false };
}
