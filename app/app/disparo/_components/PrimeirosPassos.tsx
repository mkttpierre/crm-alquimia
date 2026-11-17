"use client";

import Link from "next/link";

import { useT } from "@/hooks/i18n/useT";
import { CheckCircle } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

export type PassoInicial = { id: string; titulo: string; feito: boolean; destino: string | null };

/**
 * Os passos que faltam para o motor mandar de verdade, na ordem em que se faz. Sem motor criado, as seções da tela
 * ainda não existem: esses passos não são links. Quem não pode trocar o modo vê "peça a um administrador", e o passo
 * conta como feito quando o modo da organização já é real.
 */
export function passosIniciais(estado: {
  conectado: boolean;
  temChip: boolean;
  temEtapa: boolean;
  temAbertura: boolean;
  envioReal: boolean;
  existe?: boolean;
  podeTrocarModo?: boolean;
}): PassoInicial[] {
  const existe = estado.existe ?? true;
  const secao = (ancora: string) => (existe ? ancora : null);
  const podeTrocar = estado.podeTrocarModo ?? true;
  return [
    { id: "conexao", titulo: "Conectar um WhatsApp", feito: estado.conectado, destino: "/app/connections" },
    { id: "chip", titulo: "Usar o chip no motor", feito: estado.temChip, destino: secao("#chips") },
    { id: "etapa", titulo: "Escolher a etapa dos leads", feito: estado.temEtapa, destino: secao("#leads") },
    { id: "abertura", titulo: "Escrever a mensagem de abertura", feito: estado.temAbertura, destino: secao("#mensagens") },
    {
      id: "real",
      titulo: podeTrocar ? "Ligar o envio real" : "Ligar o envio real (peça a um administrador)",
      feito: estado.envioReal,
      destino: secao("#modo"),
    },
  ];
}

/**
 * PRIMEIROS PASSOS — a faixa que leva quem acabou de instalar até o motor mandando. Some quando tudo está feito.
 */
export function PrimeirosPassos({ passos }: { passos: PassoInicial[] }) {
  const t = useT();
  const feitos = passos.filter((p) => p.feito).length;
  if (feitos === passos.length) return null;

  return (
    <section aria-labelledby="titulo-primeiros-passos" className="min-w-0 rounded-[12px] border border-border bg-card p-5 text-card-foreground">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="titulo-primeiros-passos" className="text-[15px] font-semibold">
          {t("Primeiros passos")}
        </h2>
        <span className="text-[12px] text-muted-foreground tabular-nums">
          {feitos} {t("de")} {passos.length}
        </span>
      </div>
      <ol className="mt-3 grid grid-cols-1 gap-2 min-[861px]:grid-cols-5">
        {passos.map((p, i) => (
          <li key={p.id}>
            <ItemDoPasso
              destino={p.destino}
              className={cn(
                "flex h-full min-w-0 items-start gap-2 rounded-[10px] border border-border p-3 text-[13px] transition-colors",
                p.destino && "hover:border-muted-foreground",
                p.feito && "text-muted-foreground",
              )}
            >
              {p.feito ? (
                <CheckCircle size={16} weight="fill" className="mt-px shrink-0" aria-label={t("feito")} />
              ) : (
                <span className="mt-px inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-muted-foreground font-mono text-[10px]">
                  {i + 1}
                </span>
              )}
              <span className={cn(p.feito && "line-through")}>{t(p.titulo)}</span>
            </ItemDoPasso>
          </li>
        ))}
      </ol>
    </section>
  );
}

function ItemDoPasso({ destino, className, children }: { destino: string | null; className: string; children: React.ReactNode }) {
  return destino ? (
    <Link href={destino} className={className}>
      {children}
    </Link>
  ) : (
    <div className={className}>{children}</div>
  );
}
