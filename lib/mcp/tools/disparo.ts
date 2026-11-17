/**
 * Ferramentas do MOTOR DE DISPARO para agentes externos.
 *
 * Decisão do dono (13/11/2026): o agente principal (OpenBot) tem controle total do motor — ler estado, fila e saúde
 * dos chips; pausar e retomar chip e motor; ajustar o ritmo; trocar o modo para real.
 *
 * NADA aqui reimplementa regra: cada ferramenta chama a MESMA função da rota da tela (`lib/disparo-painel/operacoes.ts`)
 * — mesma validação (`edicaoDaConfigSchema`), mesma recusa, mesma gravação e mesma auditoria
 * (`disparo.config_atualizada`), com o agente NOMEADO como autor.
 *
 * Travas que continuam valendo:
 *   - escopo `mcp:write` para mudar e papel `manager` (trocar `modo` exige `admin`, decidido dentro de
 *     `editarConfigDoMotor` pelo papel do token);
 *   - `pode_motor` do agente (`motor: true` abaixo; o servidor MCP recusa antes do handler);
 *   - o envio real continua exigindo `DISPARO_REAL_LIBERADO=sim` no servidor. Trocar o modo grava só a primeira chave;
 *     a segunda nenhuma ferramenta toca.
 *
 * Recusa de negócio (corpo inválido, chip retirado, motor não criado) volta como `{ ok: false, motivo, mensagem }` —
 * o agente lê, corrige e segue, em vez de o turno morrer numa exceção.
 */
import { z } from "zod";

import { FILTROS_DA_FILA, consultaDaFilaSchema } from "@/lib/disparo-painel/esquemas";
import {
  editarConfigDoMotor,
  lerChipsDoMotor,
  lerEstadoDoMotor,
  lerFilaDoMotor,
  mudarChipDoMotor,
  type AutorDaMudanca,
  type Resultado,
} from "@/lib/disparo-painel/operacoes";
import { PERFIS } from "@/lib/disparo/perfis";

import type { McpContext, McpToolDefinition } from "../types";

function autorDoContexto(ctx: McpContext): AutorDaMudanca {
  return {
    actorUserId: null,
    actorApiTokenId: ctx.apiTokenId,
    agente: ctx.agenteExterno ? { id: ctx.agenteExterno.id, nome: ctx.agenteExterno.nome } : null,
  };
}

function resposta<T>(r: Resultado<T>): unknown {
  if (r.ok) return { ok: true, ...((r.dados ?? {}) as object) };
  return { ok: false, motivo: r.codigo, mensagem: r.mensagem, ...(r.detalhes ? { detalhes: r.detalhes } : {}) };
}

const clientes = (ctx: McpContext) => ({ leitura: ctx.supabase, escrita: ctx.supabase });

// ---------------------------------------------------------------------------
// leitura
// ---------------------------------------------------------------------------

const vazio = {};

export const crmDisparoEstado: McpToolDefinition<typeof vazio> = {
  name: "crm_disparo_estado",
  description:
    "Estado do motor de disparo: ligado ou pausado, modo gravado e modo efetivo (real só com as DUAS chaves: modo=real " +
    "na organização E a variável do servidor), janela de hoje, ritmo, teto diário, próximo envio, contagens da fila " +
    "e quantos chips estão ativos.",
  inputSchema: vazio,
  category: "read",
  requiresRole: "manager",
  requiresScope: "mcp:read",
  motor: true,
  handler: async (_input, ctx) => resposta(await lerEstadoDoMotor(ctx.supabase, ctx.organizationId)),
};

const filaShape = {
  estado: z.enum(FILTROS_DA_FILA).optional().default("fila").describe("'fila' = pendentes e simulados (padrão)."),
  pagina: z.number().int().min(1).max(10_000).optional().default(1),
};

export const crmDisparoFila: McpToolDefinition<typeof filaShape> = {
  name: "crm_disparo_fila",
  description:
    "Fila do motor de disparo, 20 por página: lead, passo da cadência, texto, chip e horário previsto. Filtre por " +
    "estado (fila, pendente, enviando, enviado, simulado, cancelado, falhou).",
  inputSchema: filaShape,
  category: "read",
  requiresRole: "manager",
  requiresScope: "mcp:read",
  motor: true,
  handler: async (input, ctx) => {
    const consulta = consultaDaFilaSchema.parse({ estado: input.estado, pagina: input.pagina });
    return resposta(await lerFilaDoMotor(ctx.supabase, ctx.organizationId, consulta));
  },
};

export const crmDisparoChips: McpToolDefinition<typeof vazio> = {
  name: "crm_disparo_chips",
  description:
    "Chips do motor e a saúde de cada um: estado (rampa, ativo, pausado, desligado), cor da saúde e o motivo, dia da " +
    "rampa, envios de hoje e o teto de hoje, último e próximo envio, e o painel do dia (aberturas, respostas, bloqueio " +
    "provável, irritação, quedas).",
  inputSchema: vazio,
  category: "read",
  requiresRole: "manager",
  requiresScope: "mcp:read",
  motor: true,
  handler: async (_input, ctx) => resposta(await lerChipsDoMotor(ctx.supabase, ctx.organizationId)),
};

// ---------------------------------------------------------------------------
// escrita: chip
// ---------------------------------------------------------------------------

const chipShape = { chip_id: z.string().uuid().describe("id do chip (veja crm_disparo_chips)") };

/**
 * Cada ferramenta é um `export const … : McpToolDefinition` com nome e categoria escritos: é a forma que
 * `tests/unit/tool-read-nao-muta.test.ts` lê. Só o corpo é compartilhado.
 */
