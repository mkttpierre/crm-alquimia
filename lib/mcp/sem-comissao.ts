/**
 * A COMISSÃO NÃO CHEGA À IA.
 *
 * O valor dos planos internos é a COMISSÃO do operador. O valor do negócio (`crm_leads.value_cents`, a soma das linhas)
 * herda o sigilo, e o agente de IA lê negócios pelas ferramentas de CRM (listar, buscar, e o retorno de atualizar, mover e
 * encerrar). Este filtro roda na saída de TODA ferramenta, nos dois ingressos (o MCP externo, `lib/mcp/server.ts`, e a
 * ponte do agente nativo, `lib/ai/runtime/tools.ts`):
 *
 *  · quem decide é `crm_leads.valor_sigiloso`, uma marca do BANCO e pegajosa (migration 0251): liga sozinha com linha de
 *    produto interno ou venda registrada, e nunca volta a falso (a chave de idempotência da venda vive à parte, em
 *    `crm_venda_chaves`, e não é o sigilo);
 *  · negócio sigiloso sai com `value_cents` nulo e os campos de dinheiro dos FILHOS (`total_cents`, `amount`, preço,
 *    desconto…) são removidos;
 *  · FALHA FECHADO: objeto que tem `value_cents` mas veio sem a coluna `valor_sigiloso` (uma consulta com lista de colunas
 *    que esqueceu dela) é tratado como sigiloso — valor nulo em vez de valor vazado;
 *  · a marca NUNCA sai para a IA.
 *
 * Aplique UMA vez por ingresso: depois de aplicado o objeto não carrega mais a marca, e uma segunda passada tomaria todo
 * negócio por "sem a coluna". Não muta o original e não toca a API da TELA, que continua mostrando o valor ao operador.
 * Vigiado por `tests/unit/comissao-nao-chega-a-ia.test.ts`.
 */

import { CAMPO_DE_DINHEIRO } from "@/lib/negocio/valor-sigiloso";

function ehObjetoSimples(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

function pareceNegocio(o: Record<string, unknown>): boolean {
  return "value_cents" in o || "valor_sigiloso" in o;
}

function ehSigiloso(o: Record<string, unknown>): boolean {
  if (o.valor_sigiloso === true) return true;
  // Falha fechado: valor sem a coluna que diz se pode ser mostrado.
  return "value_cents" in o && o.valor_sigiloso !== false;
}

/** Tira, em qualquer profundidade, todo campo de dinheiro (regra `CAMPO_DE_DINHEIRO`). Também usada pela exportação em CSV. */
export function semDinheiro(valor: unknown): unknown {
  if (Array.isArray(valor)) return valor.map(semDinheiro);
  if (!ehObjetoSimples(valor)) return valor;
  const saida: Record<string, unknown> = {};
  for (const [chave, v] of Object.entries(valor)) {
    if (CAMPO_DE_DINHEIRO.test(chave)) continue;
    saida[chave] = semDinheiro(v);
  }
  return saida;
}

export function semComissao<T>(valor: T): T {
  if (Array.isArray(valor)) return valor.map((v) => semComissao(v)) as unknown as T;
  if (!ehObjetoSimples(valor)) return valor;

  const negocio = pareceNegocio(valor);
  const sigiloso = negocio && ehSigiloso(valor);
  const saida: Record<string, unknown> = {};
  for (const [chave, v] of Object.entries(valor)) {
    if (negocio && (chave === "valor_sigiloso")) continue;
    if (sigiloso) {
      if (chave === "value_cents") saida[chave] = null;
      else if (!CAMPO_DE_DINHEIRO.test(chave)) saida[chave] = semDinheiro(v);
      continue;
    }
    saida[chave] = semComissao(v);
  }
  return saida as T;
}
