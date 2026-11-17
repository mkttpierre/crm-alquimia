import type { SupabaseClient } from "@supabase/supabase-js";

import type { FonteDeGasto } from "./fonte";
import { criarFonteGoogleAds } from "./google";
import { criarFonteMetaAds } from "./meta";

export * from "./fonte";

/** Todas as fontes conhecidas, na ordem em que o painel as lista. Plataforma nova entra aqui, e só aqui. */
export function fontesDeGasto(admin: SupabaseClient): FonteDeGasto[] {
  return [criarFonteMetaAds(admin), criarFonteGoogleAds()];
}
