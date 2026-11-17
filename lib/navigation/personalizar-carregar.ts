/**
 * Carrega a personalização da barra (migration 0261) da organização ativa e, quando
 * há pessoa, dela. SÓ servidor (usa o admin client): quem chama é o layout de `/app`
 * — que entrega o resultado à barra pelo `activeOrg` — e a tela de Personalizar.
 *
 * DUAS leituras independentes, em paralelo:
 *
 *  - os NOMES (`organizations.nomes_da_barra`) são da organização e se leem direto
 *    pelo id dela, sem passar pelo vínculo de ninguém. É o que faz o modo suporte
 *    (que não tem vínculo próprio) ver — e não apagar ao salvar — os nomes que o
 *    admin do cliente deu;
 *  - a PREFERÊNCIA (`user_organizations.preferencias_da_barra`) é da pessoa. Sem
 *    `userId` (suporte) não há o que ler.
 *
 * Fonte confiável: o `userId` vem do `loadAuthUser()` e o `orgId` do cookie
 * validado por `resolveActiveOrg()` — nunca de um corpo de requisição. O filtro por
 * `user_id` é o que faz a preferência ser SÓ da pessoa.
 *
 * ⚠️ Cada leitura falha BAIXO e SOZINHA — o contrário de `loadAuthUser()`.
 * Personalizar é apresentação: um banco que ainda não recebeu a migration (ou uma
 * consulta que caiu) deixa essa parte da barra no padrão, em vez de derrubar o app
 * por um enfeite, e o erro de uma não leva a outra junto. Ocultar não é permissão,
 * então não há autorização sendo degradada em silêncio; o erro vai para o log.
 */
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

import {
  PREFERENCIAS_VAZIAS,
  lerNomesDaBarra,
  lerPreferenciasDaBarra,
  type NomesDaBarra,
  type PersonalizacaoDaBarra,
  type PreferenciasDaBarra,
} from "./personalizar";

interface Resposta {
  data: unknown;
  error: { code?: string; message: string } | null;
}

/** Roda uma leitura e devolve `padrao` se ela der erro ou lançar. */
async function ler<T>(
  oQue: string,
  orgId: string,
  consulta: () => PromiseLike<Resposta>,
  extrair: (data: unknown) => T,
  padrao: () => T,
): Promise<T> {
  try {
    const { data, error } = await consulta();
    if (error) {
      logger.warn(`[barra] ${oQue} não carregado(a); fica o padrão`, {
        org_id: orgId,
        code: error.code,
        message: error.message,
      });
      return padrao();
    }
    return extrair(data);
  } catch (err) {
    logger.warn(`[barra] ${oQue} não carregado(a); fica o padrão`, {
      org_id: orgId,
      message: err instanceof Error ? err.message : String(err),
    });
    return padrao();
  }
}

export async function carregarPersonalizacaoDaBarra(
  userId: string | null,
  orgId: string,
): Promise<PersonalizacaoDaBarra> {
  const admin = createAdminClient();

  const [nomes, preferencias] = await Promise.all([
    ler<NomesDaBarra>(
      "nomes",
      orgId,
      () => admin.from("organizations").select("nomes_da_barra").eq("id", orgId).maybeSingle(),
      (data) => lerNomesDaBarra((data as { nomes_da_barra?: unknown } | null)?.nomes_da_barra),
      () => ({}),
    ),
    userId === null
      ? Promise.resolve<PreferenciasDaBarra>({ ...PREFERENCIAS_VAZIAS })
      : ler<PreferenciasDaBarra>(
          "preferência",
          orgId,
          () =>
            admin
              .from("user_organizations")
              .select("preferencias_da_barra")
              .eq("user_id", userId)
              .eq("organization_id", orgId)
              .is("revoked_at", null)
              .maybeSingle(),
          (data) =>
            lerPreferenciasDaBarra(
              (data as { preferencias_da_barra?: unknown } | null)?.preferencias_da_barra,
            ),
          () => ({ ocultos: [], ordem: [] }),
        ),
  ]);

  return { preferencias, nomes };
}
