import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";

import { DisparoClient } from "./_components/DisparoClient";

export const dynamic = "force-dynamic";

/**
 * DISPARO — o motor de disparo, configurável pela tela.
 *
 * O motor (`lib/disparo/`, cron `/api/v1/cron/disparo`) calcula quem recebe qual mensagem, por qual
 * chip e quando. Até esta tela, a fila só se via por SQL. Aqui o operador abre o CRM e vê o motor
 * andar: modo (em destaque), a trava dupla explicada, janela e ritmo, a fila, os chips e as
 * conversas de quem respondeu.
 *
 * ─── Quem pode o quê ───────────────────────────────────────────────────────
 *
 * `manager`+ VÊ e edita o motor inteiro (a porta na navegação também pede `manager`): ritmo, perfis, chips,
 * etapa, mensagens e cadência são decisão de gestão, e as rotas cobram `manager` de novo. Trocar o modo para o
 * envio real é só do `admin`, pede a frase "ENVIAR DE VERDADE" e continua exigindo `DISPARO_REAL_LIBERADO=sim`
 * no servidor (a segunda chave, que nenhuma tela toca).
 */
export default async function DisparoPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (!(user.is_platform_admin && !user.support) && ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) {
    redirect("/403");
  }

  const plataforma = user.is_platform_admin && !user.support;
  const podeEditar = plataforma || ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager;
  // Trocar o modo (simulado ↔ real) é do admin; a rota cobra de novo (`papelNecessario`).
  const podeTrocarModo = plataforma || ROLE_RANK[activeOrg.role] >= ROLE_RANK.admin;

  return <DisparoClient podeEditar={podeEditar} podeTrocarModo={podeTrocarModo} />;
}