const mudarChip =
  (acao: "pausar" | "retomar"): McpToolDefinition<typeof chipShape>["handler"] =>
  async (input, ctx) =>
    resposta(
      await mudarChipDoMotor(clientes(ctx), {
        orgId: ctx.organizationId,
        chipId: input.chip_id,
        acao,
        autor: autorDoContexto(ctx),
        requestId: ctx.requestId,
      }),
    );

export const crmDisparoPausarChip: McpToolDefinition<typeof chipShape> = {
  name: "crm_disparo_pausar_chip",
  description: "Pausa um chip do motor: ele para de enviar e a fila dele fica como está. Não apaga nada.",
  inputSchema: chipShape,
  category: "write",
  requiresRole: "manager",
  requiresScope: "mcp:write",
  motor: true,
  handler: mudarChip("pausar"),
};

export const crmDisparoRetomarChip: McpToolDefinition<typeof chipShape> = {
  name: "crm_disparo_retomar_chip",
  description:
    "Retoma um chip pausado (ativo se já passou da rampa, rampa antes). Não solta o freio de saúde: um chip " +
    "vermelho continua parado até a saúde soltá-lo, e a resposta traz o aviso.",
  inputSchema: chipShape,
  category: "write",
  requiresRole: "manager",
  requiresScope: "mcp:write",
  motor: true,
  handler: mudarChip("retomar"),
};

// ---------------------------------------------------------------------------
// escrita: motor
// ---------------------------------------------------------------------------

const ligarMotor =
  (ligado: boolean): McpToolDefinition<typeof vazio>["handler"] =>
  async (_input, ctx) =>
    resposta(
      await editarConfigDoMotor(clientes(ctx), {
        orgId: ctx.organizationId,
        papel: ctx.role,
        corpo: { ligado },
        autor: autorDoContexto(ctx),
        requestId: ctx.requestId,
      }),
    );

export const crmDisparoPausarMotor: McpToolDefinition<typeof vazio> = {
  name: "crm_disparo_pausar_motor",
  description:
    "Pausa o motor de disparo inteiro: nenhuma abertura nem passo de cadência sai até alguém retomar. Avisa quem " +
    "assina o evento motor.parou.",
  inputSchema: vazio,
  category: "write",
  requiresRole: "manager",
  requiresScope: "mcp:write",
  motor: true,
  handler: ligarMotor(false),
};

export const crmDisparoRetomarMotor: McpToolDefinition<typeof vazio> = {
  name: "crm_disparo_retomar_motor",
  description:
    "Liga o motor de disparo da organização. O que sai continua sob a trava dupla: só envia de verdade com modo=real " +
    "E a variável do servidor; senão, simula.",
  inputSchema: vazio,
  category: "write",
  requiresRole: "manager",
  requiresScope: "mcp:write",
  motor: true,
  handler: ligarMotor(true),
};

/**
 * Ajuste de ritmo: o MESMO corpo que a tela manda ao `PATCH /api/v1/disparo/config`, menos `modo` (que tem ferramenta
 * própria e papel próprio). A validação é a da tela, dentro de `editarConfigDoMotor`: o shape aqui é aberto de
 * propósito (`passthrough` não; os campos são conhecidos), e um valor fora da faixa volta com a mesma mensagem.
 */
const ajusteShape = {
  ritmo: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Campos do ritmo a mudar (mesclados no gravado): janela {semana,sabado,domingo:[{inicio,fim}] em minutos}, " +
        "intervaloNova {min,max}, pausa {min,max}, pausaACada {min,max}, maxAberturasHora, maxEnviosHora, rampa [..].",
    ),
  perfil: z.enum(PERFIS).optional().describe("Atalho: aplica um perfil de ritmo pronto antes do ajuste."),
  teto_diario: z.number().int().nullable().optional().describe("Aberturas por chip por dia; null tira o teto."),
  cadencia: z.string().optional(),
  fonte_stage_id: z.string().uuid().nullable().optional(),
  modelos: z.record(z.string(), z.unknown()).optional(),
  proibidos: z.array(z.unknown()).optional(),
};

export const crmDisparoAjustarRitmo: McpToolDefinition<typeof ajusteShape> = {
  name: "crm_disparo_ajustar_ritmo",
  description:
    "Ajusta o motor de disparo com as MESMAS regras da tela: ritmo parcial, perfil, teto diário, cadência, etapa de " +
    "origem, mensagens e palavras proibidas. Valor fora da faixa é recusado com o motivo. Não troca o modo (use " +
    "crm_disparo_trocar_modo).",
  inputSchema: ajusteShape,
  category: "write",
  requiresRole: "manager",
  requiresScope: "mcp:write",
  motor: true,
  handler: async (input, ctx) => {
    const corpo = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
    return resposta(
      await editarConfigDoMotor(clientes(ctx), {
        orgId: ctx.organizationId,
        papel: ctx.role,
        corpo,
        autor: autorDoContexto(ctx),
        requestId: ctx.requestId,
      }),
    );
  },
};

const modoShape = { modo: z.enum(["simulado", "real"]) };

export const crmDisparoTrocarModo: McpToolDefinition<typeof modoShape> = {
  name: "crm_disparo_trocar_modo",
  description:
    "Troca o modo do motor entre simulado e real. Exige papel admin. Real grava só a PRIMEIRA chave: o envio de verdade " +
    "continua exigindo a variável DISPARO_REAL_LIBERADO=sim no servidor, que nenhuma ferramenta muda.",
  inputSchema: modoShape,
  category: "write",
  requiresRole: "admin",
  requiresScope: "mcp:write",
  motor: true,
  handler: async (input, ctx) =>
    resposta(
      await editarConfigDoMotor(clientes(ctx), {
        orgId: ctx.organizationId,
        papel: ctx.role,
        corpo: { modo: input.modo },
        autor: autorDoContexto(ctx),
        requestId: ctx.requestId,
      }),
    ),
};
