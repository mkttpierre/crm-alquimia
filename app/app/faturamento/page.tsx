/**
 * Análise → Faturamento. Quanto entrou no período: negócios ganhos (e pedidos pagos da loja, EXCETO quando a organização tem
 * produto interno de comissão: aí o total conta só negócios e os pedidos aparecem "fora do total"), por dia/semana/mês, por
 * produto, atendente e funil, com o ticket médio.
 *
 * `manager`+ como Meta Ads, a vizinha no menu: faturamento é número da empresa inteira, sem recorte por atendente. A
 * API (`/api/v1/revenue`) exige o mesmo papel; o redirecionamento daqui só evita mostrar uma tela que daria 403.
 */
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";

import { FaturamentoClient } from "./_components/FaturamentoClient";

export const metadata = { title: "Faturamento" };
export const dynamic = "force-dynamic";

export default async function FaturamentoPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (!(user.is_platform_admin && !user.support) && ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) {
    redirect("/403");
  }
  const t = (texto: string) => traduzir(texto, user.idioma);

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Faturamento")}</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          {t("Quanto entrou no período: vendas, ticket médio, produtos, atendentes e funis.")}
        </p>
      </header>
      <FaturamentoClient />
    </div>
  );
}
