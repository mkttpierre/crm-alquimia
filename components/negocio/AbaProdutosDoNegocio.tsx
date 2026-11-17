"use client";

import { useAuth } from "@/hooks/auth/AuthProvider";
import { ROLE_RANK } from "@/lib/auth/types";

import { ProdutosDoLead } from "./ProdutosDoLead";
import { ProdutosDoNegocio } from "./ProdutosDoNegocio";

/**
 * Liga a aba "Produtos" ao papel de quem está logado: agent+ edita (a API e a RLS exigem o mesmo), viewer só lê, e o
 * modo suporte somente-leitura nunca escreve. Só monta quando a aba abre, então o dossiê não depende do provider de
 * autenticação para aparecer.
 */
export function AbaProdutosDoNegocio({ leadId, aoMudar, compacto = false }: { leadId: string; aoMudar?: () => void; compacto?: boolean }) {
  const { user, activeOrg } = useAuth();
  const podeEditar =
    !!activeOrg && ROLE_RANK[activeOrg.role] >= ROLE_RANK.agent && user.support?.access_mode !== "support_readonly";
  if (compacto) return <ProdutosDoLead leadId={leadId} podeEditar={podeEditar} aoMudar={aoMudar} />;
  return <ProdutosDoNegocio leadId={leadId} podeEditar={podeEditar} aoMudar={aoMudar} />;
}
