/**
 * O eco `fromMe` que chegou é de um envio do MOTOR DE DISPARO em curso (E7)?
 *
 * O motor chama o canal e só depois grava o espelho em `messages` (`envio-real.ts`). Se o eco do webhook chega antes,
 * a ingestão não acha linha nenhuma em `messages` e concluía "uma pessoa respondeu pelo celular": pausava a IA, e o
 * motor cancelava a fila do lead como "humano no comando". Aqui a prova vem da fila do motor: um envio para um lead
 * DESTE contato, que chamou o canal (`enviando`) ou acabou de sair (`enviado`) dentro da janela, com o MESMO corpo.
 *
 * Mesma direção do `ehEcoDeEnvioNosso` da ingestão: qualquer prova faltando, ou erro de leitura, é "não sei" — e "não
 * sei" pausa (é o desfecho seguro do lado do atendente). Mídia não tem corpo comparável: a prova cai para "envio do
 * motor com mídia em curso", mais fraca e escrita para ninguém supor o contrário. Só leitura; nunca lança.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

/**
 * Até quando, depois da reserva marcada (ou do registro), o eco ainda é explicável pelo envio do motor. A chamada de
 * mídia pode levar até 120 s (`TIMEOUT_MIDIA_MS`); 3 min dá folga ao webhook sem virar álibi para digitação de horas.
 */
export const JANELA_DO_ECO_DO_MOTOR_MS = 3 * 60_000;

export async function ehEcoDoMotor(
  admin: Pick<SupabaseClient, "from">,
  organizationId: string,
  contactId: string,
  eco: { corpo: string; midia: boolean },
  agora = new Date(),
): Promise<boolean> {
  try {
    const { data: leads, error } = await admin.from("crm_leads").select("id").eq("organization_id", organizationId).eq("contact_id", contactId).limit(20);
    if (error || !leads?.length) return false;
    const desde = new Date(agora.getTime() - JANELA_DO_ECO_DO_MOTOR_MS).toISOString();
    const { data: envios, error: e2 } = await admin
      .from("disparo_envios")
      .select("texto, midia_id")
      .eq("organization_id", organizationId)
      .in("lead_id", (leads as { id: string }[]).map((l) => l.id))
      // `enviando` = reservado e (na janela) com a marca de canal; `enviado` = o espelho pode ter falhado.
      .in("estado", ["enviando", "enviado"])
      .gte("updated_at", desde)
      .limit(20);
    if (e2) return false;
    for (const e of (envios ?? []) as { texto: string | null; midia_id: string | null }[]) {
      if (eco.midia) {
        if (e.midia_id) return true;
        continue;
      }
      if (eco.corpo.length > 0 && (e.texto ?? "").trim() === eco.corpo) return true;
    }
    return false;
  } catch (e) {
    logger.warn("disparo.eco_do_motor: checagem falhou (tratado como humano)", { organization_id: organizationId, erro: (e as Error).message.slice(0, 200) });
    return false;
  }
}
