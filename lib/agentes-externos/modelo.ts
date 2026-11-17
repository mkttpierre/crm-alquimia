/**
 * AGENTE EXTERNO — um membro da equipe que entra pelo MCP (`/api/mcp`), não pela tela.
 *
 * OpenBot, Claude Code, Codex ou outro cliente MCP. Decisões de produto: o OpenBot é o principal executor
 * do CRM; o papel padrão é `admin`; controle total do motor de disparo; PARA antes de fechar a venda (sem preço, link de
 * pagamento nem registro de venda).
 *
 * Cada agente tem um token próprio em `api_tokens`, com os escopos que o MCP já entende (`lib/mcp/auth.ts`):
 * `actor:ai_agent`, `role:<papel>`, `mcp:read`, `mcp:write`. O segredo aparece UMA vez, na criação.
 *
 * ⚠️ A forma das listas abaixo (`const X = [...] as const`) é a mesma dos CHECKs da migration 0256 — o extrator de
 * `tests/invariants/vocabulario-banco-x-typescript.test.ts` lê esse formato.
 */
import { z } from "zod";

export const TIPOS_DE_AGENTE_EXTERNO = ["openbot", "claude_code", "codex", "outro"] as const;
export type TipoDeAgenteExterno = (typeof TIPOS_DE_AGENTE_EXTERNO)[number];

export const PAPEIS_DE_AGENTE_EXTERNO = ["agent", "manager", "admin"] as const;
export type PapelDeAgenteExterno = (typeof PAPEIS_DE_AGENTE_EXTERNO)[number];

export const PAPEL_PADRAO_DO_AGENTE: PapelDeAgenteExterno = "admin";

/** Online = usou o CRM nos últimos 5 minutos. */
export const MINUTOS_ONLINE = 5;

/** Uma linha de `external_agents` como a API devolve (nunca o token). */
export interface AgenteExterno {
  id: string;
  nome: string;
  tipo: TipoDeAgenteExterno;
  avatar_url: string | null;
  papel: PapelDeAgenteExterno;
  pode_motor: boolean;
  ultimo_uso_em: string | null;
  ultima_acao: string | null;
  revogado_em: string | null;
  created_at: string;
}

export const COLUNAS_DO_AGENTE =
  "id, nome, tipo, avatar_url, papel, pode_motor, ultimo_uso_em, ultima_acao, revogado_em, created_at";

const nome = z.string().trim().min(1).max(80);
const avatar = z.string().trim().url().max(2000).refine((u) => /^https:\/\//i.test(u), { message: "use um endereço https" });

export const criacaoDoAgenteSchema = z
  .object({
    nome,
    tipo: z.enum(TIPOS_DE_AGENTE_EXTERNO).default("outro"),
    avatar_url: avatar.nullable().optional(),
    papel: z.enum(PAPEIS_DE_AGENTE_EXTERNO).default(PAPEL_PADRAO_DO_AGENTE),
    pode_motor: z.boolean().default(true),
  })
  .strict();
export type CriacaoDoAgente = z.infer<typeof criacaoDoAgenteSchema>;

export const edicaoDoAgenteSchema = z
  .object({
    nome,
    tipo: z.enum(TIPOS_DE_AGENTE_EXTERNO),
    avatar_url: avatar.nullable(),
    papel: z.enum(PAPEIS_DE_AGENTE_EXTERNO),
    pode_motor: z.boolean(),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "nada para alterar" });
export type EdicaoDoAgente = z.infer<typeof edicaoDoAgenteSchema>;

/** Os escopos do token do agente. O papel vai no token porque é por ele que o MCP decide (`ensureRole`). */
export function escoposDoAgente(papel: PapelDeAgenteExterno): string[] {
  return ["actor:ai_agent", `role:${papel}`, "mcp:read", "mcp:write"];
}

/** Online se usou o CRM há menos de 5 minutos. Sem uso, ausente. */
export function estaOnline(ultimoUsoEm: string | null, agora: Date = new Date()): boolean {
  if (!ultimoUsoEm) return false;
  const quando = Date.parse(ultimoUsoEm);
  if (!Number.isFinite(quando)) return false;
  return agora.getTime() - quando < MINUTOS_ONLINE * 60_000;
}

/**
 * O nome que um agente revogado passa a ter: libera o nome original (`unique (organization_id, nome)`) para um agente
 * novo com o mesmo nome, sem perder de quem era a linha na auditoria.
 */
export function nomeDoRevogado(nomeAtual: string, id: string): string {
  return `${nomeAtual.slice(0, 80)} (revogado ${id.slice(0, 8)})`;
}
