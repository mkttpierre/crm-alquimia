"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { ROLE_RANK } from "@/lib/auth/types";

import { RegistrarVendaDialog } from "./RegistrarVendaDialog";

interface Props {
  contactId?: string | null;
  leadId?: string | null;
  nomeDoContato?: string | null;
  variant?: React.ComponentProps<typeof Button>["variant"];
  size?: React.ComponentProps<typeof Button>["size"];
  className?: string;
}

/**
 * O botão "Registrar venda", o mesmo nos três lugares (linha de /app/leads, página do contato, dossiê do negócio).
 * Só aparece para quem pode escrever: papel agent+ e fora do modo suporte somente-leitura (a API e a RLS exigem o mesmo).
 */
export function BotaoRegistrarVenda({ contactId, leadId, nomeDoContato, variant = "outline", size = "sm", className }: Props) {
  const t = useT();
  const { user, activeOrg } = useAuth();
  const [aberto, setAberto] = React.useState(false);

  const podeRegistrar = !!activeOrg && ROLE_RANK[activeOrg.role] >= ROLE_RANK.agent && user.support?.access_mode !== "support_readonly";
  if (!podeRegistrar || (!contactId && !leadId)) return null;

  return (
    <>
      <Button type="button" variant={variant} size={size} className={className} onClick={() => setAberto(true)}>
        {t("Registrar venda")}
      </Button>
      {aberto && <RegistrarVendaDialog open={aberto} onOpenChange={setAberto} contactId={contactId} leadId={leadId} nomeDoContato={nomeDoContato} />}
    </>
  );
}
