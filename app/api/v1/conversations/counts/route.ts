/**
 * GET /api/v1/conversations/counts — contagens por visão do inbox (G4-02).
 *
 * Usa o client user-scoped (cookie session) → a RPC `fn_contagem_inbox`
 * (SECURITY INVOKER, migration 0244) HERDA a RLS de SELECT de `conversations`
 * (regra de fn_can_view_conversation, migration 0035). Um agent em modo own*
 * recebe a contagem do SEU escopo, NUNCA o total da org — a mesma garantia do
 * listing.
 */
import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { CONVERSATION_TERMINAL_STATUSES } from "@/lib/schemas";
import { orgTemAutomatico } from "@/lib/ai/agents/org-tem-automatico";
import { comandosDaFila } from "@/lib/inbox/comando-da-conversa";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const supabase = await createClient();

  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    return fail("unauthenticated", "Auth required.", 401, { requestId });
  }

  const authUser = await loadAuthUser();
  const activeOrg = authUser ? await resolveActiveOrg(authUser) : null;
  if (!activeOrg) {
    return fail(
      "no_active_org",
      traduzir("No active organization.", authUser?.idioma ?? "pt-BR"),
      403,
      { requestId },
    );
  }

  const org = activeOrg.orgId;

  // Espelha tabToFilter (InboxLayout): fila = o que a aba Fila pede; mine =
  // atribuídas a mim e ainda ABERTAS; all = tudo que o usuário VÊ.
  //
  // O `p_terminais` do `mine` espelha o `exclude_finished` da aba, e o
  // espelhamento é o ponto: um badge que conta o que a aba não mostra é pior
  // que badge nenhum — manda o atendente procurar um trabalho que não existe.
  // O fato ORG-WIDE resolvido ANTES das contagens, porque ele escolhe QUAL
  // conjunto de comandos a Fila pede. `undefined` (não deu para saber) segue a
  // convenção da regra: assume que há automático.
  const automaticoDaOrg = await orgTemAutomatico(supabase, org);

  // UMA consulta para os quatro números (migration 0244). Eram quatro
  // `count=exact`, duas filtrando o campo calculado `comando_da_conversa` — cada
  // uma varria a org e refazia a RLS linha a linha (~1,3 s cada numa organização).
  // `fn_contagem_inbox` é SECURITY INVOKER: herda a RLS de SELECT de quem
  // pergunta, então um agent em modo own* continua contando só o SEU escopo.
  //
  // A FILA DEIXOU DE SER "sem dono + status de espera": conta o mesmo predicado
  // que a aba pede (`comandosDaFila`). Medido na VPS em 2026-08-30, o par antigo
  // dizia 83 enquanto 47 daquelas conversas tinham o automático no comando.
  const { data, error } = await supabase.rpc("fn_contagem_inbox", {
    p_org: org,
    p_comandos_fila: comandosDaFila(automaticoDaOrg),
    p_terminais: [...CONVERSATION_TERMINAL_STATUSES],
  });
  if (error) {
    return fail("internal_error", error.message, 500, { requestId });
  }
  const linha = (Array.isArray(data) ? data[0] : data) as
    | { fila: number | null; automatico: number | null; mine: number | null; total: number | null }
    | undefined;
  const fila = Number(linha?.fila ?? 0);

  return ok(
    {
      fila,
      automatico: Number(linha?.automatico ?? 0),
      // `unassigned` continua respondendo, com o MESMO valor de `fila`. É rota
      // `/api/v1/` versionada: campo não some de uma versão para outra, e um
      // cliente com a página aberta desde antes do deploy segue lendo o nome
      // velho até recarregar.
      unassigned: fila,
      mine: Number(linha?.mine ?? 0),
      all: Number(linha?.total ?? 0),
    },
    { requestId },
  );
}
