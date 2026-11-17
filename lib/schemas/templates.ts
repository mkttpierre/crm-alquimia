import { z } from "zod";

export const createTemplateSchema = z.object({
  title: z.string().trim().min(1).max(80),
  /** Pode ficar vazio quando há anexo: o áudio (ou a imagem) É a mensagem. */
  body: z.string().trim().max(4096).default(""),
  shortcut: z.string().trim().min(1).max(40).optional(),
  /** true = compartilhado da org (owner null, exige manager+); false = pessoal. */
  shared: z.boolean().default(false),
  /** Estrela da barra de atalhos do chat (aparece primeiro). */
  favorito: z.boolean().optional(),
  /** Palavras que a barra do chat também casa ("valores", "preço"). */
  palavras_chave: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  /** Anexo da biblioteca de mídia (FK composta garante a mesma org). null = sem anexo. */
  media_id: z.string().uuid().nullable().optional(),
}).refine((d) => d.body.length > 0 || Boolean(d.media_id), { message: "Escreva o texto ou anexe um arquivo.", path: ["body"] });
export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;

export const updateTemplateSchema = z
  .object({
    title: z.string().trim().min(1).max(80),
    body: z.string().trim().max(4096),
    shortcut: z.string().trim().min(1).max(40).nullable(),
    favorito: z.boolean(),
    palavras_chave: z.array(z.string().trim().min(1).max(40)).max(20),
    media_id: z.string().uuid().nullable(),
  })
  .partial()
  .refine((d) => Object.keys(d).length > 0, { message: "Informe ao menos um campo." });
export type UpdateTemplateInput = z.infer<typeof updateTemplateSchema>;
