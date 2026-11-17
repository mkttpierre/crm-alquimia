/**
 * O passo "Conectar WhatsApp" do wizard quando o servidor de QR é a Evolution (não há WAHA).
 *
 * Irmão de `onboarding-session.ts` (que só conhece a sessão do WAHA). A conexão nasce de
 * `connectEvolutionChannel({ onboarding: true })`; aqui ela é reencontrada, o estado dela é lido ao
 * vivo e o QR é pedido. Funções finas sobre `evolution/client.ts`: nada de regra de negócio.
 *
 * O vocabulário que o wizard entende é o do WAHA: `WORKING` (conectado) ou `SCAN_QR_CODE` (mostre o
 * código). Na Evolution o QR é pedido sob demanda e gira sozinho, então qualquer estado que não seja
 * `open` vale como "mostre o código".
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { conectarInstancia, estadoDaInstancia } from "./evolution/client";
import { resolveEvolutionCreds } from "./evolution/credentials";
import { statusDoEstado } from "./evolution/webhook";

export interface CanalDoOnboardingEvolution {
  id: string;
  evolution_instance_name: string;
  status: string;
}

/** A conexão do wizard desta organização (não arquivada), ou `null`. Lança se a consulta falhar. */
export async function carregarCanalDoOnboardingEvolution(
  db: SupabaseClient,
  organizationId: string,
): Promise<CanalDoOnboardingEvolution | null> {
  const { data, error } = await db
    .from("channel_sessions")
    .select("id, evolution_instance_name, status")
    .eq("organization_id", organizationId)
    .eq("provider", "evolution")
    .eq("metadata->>onboarding", "true")
    .is("archived_at", null)
    .order("created_at")
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as CanalDoOnboardingEvolution | null) ?? null;
}

/** `WORKING` se a instância está aberta; `SCAN_QR_CODE` em qualquer outro caso. Grava a mudança para WORKING. */
export async function statusDoOnboardingEvolution(
  admin: SupabaseClient,
  db: SupabaseClient,
  organizationId: string,
  canal: CanalDoOnboardingEvolution,
): Promise<"WORKING" | "SCAN_QR_CODE"> {
  const creds = await resolveEvolutionCreds(admin, { organizationId, instance: canal.evolution_instance_name });
  if (!creds) throw new Error("evolution_not_configured");
  const vivo = statusDoEstado(await estadoDaInstancia(creds)) === "WORKING" ? "WORKING" : "SCAN_QR_CODE";
  if (vivo === "WORKING" && canal.status !== "WORKING") {
    const agora = new Date().toISOString();
    const { error } = await db
      .from("channel_sessions")
      .update({ status: "WORKING", last_status_change_at: agora, last_health_check_at: agora })
      .eq("organization_id", organizationId)
      .eq("id", canal.id);
    if (error) throw new Error("connection_sync_failed");
  }
  return vivo;
}

/** Os bytes do PNG do QR atual, ou `null` se a Evolution ainda não o devolveu. */
export async function qrDoOnboardingEvolution(
  admin: SupabaseClient,
  organizationId: string,
  canal: CanalDoOnboardingEvolution,
): Promise<Uint8Array | null> {
  const creds = await resolveEvolutionCreds(admin, { organizationId, instance: canal.evolution_instance_name });
  if (!creds) throw new Error("evolution_not_configured");
  const qr = await conectarInstancia(creds);
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(qr.base64 ?? "");
  return match?.[1] ? Uint8Array.from(Buffer.from(match[1], "base64")) : null;
}
