/**
 * Validação (Zod) da query das duas rotas de exportação. O que a tela de Contatos e a de Leads mandam é entrada externa
 * como qualquer outra: filtro malformado é 422, nunca uma consulta estranha ao banco.
 *
 * Os campos de Contatos saem do `contactListQuerySchema` (a listagem de `/api/v1/contacts`), com o teto de tamanho que
 * a listagem não tem: a busca vira filtro `ilike` no PostgREST e não há razão para aceitar um termo de megabytes.
 */
import { z } from "zod";

import { contactListQuerySchema } from "@/lib/schemas/contacts";

export const TAMANHO_MAXIMO_DA_BUSCA = 200;
export const TAMANHO_MAXIMO_DA_ETIQUETA = 100;

/** `AAAA-MM-DD` que existe no calendário (2026-13-45 não passa). */
const dataDoDia = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  });

export const consultaDeContatos = contactListQuerySchema.pick({ search: true, tag: true, source: true }).extend({
  search: z.string().max(TAMANHO_MAXIMO_DA_BUSCA).optional(),
  tag: z.string().max(TAMANHO_MAXIMO_DA_ETIQUETA).optional(),
  source: z.string().max(TAMANHO_MAXIMO_DA_ETIQUETA).optional(),
});

export const consultaDeLeads = z.object({
  busca: z.string().max(TAMANHO_MAXIMO_DA_BUSCA).optional(),
  tag: z.string().max(TAMANHO_MAXIMO_DA_ETIQUETA).optional(),
  pipeline: z.string().uuid().optional(),
  /** Intervalo da "última compra" do contato, o mesmo filtro `de`/`ate` da tela de Leads. */
  de: dataDoDia.optional(),
  ate: dataDoDia.optional(),
});

/** Parâmetros da URL como objeto; parâmetro vazio (`?tag=`) é parâmetro ausente. */
export function paramsComoObjeto(params: URLSearchParams): Record<string, string> {
  const saida: Record<string, string> = {};
  for (const [chave, valor] of params) if (valor !== "") saida[chave] = valor;
  return saida;
}
