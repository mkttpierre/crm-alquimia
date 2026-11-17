/**
 * O miolo comum das duas rotas de exportação (`/api/v1/contacts/export` e `/api/v1/leads/export`): separador, filtros,
 * modo suporte, limite de uso e a resposta em streaming com a auditoria no fim. Cada rota só diz o que é diferente nela
 * (papel, filtros, tabela).
 */
import type { z } from "zod";

import { fail } from "@/lib/api/wrappers";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { audit } from "@/lib/audit";
import type { AuditAction } from "@/lib/audit/actions";
import type { AuthUser } from "@/lib/auth/types";
import { logger } from "@/lib/logger";
import { LimiteDeLeituraExcedido } from "@/lib/negocio/limite-de-leitura";

import { paramsComoObjeto } from "./consulta";
import { criarStreamDeCsv, nomeDoArquivo, type Separador } from "./csv";
import type { ExportacaoPreparada } from "./paginar";

/** 5 exportações por minuto por usuário: exportar a base inteira é caro e é o ato que mais vaza dado. */
export const EXPORTACOES_POR_MINUTO = 5;
export const JANELA_EM_SEGUNDOS = 60;

/** `?separador=virgula` (padrão) ou `?separador=ponto-e-virgula` (o Excel em português espera `;`). */
export function lerSeparador(valor: string | null): Separador | null {
  if (valor === null || valor === "" || valor === "virgula") return ",";
  if (valor === "ponto-e-virgula") return ";";
  return null;
}

/** Filtros da URL conferidos pelo schema; filtro malformado vira 422 (nunca chega ao banco). */
export function lerFiltros<S extends z.ZodType>(
  params: URLSearchParams,
  schema: S,
  requestId: string,
  t: (texto: string) => string,
): { ok: true; filtros: z.output<S> } | { ok: false; response: Response } {
  const lido = schema.safeParse(paramsComoObjeto(params));
  if (lido.success) return { ok: true, filtros: lido.data };
  return {
    ok: false,
    response: fail("validation_failed", t("Filtros inválidos."), 422, {
      requestId,
      details: lido.error.issues.map((i) => ({ campo: i.path.join("."), mensagem: i.message })),
    }),
  };
}

/**
 * Exportar a base do cliente é ato do DONO da conta (LGPD). A sessão de acompanhamento administrativo (modo suporte,
 * `access_mode` "full" ou somente leitura) enxerga a conta como admin ou viewer, mas NÃO exporta: 403 claro.
 */
export function barrarModoSuporte(
  user: Pick<AuthUser, "support">,
  requestId: string,
  t: (texto: string) => string,
): Response | null {
  if (!user.support) return null;
  return fail(
    "forbidden",
    t("Exportar os dados do cliente é ato do dono da conta e não está disponível durante o acompanhamento administrativo."),
    403,
    { requestId },
  );
}

/** Devolve a resposta 429 quando o usuário passou do limite; `null` quando pode seguir. */
export async function barrarSeEstourouOLimite(
  balde: string,
  userId: string,
  requestId: string,
  mensagem: string,
): Promise<Response | null> {
  const limite = await checkRateLimit(`${balde}:${userId}`, EXPORTACOES_POR_MINUTO, JANELA_EM_SEGUNDOS);
  if (limite.allowed) return null;
  // A janela do contador é fixa (`floor(agora / janela)`): ela vence no próximo múltiplo de 60 s.
  const reinicio = (Math.floor(Date.now() / (JANELA_EM_SEGUNDOS * 1000)) + 1) * JANELA_EM_SEGUNDOS;
  return fail("rate_limited", mensagem, 429, {
    requestId,
    headers: {
      "Retry-After": String(JANELA_EM_SEGUNDOS),
      "X-RateLimit-Limit": String(limite.limit),
      "X-RateLimit-Remaining": "0",
      "X-RateLimit-Reset": String(reinicio),
    },
  });
}

/** Falha antes do primeiro byte: a causa (que pode ser mensagem crua do banco) só vai para o log, nunca para a resposta. */
export function falhaAoPreparar(
  erro: unknown,
  rota: string,
  requestId: string,
  t: (texto: string) => string,
): Response {
  // A base passou do teto de leitura do filtro de intervalo: não é falha do servidor, é pedido largo demais.
  if (erro instanceof LimiteDeLeituraExcedido) {
    logger.warn("[exportacao] base acima do teto de leitura", { rota, requestId });
    return fail("validation_failed", t("A base é grande demais para esse intervalo; estreite o filtro."), 422, { requestId });
  }
  logger.error("[exportacao] falha ao preparar o arquivo", {
    rota,
    requestId,
    erro: erro instanceof Error ? erro.message : String(erro),
  });
  return fail("internal_error", t("Não foi possível exportar."), 500, { requestId });
}

export type FiltrosAuditados = Record<string, string | number | boolean>;

/**
 * Os filtros que vão para a auditoria. A BUSCA é dado pessoal em potencial (nome, telefone, e-mail de quem se procurou):
 * grava só SE havia busca e o tamanho dela, nunca o termo. Etiqueta, origem, funil e datas são vocabulário do negócio e
 * ficam como vieram.
 */
export function filtrosParaAuditoria(
  filtros: Record<string, string | undefined>,
  chaveDaBusca: string,
): FiltrosAuditados {
  const saida: FiltrosAuditados = {};
  for (const [chave, valor] of Object.entries(filtros)) {
    if (valor === undefined || valor === "") continue;
    if (chave === chaveDaBusca) {
      saida.busca_informada = true;
      saida.busca_tamanho = valor.length;
    } else {
      saida[chave] = valor;
    }
  }
  return saida;
}

export interface OpcoesDaResposta {
  requestId: string;
  prefixoDoArquivo: string;
  separador: Separador;
  preparada: ExportacaoPreparada;
  auditoria: {
    action: AuditAction;
    organizationId: string;
    actorUserId: string;
    resourceType: string;
    filtros: FiltrosAuditados;
  };
}

export function respostaEmCsv(o: OpcoesDaResposta): Response {
  const stream = criarStreamDeCsv({
    cabecalho: o.preparada.cabecalho,
    separador: o.separador,
    paginas: o.preparada.paginas(),
    // Uma vez, ao terminar, cancelar ou falhar: contagem, desfecho e filtros. Nenhuma linha de dado.
    aoEncerrar: async (fim) => {
      await audit({
        action: o.auditoria.action,
        organizationId: o.auditoria.organizationId,
        actorUserId: o.auditoria.actorUserId,
        resourceType: o.auditoria.resourceType,
        requestId: o.requestId,
        metadata: {
          linhas: fim.linhas,
          completo: fim.completo,
          filtros: o.auditoria.filtros,
          separador: o.separador === ";" ? "ponto-e-virgula" : "virgula",
          ...(fim.erro ? { erro: fim.erro } : {}),
        },
      });
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${nomeDoArquivo(o.prefixoDoArquivo)}"`,
      "Cache-Control": "no-store",
      "X-Request-Id": o.requestId,
    },
  });
}
