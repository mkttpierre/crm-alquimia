"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";

import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import {
  VALIDADE_DO_COOKIE_DO_PAINEL_S,
  ehPainelDoInicio,
  nomeDoCookieDoPainel,
  podeVerPainelDeVendas,
} from "@/lib/inicio/painel";
import { cookieSecure } from "@/lib/supabase/cookie-secure";

/**
 * Lembra o painel que a pessoa escolheu no Início ("Atendimento e envios" ou "Vendas e faturamento").
 *
 * É a ação do `<form>` do seletor, então recebe `FormData` (campo `painel`) e não devolve nada: valor desconhecido, sessão
 * ausente ou "vendas" sem o papel `manager`+ são ignorados em silêncio — o Início já desenha o painel certo para o papel, e
 * não há mensagem útil para quem forjou o campo. A escolha vai num cookie com o id da PESSOA no nome (ver `lib/inicio/painel.ts`).
 *
 * Não grava nada no banco e não muda dado da empresa: é preferência de tela.
 */
export async function escolherPainelDoInicio(formData: FormData): Promise<void> {
  const painel = formData.get("painel");
  if (!ehPainelDoInicio(painel)) return;

  const user = await loadAuthUser();
  if (!user) return;
  const nome = nomeDoCookieDoPainel(user.id);
  if (!nome) return;

  if (painel === "vendas") {
    const org = await resolveActiveOrg(user);
    if (!org) return;
    if (!podeVerPainelDeVendas({ role: org.role, isPlatformAdmin: user.is_platform_admin, emSuporte: Boolean(user.support) })) return;
  }

  const store = await cookies();
  store.set(nome, painel, {
    httpOnly: true,
    sameSite: "strict",
    secure: cookieSecure(),
    path: "/app",
    maxAge: VALIDADE_DO_COOKIE_DO_PAINEL_S,
  });
  revalidatePath("/app/inicio");
}
