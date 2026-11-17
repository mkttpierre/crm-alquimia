"use client";

import { useAuth } from "@/hooks/auth/AuthProvider";
import { ROLE_RANK } from "@/lib/auth/types";

import { ProdutosDoNegocio } from "./ProdutosDoNegocio";

/**
 * Liga a aba "Produtos" ao papel de quem está logado: agent+ edita (a API e a RLS exigem o mesmo), viewer só lê, e o
 * modo suporte somente-leitura nunca escreve. Só monta quando a aba abre, então o dossiê não depende do provider de
 * autenticação para aparecer.
 */
export function AbaProdutosDoNegocio({ leadId }: { leadId: string }) {
  const { user, activeOrg } = useAuth();
  const podeEditar =
    !!activeOrg && ROLE_RANK[activeOrg.role] >= ROLE_RANK.agent && user.support?.access_mode !== "support_readonly";
  return <ProdutosDoNegocio leadId={leadId} podeEditar={podeEditar} />;
}
