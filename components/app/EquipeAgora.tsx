"use client";

import { useId } from "react";

import { useAuth } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { useAgentesExternos, type AgenteDaLista } from "@/hooks/team/useAgentesExternos";
import { useAttendants, type AttendantAvailability } from "@/hooks/team/useAttendants";
import { ROLE_RANK } from "@/lib/auth/types";
import { Robot } from "@/lib/ui/icons";
import { iniciaisDoUsuario, primeiroNome } from "./MenuDoUsuario";

/**
 * "Equipe agora": quem atende, se está online e quantas conversas abertas tem.
 *
 * A FONTE é a que o multiatendimento já grava e já serve: `GET
 * /api/v1/attendants/availability` (`useAttendants`), o mesmo roster que o
 * painel de Equipe e o roteamento leem — `attendant_availability.is_available`
 * (derrubado pelo cron `attendant-heartbeat` quando a aba some) e a carga de
 * conversas abertas atribuídas. Nenhuma consulta nova, nenhum número próprio.
 *
 * A rota é `agent+`: quem só lê não recebe o roster, e o bloco não aparece
 * (nem é pedido). Sem atendente nenhum, também não aparece — um título sobre
 * uma lista vazia é ruído na barra.
 *
 * Os AGENTES EXTERNOS (OpenBot, Claude Code, Codex) entram na mesma
 * lista, depois das pessoas: online se usaram o CRM nos últimos 5 minutos
 * (`GET /api/v1/team/agentes`, presença gravada pelo MCP), e no lugar da carga
 * de conversas, a última ação (o nome da ferramenta que chamaram).
 */
export function EquipeAgora() {
  const { activeOrg } = useAuth();
  const podeVer = !!activeOrg?.role && ROLE_RANK[activeOrg.role] >= ROLE_RANK.agent;
  if (!podeVer) return null;
  return <ListaDaEquipe />;
}

function ordenar(a: AttendantAvailability, b: AttendantAvailability): number {
  if (a.is_available !== b.is_available) return a.is_available ? -1 : 1;
  return b.current_load - a.current_load;
}

function ListaDaEquipe() {
  const t = useT();
  // Id por instância: a barra aparece duas vezes com a gaveta do celular aberta.
  const tituloId = useId();
  const { data } = useAttendants();
  const { data: externos } = useAgentesExternos();
  const equipe = [...(data?.data ?? [])].sort(ordenar);
  const agentes = [...(externos?.agentes ?? [])]
    .filter((a) => !a.revogado_em)
    .sort((a, b) => Number(b.online) - Number(a.online));
  if (equipe.length === 0 && agentes.length === 0) return null;

  return (
    <section aria-labelledby={tituloId}>
      <h2
        id={tituloId}
        className="px-[10px] pb-1.5 text-[11px] leading-none font-medium tracking-[0.06em] text-lateral-apagado uppercase"
      >
        {t("Equipe agora")}
      </h2>
      <ul className="flex flex-col gap-0.5">
        {equipe.map((a) => {
          const nome = a.name || (a.email ? primeiroNome(null, a.email) : t("Atendente"));
          return (
            <li
              key={a.user_id}
              className="flex items-center gap-2.5 rounded-md px-[10px] py-1.5 text-[13px] text-lateral-item"
            >
              <span
                aria-hidden
                className="relative grid h-[26px] w-[26px] shrink-0 place-items-center rounded-full bg-lateral-avatar text-[10px] font-semibold text-lateral"
              >
                {iniciaisDoUsuario(a.name, a.email ?? "?")}
                <i
                  className={
                    "absolute -right-px -bottom-px h-[9px] w-[9px] rounded-full border-2 border-lateral " +
                    (a.is_available ? "bg-presenca-online" : "bg-presenca-ausente")
                  }
                />
              </span>
              <span className="min-w-0 flex-1 truncate">{primeiroNome(nome, nome)}</span>
              <span className="shrink-0 text-[12px] text-lateral-suave tabular-nums">
                {a.is_available
                  ? `${a.current_load} ${a.current_load === 1 ? t("conversa") : t("conversas")}`
                  : t("ausente")}
              </span>
              <span className="sr-only">{a.is_available ? t("online") : ""}</span>
            </li>
          );
        })}
        {agentes.map((a) => (
          <LinhaDoAgenteExterno key={a.id} agente={a} />
        ))}
      </ul>
    </section>
  );
}

/** Um agente externo na barra: o robô no lugar das iniciais, e a última ação no lugar da carga. */
function LinhaDoAgenteExterno({ agente }: { agente: AgenteDaLista }) {
  const t = useT();
  return (
    <li className="flex items-center gap-2.5 rounded-md px-[10px] py-1.5 text-[13px] text-lateral-item">
      <span
        aria-hidden
        className="relative grid h-[26px] w-[26px] shrink-0 place-items-center rounded-full bg-lateral-avatar text-lateral"
      >
        <Robot size={14} />
        <i
          className={
            "absolute -right-px -bottom-px h-[9px] w-[9px] rounded-full border-2 border-lateral " +
            (agente.online ? "bg-presenca-online" : "bg-presenca-ausente")
          }
        />
      </span>
      <span className="min-w-0 flex-1 truncate">{agente.nome}</span>
      <span className="max-w-[45%] shrink-0 truncate text-[12px] text-lateral-suave" title={agente.ultima_acao ?? undefined}>
        {agente.online ? (agente.ultima_acao ?? t("online")) : t("ausente")}
      </span>
      <span className="sr-only">{`${t("agente externo")}${agente.online ? ` · ${t("online")}` : ""}`}</span>
    </li>
  );
}
