/**
 * A organização tem o agente de resposta EXTERNO ao upstream?
 *
 * `organizations.settings.ai_dispatch_mode = 'external'` diz que o dono da
 * resposta é outro runtime (no nosso caso, o atendimento do motor de disparo,
 * `lib/disparo/atendimento`). O `drain` e o dispatcher já respeitam isso. Esta
 * função existe para o OUTRO lado do upstream que também age sobre a conversa
 * sem passar por agente nenhum: o handoff por sentimento
 * (`workers/ai-sentiment-worker.ts` → `ai.sentiment_alert` →
 * `workers/ai-handoff-from-sentiment.handler.ts` → `triggerHandoff`).
 *
 * Medido no código antes de existir: com `OPENROUTER_API_KEY` na máquina o
 * worker de sentimento roda mesmo sem agente publicado; nota baixa emite
 * `ai.sentiment_alert`, e o handler silencia a conversa para sempre
 * (`bot_silenced_until='infinity'`) e chama `avisarLeadDoCrm`, que manda um TEXTO
 * REAL à lead — fora da trava `DISPARO_REAL_LIBERADO`. Em organização com agente
 * externo, nenhuma das duas coisas é desejada: quem silencia e quem fala é o
 * atendimento próprio, atrás da trava dele.
 *
 * Fail-closed: erro de leitura conta como "externo" (os chamadores PULAM). Pular
 * o sentimento não custa nada; deixá-lo agir sem saber o dono da conversa custa
 * uma mensagem que não volta.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { aiDispatchModeSchema } from "@/lib/schemas/settings";

export async function orgTemAgenteExterno(admin: SupabaseClient, organizationId: string): Promise<boolean> {
  const { data, error } = await admin.from("organizations").select("settings").eq("id", organizationId).maybeSingle();
  if (error) return true;
  const settings = (data as { settings?: Record<string, unknown> | null } | null)?.settings ?? null;
  return aiDispatchModeSchema.parse(settings?.["ai_dispatch_mode"]) === "external";
}
