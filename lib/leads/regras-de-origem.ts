import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

import { lerRegrasDeOrigem, REGRAS_VAZIAS, tagsDeOrigem, type LeadParaOrigem, type RegrasDeOrigem } from "./tag-de-origem";

/**
 * Lê `organizations.settings.origem`. NUNCA lança: falha de leitura é
 * registrada e vira regras vazias, para não impedir a criação do lead.
 */
export async function carregarRegrasDeOrigem(
  db: SupabaseClient,
  organizationId: string,
): Promise<RegrasDeOrigem> {
  try {
    const { data, error } = await db
      .from("organizations")
      .select("settings")
      .eq("id", organizationId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return lerRegrasDeOrigem((data as { settings?: unknown } | null)?.settings);
  } catch (err) {
    logger.error("regras de origem: leitura falhou, lead segue sem tag", {
      organizationId,
      erro: err instanceof Error ? err.message : String(err),
    });
    return { ...REGRAS_VAZIAS };
  }
}

/** Tags existentes + as de origem comprovada (nunca remove). */
export async function tagsComOrigem(
  db: SupabaseClient,
  organizationId: string,
  lead: LeadParaOrigem,
): Promise<string[]> {
  const atuais = lead.tags ?? [];
  const regras = await carregarRegrasDeOrigem(db, organizationId);
  return [...atuais, ...tagsDeOrigem(lead, regras)];
}
