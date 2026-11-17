import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";

import { AgentesClient } from "./_components/AgentesClient";

export const dynamic = "force-dynamic";

/**
 * Equipe › Agentes externos: OpenBot, Claude Code, Codex e afins entram na equipe pelo MCP.
 *
 * Só admin: criar um agente cria uma CHAVE de acesso ao CRM inteiro (o papel padrão é Administrador), o mesmo critério
 * de `/app/settings/api-tokens`. Quem atende vê os agentes na barra "Equipe agora", sem passar por aqui.
 */
export default async function AgentesExternosPage() {
  const user = await requireAuth();
  const org = await resolveActiveOrg(user);
  if (!org || ROLE_RANK[org.role] < ROLE_RANK.admin) redirect("/403");
  const t = (texto: string) => traduzir(texto, user.idioma);

  return (
    <div className="mx-auto flex w-full max-w-[1240px] flex-col gap-5">
      <header className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">{t("Agentes externos")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("Agentes de IA de fora (OpenBot, Claude Code, Codex) trabalhando no CRM como membros da equipe.")}
        </p>
      </header>
      <AgentesClient />
    </div>
  );
}
