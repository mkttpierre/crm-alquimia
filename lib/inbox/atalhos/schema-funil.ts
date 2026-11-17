import { z } from "zod";

/** Limites que o banco também confere (migration 0248). */
export const ATRASO_MAX_MS = 600_000;
export const PRESENCA_MAX_MS = 25_000;

export const passoSchema = z.object({
  template_id: z.string().uuid(),
  atraso_ms: z.number().int().min(0).max(ATRASO_MAX_MS),
  presenca: z.enum(["nenhuma", "digitando", "gravando"]),
  presenca_ms: z.number().int().min(0).max(PRESENCA_MAX_MS),
});

export const funilSchema = z.object({
  nome: z.string().trim().min(1).max(80),
  atalho: z.string().regex(/^[a-z0-9-]{2,40}$/, "use só letras minúsculas, números e hífen"),
  palavras_chave: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  favorito: z.boolean().default(false),
  /** true = da organização inteira (exige manager+); false = só do operador. */
  compartilhado: z.boolean().default(true),
  passos: z.array(passoSchema).min(1).max(30),
});
export type FunilInput = z.infer<typeof funilSchema>;

export const duracaoDoFunilMs = (passos: { atraso_ms: number }[]) => passos.slice(1).reduce((s, p) => s + p.atraso_ms, 0);
