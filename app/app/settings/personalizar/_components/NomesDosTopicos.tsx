"use client";

/**
 * Configurações › Personalizar › "Nomes dos tópicos" (só admin): o nome que cada
 * linha de topo da barra lateral mostra, para TODOS da organização.
 *
 * Vazio volta ao padrão (o nome de fábrica é o placeholder). No máximo 40
 * caracteres, e os espaços das pontas são cortados — a mesma regra do servidor
 * (`updateNomesDaBarra`) e do banco (0261), repetida aqui só para a tela avisar
 * antes. O nome dado é nome próprio: aparece como foi escrito, sem tradução.
 *
 * Linha que este admin não enxerga (a interface do vínculo dele a tirou) não tem
 * campo, e o nome dela, se existir, é PRESERVADO ao salvar: `preservados` volta
 * junto no envio.
 *
 * O ÚLTIMO A SALVAR VENCE: o formulário manda o mapa inteiro, então dois admins com a
 * tela aberta ao mesmo tempo se sobrescrevem (a aba mais velha apaga o que o outro salvou
 * depois). Decisão registrada: aceitável enquanto os nomes mudam raramente; versionar o
 * mapa só se isso virar queixa.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { updateNomesDaBarra } from "@/app/actions/settings/updateNomesDaBarra";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import { LIMITE_DO_NOME } from "@/lib/navigation/personalizar";

export interface CampoDeNome {
  chave: string;
  /** O nome de fábrica (placeholder e etiqueta do campo). */
  nomePadrao: string;
  /** O que o admin gravou; vazio = usa o padrão. */
  nome: string;
}

const ERRO_EM_PORTUGUES: Record<string, string> = {
  validation_failed: "Algum nome não está no formato esperado (até 40 caracteres).",
  unauthenticated: "Sua sessão expirou. Entre de novo para salvar.",
  forbidden_tenant: "Não consegui identificar sua empresa. Recarregue a página.",
  forbidden_role: "Só quem administra esta empresa pode mudar os nomes.",
  mfa_required: "Confirme o código do seu aplicativo de duas etapas e tente de novo.",
  nao_gravou: "A alteração não chegou ao banco — nada foi mudado. Tente de novo.",
};

export function NomesDosTopicos({
  campos,
  preservados,
}: {
  campos: CampoDeNome[];
  /** Nomes já gravados de linhas que esta tela não lista: voltam no envio, intactos. */
  preservados: Record<string, string>;
}) {
  const t = useT();
  const router = useRouter();
  const [valores, setValores] = useState<Record<string, string>>(() =>
    Object.fromEntries(campos.map((c) => [c.chave, c.nome])),
  );
  const [pendente, startTransition] = useTransition();

  const mudou = campos.some((c) => (valores[c.chave] ?? "").trim() !== c.nome);
  const temNomeSalvo = campos.some((c) => c.nome !== "") || Object.keys(preservados).length > 0;

  function enviar(nomes: Record<string, string> | null, sucesso: string) {
    startTransition(async () => {
      const r = await updateNomesDaBarra(nomes);
      if (r.ok) {
        toast.success(t(sucesso));
        router.refresh();
        return;
      }
      toast.error(t(ERRO_EM_PORTUGUES[r.error] ?? "Não foi possível salvar. Tente de novo."));
    });
  }

  function salvar() {
    const editados = Object.fromEntries(
      campos
        .map((c) => [c.chave, (valores[c.chave] ?? "").trim()] as const)
        .filter(([, n]) => n !== ""),
    );
    enviar({ ...preservados, ...editados }, "Os nomes foram salvos.");
  }

  return (
    <section aria-labelledby="nomes-titulo" className="space-y-4">
      <header>
        <h2 id="nomes-titulo" className="text-lg font-semibold tracking-tight">
          {t("Nomes dos tópicos")}
        </h2>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {t(
            "O nome que cada tópico da barra mostra para todos da empresa. Deixe vazio para usar o padrão.",
          )}
        </p>
      </header>

      <Card className="p-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {campos.map((c) => {
            const id = `nome-do-topico-${c.chave.replace(/[^a-z0-9]+/gi, "-")}`;
            return (
              <div key={c.chave} className="space-y-1.5">
                <Label htmlFor={id}>{t(c.nomePadrao)}</Label>
                <Input
                  id={id}
                  value={valores[c.chave] ?? ""}
                  maxLength={LIMITE_DO_NOME}
                  placeholder={t(c.nomePadrao)}
                  disabled={pendente}
                  onChange={(e) => setValores((v) => ({ ...v, [c.chave]: e.target.value }))}
                />
              </div>
            );
          })}
        </div>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" onClick={salvar} disabled={pendente || !mudou}>
          {pendente ? t("Salvando…") : t("Salvar nomes")}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => enviar(null, "Os nomes voltaram ao padrão.")}
          disabled={pendente || !temNomeSalvo}
        >
          {t("Restaurar nomes")}
        </Button>
      </div>
    </section>
  );
}
