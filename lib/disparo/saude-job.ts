/**
 * O job de saúde: lê os dados do chip, calcula (`saude.ts`), grava o dia (`disparo_saude_dia`) e aplica a
 * cor no chip. Roda DENTRO da volta do motor (o cron de todo minuto), no máximo a cada
 * `ritmo.saude.recalcularACadaMin` por chip — não há cron novo.
 *
 * Regras que moram aqui e não na conta pura:
 *   - a pior cor do dia vence entre verde e amarelo (amarelo da manhã não some à tarde porque o
 *     denominador cresceu): amarelo gravado + verde calculado = amarelo;
 *   - vermelho não se repete: depois de gravado, a conta só olha o que aconteceu DEPOIS dele. É isso que
 *     deixa o operador devolver o chip no mesmo dia sem o vermelho de antes voltar na volta seguinte;
 *   - chip já vermelho nem entra aqui (`chipNaVolta` barra antes) e `acaoNoChip` nunca o desfaz.
 */
import type { ConfigDisparo } from "./config";
import type { Chip } from "./fila";
import type { RepositorioDisparo } from "./motor";
import { relogio, inicioDoDia } from "./ritmo";
import { acaoNoChip, calcularSaude, deveRecalcular, resumirSinais } from "./saude";

/** null = nada a dizer (saúde calculada e aplicada, ou repositório sem suporte). Texto = o chip parou. */
export async function avaliarSaudeDoChip(
  repo: RepositorioDisparo,
  config: ConfigDisparo,
  chip: Chip,
  agora: Date,
): Promise<string | null> {
  const cfg = config.ritmo.saude;
  if (chip.saude === "vermelho" && (chip.estado === "pausado" || chip.estado === "desligado")) return "saúde vermelha: parado";
  // Freio desligado = nada muda sozinho: chip vermelho/pausado nunca volta aqui (só com a avaliação ligada ou por ordem do operador).
  if (!cfg.ligado) return null;
  if (!repo.dadosDaSaude || !repo.saudeDoDia || !repo.gravarSaudeDoDia) return null;
  if (!deveRecalcular(chip.saudeCalculadaEm, agora, cfg)) return null;

  const org = config.organizationId;
  const fuso = config.ritmo.fusoMinutos;
  const dia = relogio(agora, fuso).data;
  const gravada = await repo.saudeDoDia(org, chip.id, dia);
  const desde = gravada?.saude === "vermelho" ? gravada.calculadoEm : inicioDoDia(agora, fuso);

  const dados = await repo.dadosDaSaude(org, chip.id, { agora, desde, janelaDias: cfg.resposta.janelaDias });
  const sinais = resumirSinais({ ...dados, inicioDoDia: desde, agora }, cfg, config.ritmo.golpeEhParada);
  let r = calcularSaude(sinais, cfg);
  if (r.saude === "verde" && gravada?.saude === "amarelo") r = { ...r, saude: "amarelo", motivos: gravada.motivos };

  const acao = acaoNoChip(chip, r, cfg, agora);
  await repo.gravarSaudeDoDia(org, {
    chipId: chip.id,
    dia,
    saude: r.saude,
    diaRampa: acao?.diaRampa ?? chip.diaRampa,
    estadoChip: chip.estado,
    sinais,
    motivos: r.motivos,
    calculadoEm: agora,
  });
  if (chip.saude === "vermelho") {
    const liberar = chip.pausadoAte && chip.pausadoAte <= agora && r.saude !== "vermelho"
      && repo.sessaoConectada && await repo.sessaoConectada(org, chip.id);
    const patch = liberar
      ? { estado: "rampa" as const, saude: "amarelo" as const, diaRampa: 1, pausadoAte: null, saudeCalculadaEm: agora, saudeMotivo: "Retorno após pausa de saúde vermelha" }
      : { saudeCalculadaEm: agora };
    await repo.atualizarChip(org, chip.id, patch);
    Object.assign(chip, patch);
    if (liberar) await repo.avisarCentral?.(org, { titulo: "Chip voltou após pausa de saúde", corpo: `O chip ${chip.nome ?? chip.id} voltou amarelo no dia 1 da rampa.`, nivel: "warn" });
    return "saúde vermelha: parado";
  }
  if (!acao) return null;

  await repo.atualizarChip(org, chip.id, { ...acao, saudeCalculadaEm: agora });
  Object.assign(chip, acao, { saudeCalculadaEm: agora });
  if (r.saude !== "vermelho") return null;
  return `saúde vermelha, chip parado por ${cfg.vermelhoHoras} h e de volta ao dia 1: ${acao.saudeMotivo ?? "sem detalhe"}`;
}
