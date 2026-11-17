/**
 * Capacidade de PROVEDORES DE IA — ver quais provedores estão conectados,
 * quais modelos a chave de cada um libera e escolher o modelo de cada parte do
 * sistema.
 *
 * É UMA ferramenta com três ações, e não três ferramentas, por causa da conta
 * de vagas do agente (`lib/mcp/tools/selecao-por-pacote.ts`, teto de 25): toda
 * entrada do catálogo ocupa vaga no pacote em que mora, e o pacote que sobrava
 * (`evoluir`) já estava no teto — duas leituras novas lá deixariam o agente
 * recém-criado sem nenhuma jornada para ligar (`tests/unit/pacote-reserva-vaga-
 * da-critica.test.ts`, o defeito D3). Pelo mesmo motivo ela mora em `vender`,
 * o pacote com que o agente nasce: capacidade CRÍTICA nunca entra por pacote,
 * então ali ela não toma vaga de ninguém.
 *
 * Exige papel admin. `apenasHumano` diz a verdade pela metade, então aqui vai a
 * outra: quem fica de FORA é só o agente NATIVO que atende o cliente (o papel
 * dele, `ai_operator`, não alcança admin, e a ponte não monta a ferramenta). Um
 * agente EXTERNO com token de papel admin e escopo `mcp:write` PODE listar e
 * trocar o modelo de um ponto — é para isso que ela existe (B6) — e cada troca
 * fica no audit log (`ai.purpose_binding_updated`, com o token e o nome do
 * agente). O que ele não pode é definir endereço próprio: `base_url` volta 422
 * (é para lá que a chave iria). A chave nunca volta na resposta.
 */
import { declararTools } from "./tipos";

export const TOOLS_PROVEDORES = declararTools([
  {
    name: "crm_ai_providers",
    category: "write",
    rotulo: "Configurar os provedores de IA",
    explicacao:
      "Mostra quais provedores de inteligência artificial estão conectados e quais modelos a chave de cada um libera, e troca o modelo que atende cada parte do sistema. Nunca mostra a chave.",
    oQueToca: "Configuração de IA",
    risco: "critico",
    pacotes: ["vender"],
    apenasHumano: true,
  },
]);
