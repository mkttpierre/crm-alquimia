import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/** O card da tela Início: fundo `card`, borda de 1px, raio 12px, 20px de respiro (protótipo A). */
export function Cartao({
  titulo,
  subtitulo,
  className,
  children,
}: {
  titulo?: string;
  subtitulo?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={cn(
        "min-w-0 rounded-[12px] border border-border bg-card p-5 text-card-foreground",
        className,
      )}
    >
      {titulo && <h2 className="text-[15px] leading-tight font-semibold">{titulo}</h2>}
      {subtitulo && <p className="mt-[3px] text-[13px] text-muted-foreground">{subtitulo}</p>}
      {children}
    </section>
  );
}

/** O "o que vai aparecer aqui e como começar" de um card sem dado. */
export function SemDado({ texto, acao }: { texto: string; acao?: ReactNode }) {
  return (
    <div className="mt-4 rounded-[10px] border border-dashed border-border p-4 text-[13px] text-muted-foreground">
      <p>{texto}</p>
      {acao && <div className="mt-2">{acao}</div>}
    </div>
  );
}
