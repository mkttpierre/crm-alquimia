/**
 * O que é "parte seguinte da MESMA sequência" para o laço do motor (`seguirSequencia`, `motor.ts`).
 *
 * Ritmo humano: dentro de uma conversa em andamento, partes seguidas saem 3 s depois de texto ou imagem
 * e 29-34 s depois de áudio, sem esperar o cron seguinte nem o intervalo mínimo do chip. Isso vale só para partes
 * AGENDADAS JUNTAS para o MESMO lead:
 *   - `operador`: a sequência que o operador agendou (`/funil-valores`): todas as pendentes do lead;
 *   - `auto`: a resposta/funil do atendimento (`tabela_valores:seq`, `da_parada`, pix): as partes criadas na mesma
 *     decisão (a mesma janela de `origensPorDecisao`: menos de 10 s entre elas);
 *   - `motor`: as partes `_p2`, `_p3`… da abertura com prévia ou do MESMO toque do kit, da oferta do Método ou do D7/D14.
 * Ficam com o ritmo de sempre: a abertura sem partes, os toques da cadência (`toque_2`, `toque_3`) e os toques do
 * kit entre dias (outro `kit_tN` não é parte deste), que existem justamente para proteger o chip e a quarentena.
 *
 * Puro: o repositório do Supabase e o de memória dos testes usam o MESMO predicado.
 */
import { ehEnvioAgendadoDoKit } from "./kit-followup";
import type { EnvioDaFila } from "./motor";

/**
 * As partes de uma decisão do atendimento entram na fila na mesma chamada (`aplicar`), com `created_at` a
 * milissegundos uma da outra; decisões diferentes vêm de mensagens diferentes do lead. Dez segundos separa as duas
 * coisas com folga.
 */
export const JANELA_DA_DECISAO_MS = 10_000;

const SUFIXO_DE_PARTE = /_p\d+$/;

/** `kit_t1_261023120000_p2` → `kit_t1_261023120000`. */
export const tipoBaseDaParte = (tipo: string): string => tipo.replace(SUFIXO_DE_PARTE, "");

/** Depois de enviar `e`, vale procurar partes seguintes da mesma sequência? */
export function temPartesSeguintes(e: Pick<EnvioDaFila, "origem" | "tipo">): boolean {
  if (e.origem === "operador" || e.origem === "auto") return true;
  if (e.origem === "motor") return e.tipo === "abertura" || SUFIXO_DE_PARTE.test(e.tipo) || ehEnvioAgendadoDoKit(tipoBaseDaParte(e.tipo));
  return false;
}

/** `cand` é uma parte pendente que segue `ref` na mesma sequência (mesmo lead, mesma origem, agendada junto)? */
export function ehParteSeguinte(
  ref: Pick<EnvioDaFila, "id" | "leadId" | "origem" | "tipo" | "criadoEm">,
  cand: Pick<EnvioDaFila, "id" | "leadId" | "origem" | "tipo" | "criadoEm">,
): boolean {
  if (cand.id === ref.id || cand.leadId !== ref.leadId || cand.origem !== ref.origem) return false;
  switch (ref.origem) {
    case "operador":
      return true;
    case "auto":
      return Math.abs(cand.criadoEm.getTime() - ref.criadoEm.getTime()) < JANELA_DA_DECISAO_MS;
    case "motor": {
      const base = tipoBaseDaParte(ref.tipo);
      return cand.tipo.startsWith(base) && SUFIXO_DE_PARTE.test(cand.tipo) && tipoBaseDaParte(cand.tipo) === base;
    }
    default:
      return false;
  }
}
