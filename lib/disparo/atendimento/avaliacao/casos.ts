import { z } from "zod";
export const casoSchema = z.object({
  id: z.string(), texto: z.string(), cliente_antigo: z.boolean(), etapa_conversa: z.enum(["abertura", "outro", "apos_funil_valores", "apos_explicacao", "apos_pergunta_kit", "apos_objecao"]),
  ultima_nossa: z.string().nullable(), intencao_esperada: z.string(), acao_esperada: z.enum(["explicacao_e_valores", "funil_valores", "resposta_modelo", "objecao_modelo", "pergunta_kit", "operador", "operador_venda", "encerrar", "retorno_data", "nada"]),
  deve_conter: z.array(z.string()).default([]), nao_pode: z.array(z.string()).default([]),
}).passthrough();
export type Caso = z.infer<typeof casoSchema>;
