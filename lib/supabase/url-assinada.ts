import { env } from "@/lib/env";

import { urlAssinadaParaONavegador } from "./url-do-servidor";

/** `urlAssinadaParaONavegador` com o ambiente da instalação. Use em TODA URL assinada devolvida ao navegador. */
export function urlAssinadaDoNavegador(url: string): string {
  return urlAssinadaParaONavegador(url, env);
}
