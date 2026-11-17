"use client";

/**
 * Definir (ou apagar) a meta mensal — só o admin chega aqui (a página decide, e a Server Action e o banco conferem de novo).
 * O texto digitado ("10.000,50") vira centavos por `lerValorEmCents`, a mesma regra que a tela usa para avisar antes de enviar.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { definirMetaMensal } from "@/app/actions/inicio/definirMetaMensal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import { lerValorEmCents } from "@/lib/negocio/meta-mensal";

const ERRO_EM_PORTUGUES: Record<string, string> = {
  validation_failed: "Valor fora do permitido. Use um número maior que zero.",
  unauthenticated: "Sua sessão expirou. Entre de novo para salvar.",
  forbidden_tenant: "Não consegui identificar sua empresa. Recarregue a página.",
  forbidden_role: "Só quem administra esta empresa pode definir a meta.",
  mfa_required: "Confirme o código do seu aplicativo de duas etapas e tente de novo.",
  nao_gravou: "A alteração não chegou ao banco — nada foi mudado. Tente de novo.",
};

export function MetaDoMesForm({ metaAtualTexto, moeda, temMeta }: { metaAtualTexto: string; moeda: string; temMeta: boolean }) {
  const t = useT();
  const router = useRouter();
  const [valor, setValor] = useState(metaAtualTexto);
  const [erro, setErro] = useState<string | null>(null);
  const [pendente, comecar] = useTransition();

  function gravar(texto: string) {
    const lido = lerValorEmCents(texto);
    if (!lido.ok) {
      setErro("Digite só números, por exemplo 50000 ou 50.000,00.");
      return;
    }
    setErro(null);
    comecar(async () => {
      const r = await definirMetaMensal({ metaCents: lido.cents });
      if (r.ok) {
        toast.success(t(lido.cents === null ? "A meta foi apagada." : "Meta salva."));
        if (lido.cents === null) setValor("");
        router.refresh();
        return;
      }
      setErro(ERRO_EM_PORTUGUES[r.error] ?? "Não foi possível salvar. Tente de novo.");
    });
  }

  return (
    <form
      className="mt-3 flex flex-col gap-2 min-[521px]:flex-row min-[521px]:items-end"
      onSubmit={(e) => {
        e.preventDefault();
        gravar(valor);
      }}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <Label htmlFor="meta-do-mes">{`${t("Meta do mês")} (${moeda})`}</Label>
        <Input
          id="meta-do-mes"
          inputMode="decimal"
          autoComplete="off"
          value={valor}
          onChange={(e) => setValor(e.target.value)}
          placeholder="50.000,00"
          aria-invalid={erro ? true : undefined}
          aria-describedby={erro ? "meta-do-mes-erro" : undefined}
        />
      </div>
      <div className="flex gap-2">
        <Button type="submit" disabled={pendente}>
          {t("Salvar meta")}
        </Button>
        {temMeta && (
          <Button type="button" variant="outline" disabled={pendente} onClick={() => gravar("")}>
            {t("Apagar meta")}
          </Button>
        )}
      </div>
      {erro && (
        <p id="meta-do-mes-erro" role="alert" className="text-[12px] text-error-fg min-[521px]:basis-full">
          {t(erro)}
        </p>
      )}
    </form>
  );
}
