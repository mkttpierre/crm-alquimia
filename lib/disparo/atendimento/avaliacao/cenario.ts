import { RepositorioEmMemoria, configDisparoExemplo } from "../apoio-de-teste";
import { atenderMensagem } from "../atendimento";
import type { ConfigAtendimento } from "../config";
import { criarJulgar } from "../jev";
import type { Ritmo } from "../../config";
import type { Caso } from "./casos";
import { conversaNova } from "../estado";

const ORG = "22222222-2222-4222-8222-222222222222";
const AGORA = new Date("2026-10-26T14:00:00Z");
export async function montarCenario(caso: Caso, config: ConfigAtendimento, ritmo: Ritmo, chave: string | null) {
  const disparo = configDisparoExemplo(ORG);
  disparo.ritmo = ritmo;
  // A configuração de exemplo não representa os proibidos da casa; não fabricar regras.
  disparo.proibidos = [];
  const repo = new RepositorioEmMemoria(ORG, disparo, config);
  const campos = caso.cliente_antigo ? { classe: "P1", produto_origem: "Produto A", trilha: config.perfil === "venda" ? config.clientes?.trilhas[0] : undefined } : {};
  const lead = repo.novoLead(`aval-${caso.id}`, { nome: "Maria Aparecida", campos });
  repo.chipPorLead.set(lead.id, "chip-qa");
  const deps = { repo, agora: AGORA, ambiente: {}, julgar: criarJulgar({ chave }), sortear: () => 0.5 };
  let n = 0;
  const diz = async (texto: string, midia = false) => atenderMensagem(deps, ORG, lead.id, { chave: `aval-${++n}`, messageId: null, texto, midia });
  const preparacao: string[] = [];
  if (["apos_explicacao", "apos_funil_valores", "apos_pergunta_kit", "apos_objecao"].includes(caso.etapa_conversa)) {
    const estado = conversaNova();
    estado.etapa = "qualificando";
    estado.dados.explicacaoEnviada = true;
    estado.dados.tabelaEnviada = caso.etapa_conversa !== "apos_explicacao";
    if (caso.etapa_conversa === "apos_objecao") estado.dados.objecoesRespondidas = ["objecao_preco"];
    repo.conversas.set(lead.id, { ...estado, ultimaAutoEm: null });
    preparacao.push(`estado reconstruído: ${caso.etapa_conversa}`);
  }
  const tabelaPreparada = repo.conversas.get(lead.id)?.dados.tabelaEnviada ?? false;
  if (caso.ultima_nossa) await repo.enfileirar(ORG, { leadId: lead.id, chipId: "chip-qa", tipo: "historico", texto: caso.ultima_nossa, midia: null, enviarApos: AGORA, estado: "simulado", motivo: null, daParada: false });
  const anterior = repo.envios.length, avisosAntes = repo.avisos.length, paradasAntes = repo.paradas.length;
  const midia = /^\((áudio|imageMessage|mídia)\)$/i.test(caso.texto.trim());
  const texto = midia && caso.texto.toLowerCase() === "(imagemessage)" ? "(mídia)" : caso.texto;
  const resultado = await diz(texto, midia);
  const envios = repo.envios.slice(anterior).filter(e => !e.cancelado);
  const avisos = repo.avisos.slice(avisosAntes);
  const conversa = repo.conversas.get(lead.id);
  const leitura = [...repo.leituras.values()].at(-1)?.leitura;
  return { resultado, envios, avisos, conversa, leitura, parou: repo.paradas.length > paradasAntes, preparacao, tabelaPreparada, naoContatar: repo.naoContatar.has(lead.id) };
}
