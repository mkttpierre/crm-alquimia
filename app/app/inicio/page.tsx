import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { carregarResumoDoInicio } from "@/lib/inicio/resumo";
import { canSee } from "@/lib/navigation/interface";
import { createClient } from "@/lib/supabase/server";
import { nomesDosAtendentes } from "@/lib/users/nome-do-atendente";

import { AtividadeRecente } from "./_components/AtividadeRecente";
import { CardDeFunis } from "./_components/CardDeFunis";
import { GraficoDeConversas } from "./_components/GraficoDeConversas";
import { NumerosDoDia } from "./_components/NumerosDoDia";

export const dynamic = "force-dynamic";

/**
 * Início — a tela de entrada do app (protótipo A aprovado).
 *
 * O título ("Olá, <primeiro nome>") mora no topo da casca (`components/app/
 * Topo.tsx`), como no protótipo; aqui fica só um `<h1>` para leitor de tela.
 *
 * Client do USUÁRIO, não o admin: os números respeitam a RLS de quem olha, e
 * `carregarResumoDoInicio` ainda filtra `organization_id` em toda consulta (a
 * policy de `crm_pipelines` sozinha não isola — ver `app/app/kanban/page.tsx`).
 * O admin client entra só para o NOME de quem fez cada atividade
 * (`nomesDosAtendentes`, que expõe apenas `full_name`).
 */
export default async function InicioPage() {
  const user = await requireAuth();
  const org = await resolveActiveOrg(user);
  if (!org) redirect("/app/settings/profile");
  const idioma = user.idioma;
  const t = (texto: string) => traduzir(texto, idioma);

  const agora = new Date();
  const db = await createClient();
  // Os números do motor seguem a régua da tela Disparo (`manager+`, no catálogo):
  // quem não abre o motor não vê o que ele enviou nem a taxa dele.
  const incluirMotor = canSee(
    { href: "/app/disparo", minRole: "manager" },
    user.is_platform_admin && !user.support,
    org.role,
  );
  const resumo = await carregarResumoDoInicio(db, org.orgId, {
    agora,
    incluirMotor,
    nomesDeUsuarios: nomesDosAtendentes,
  });

  return (
    <div className="mx-auto flex w-full max-w-[1240px] flex-col gap-5">
      <h1 className="sr-only">{t("Início")}</h1>
      <NumerosDoDia resumo={resumo} idioma={idioma} />
      <GraficoDeConversas semanas={resumo.semanas} idioma={idioma} />
      <div className="grid gap-5 min-[861px]:grid-cols-2">
        <CardDeFunis funis={resumo.funis} idioma={idioma} />
        <AtividadeRecente atividades={resumo.atividades} agora={agora} idioma={idioma} />
      </div>
    </div>
  );
}
