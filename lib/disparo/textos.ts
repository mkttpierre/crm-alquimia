/**
 * Textos do motor: montar um modelo com os dados do lead e conferir antes de
 * enfileirar (e de novo antes de sair).
 *
 * O TEXTO é da organização (`disparo_config.modelos`), nunca deste arquivo: a
 * voz de cada organização (por exemplo, a persona de atendimento) e a do operador moram no banco de cada
 * uma. Aqui fica só a mecânica, portada das duas: os atalhos de saudação de uma organização
 * (`oi`, `saudacao`, `virg_nome`, `nome_virgula`) e o `{slot}` + "o que faltou"
 * da organização B (`montar`).
 */
import { bateCondicao, type Proibido, type RegraDeEscolha, type SlotsDaOrg } from "./config";
import { relogio } from "./ritmo";

/** Primeiro nome com cara de nome; null quando o campo é telefone, título ou lixo. */
export function primeiroNome(nome: string | null | undefined): string | null {
  if (!nome) return null;
  const limpo = nome.replace(/\(.*?\)/g, " ").replace(/[^\p{L}\s'-]/gu, " ").trim();
  const p = limpo.split(/\s+/)[0];
  if (!p || p.length < 2 || p.length > 20) return null;
  if (/^(sr|sra|dr|dra|doutor|doutora|dona|tia|tio|mae|mãe)$/i.test(p)) return null;
  return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
}

export function saudacao(agora: Date, fusoMinutos: number): string {
  const h = Math.floor(relogio(agora, fusoMinutos).minuto / 60);
  return h < 12 ? "Bom dia" : h < 18 ? "Boa tarde" : "Boa noite";
}

/** Os atalhos que todo modelo pode usar, a partir do nome do lead e da hora. */
export function slotsPadrao(nome: string | null | undefined, agora: Date, fusoMinutos: number): Record<string, string> {
  const n = primeiroNome(nome);
  return {
    nome: n ?? "",
    oi: n ? `Oi, ${n}!` : "Oi!",
    saudacao: saudacao(agora, fusoMinutos),
    virg_nome: n ? `, ${n}` : "",
    nome_virgula: n ? `${n}, ` : "",
  };
}

/**
 * Slots que podem ficar vazios de propósito: o texto foi escrito para ler bem
 * com e sem o nome ("{nome_virgula}lembrei de você" / "Lembrei de você").
 * Qualquer outro slot vazio conta como faltando — "Oi, , tudo bem?" nunca sai.
 */
export const SLOTS_OPCIONAIS = new Set(["virg_nome", "nome_virgula", "abre", "abre_fala"]);

/**
 * Preenche `{slot}`. O que não tem valor fica no texto e volta em `faltando`
 * (o verificador barra "campo sem preencher"). Espaço duplo some e a primeira
 * letra sobe — "{nome_virgula}lembrei de você" sem nome vira "Lembrei de você".
 */
export function montar(modelo: string, slots: Record<string, string>): { texto: string; faltando: string[] } {
  const faltando: string[] = [];
  const texto = modelo
    .replace(/\{([a-z_0-9]+)\}/g, (inteiro, chave: string) => {
      const v = slots[chave];
      if (v !== undefined && (v.trim() !== "" || SLOTS_OPCIONAIS.has(chave))) return v;
      if (!faltando.includes(chave)) faltando.push(chave);
      return inteiro;
    })
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  // Texto que começa por link ("{link}" sozinho) não ganha maiúscula: "Https://" quebra o endereço.
  if (/^https?:\/\//i.test(texto)) return { texto, faltando };
  return { texto: texto.charAt(0).toUpperCase() + texto.slice(1), faltando };
}

/** "no Tatuapé", "na Mooca", "na Vila Formosa": o artigo que soa como gente falando (portado de um motor anterior). */
const FEMININOS =
  /^(vila|chácara|chacara|cidade|mooca|água|agua|penha|saúde|saude|aclimação|aclimacao|liberdade|lapa|pompeia|pompéia|freguesia|casa|bela|barra|consolação|consolacao|aldeia|praça|praca)\b/i;
export function comPreposicao(lugar: string | null | undefined): string | null {
  const b = lugar?.trim();
  if (!b) return null;
  return `${FEMININOS.test(b) ? "na" : "no"} ${b}`;
}

/** "Mariana Souza" vira "Mariana"; "Dra. Ana Souza" vira "Dra. Ana" (como se fala com a pessoa). */
export function nomeCurto(nome: string | null | undefined): string | null {
  const partes = nome?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (!partes.length) return null;
  if (/^(dra?|doutora?|prof[a]?)\.?$/i.test(partes[0]!) && partes[1]) return `${partes[0]} ${partes[1]}`;
  return partes[0]!;
}

/**
 * Todos os slots de um lead: os campos dele (`custom_fields` com valor simples,
 * ex.: `{sinal_1}`, `{especialidade}`), os fixos da organização (`{operador}`),
 * os atalhos de saudação de uma organização e os de nome da organização B (`{nome_completo}`,
 * `{nome_curto}`, `{abre}`, `{abre_fala}`, `{no_bairro}`). Quando o lead bate em
 * `semNomeQuando` (número da recepção), todo slot de nome fica vazio.
 */
export function slotsDoLead(
  lead: { nome: string | null; campos: Record<string, unknown> },
  org: SlotsDaOrg,
  agora: Date,
  fusoMinutos: number,
): Record<string, string> {
  const semNome = org.semNomeQuando.some((c) => bateCondicao(c, lead.campos));
  const nome = semNome ? null : lead.nome?.trim() || null;
  const slots: Record<string, string> = {};
  for (const [k, v] of Object.entries(lead.campos)) {
    if (/^[a-z_0-9]+$/.test(k) && (typeof v === "string" || typeof v === "number")) slots[k] = String(v);
  }
  Object.assign(slots, org.fixos, slotsPadrao(nome, agora, fusoMinutos), {
    nome_completo: nome ?? "",
    nome_curto: nomeCurto(nome) ?? "",
    abre: nome ? `${nome}, ` : "",
    abre_fala: nome ? `, ${nome}` : "",
  });
  const noBairro = comPreposicao(typeof lead.campos["bairro"] === "string" ? (lead.campos["bairro"] as string) : null);
  if (noBairro) slots["no_bairro"] = noBairro;
  return slots;
}

/**
 * As listas de modelo que um lead pode receber num passo, na ordem de
 * tentativa. Com regras de escolha para o tipo: as que batem, em ordem. Sem
 * regra: `tipo:grupo` (se houver grupo) e depois `tipo`. Lista inexistente ou
 * vazia em `modelos` é descartada.
 */
export function listasDoPasso(
  modelos: Record<string, string[]>,
  escolha: RegraDeEscolha[],
  tipo: string,
  lead: { grupo: string | null; campos: Record<string, unknown> },
): { lista: string; versoes: string[] }[] {
  const regras = escolha.filter((r) => r.tipo === tipo);
  const nomes = regras.length
    ? regras.filter((r) => r.quando.every((c) => bateCondicao(c, lead.campos))).map((r) => r.lista)
    : [...(lead.grupo ? [`${tipo}:${lead.grupo}`] : []), tipo];
  return [...new Set(nomes)]
    .map((lista) => ({ lista, versoes: modelos[lista] ?? [] }))
    .filter((l) => l.versoes.length > 0);
}

/** Versão do modelo: gira pelas já usadas hoje para não repetir o mesmo texto em série. */
export const versaoDoDia = (usadasHoje: number, total: number) => (total > 0 ? ((usadasHoje % total) + total) % total : 0);

/** Lista de modelos de um tipo, procurando primeiro o grupo do lead (`tipo:grupo`). */
export function modelosDoTipo(modelos: Record<string, string[]>, tipo: string, grupo: string | null): string[] {
  const doGrupo = grupo ? modelos[`${tipo}:${grupo}`] : undefined;
  return doGrupo?.length ? doGrupo : (modelos[tipo] ?? []);
}

export type OpcoesVerificador = {
  /** Mensagem nova (abertura ou toque): sem preço e sem link. */
  prospeccao?: boolean;
  /** Último toque ao lead: libera os proibidos marcados `excetoUltimo`. */
  ultimoToque?: boolean;
  permitirLink?: boolean;
  proibidos?: Proibido[];
};

/**
 * Marcas de texto escrito PARA O OPERADOR (roteiro do áudio D4, lembrete da ligação D10, avisos do CRM). Ao lead vai
 * só o conteúdo da mensagem: texto com qualquer uma destas marcas nunca sai. Os lembretes já vão
 * para `crm_tasks` e não passam pelo canal; esta é a segunda barreira, para o caso de um deles escapar.
 */
const INSTRUCAO_AO_OPERADOR: RegExp[] = [
  /(^|\n)\s*(áudio|audio|ligação|ligacao) do d\d{1,2}\b/i,
  /\bo roteiro é só a espinha\b|\bo roteiro e so a espinha\b/i,
  /\bfale com as suas palavras\b/i,
  /\bo crm (percebe|agenda|segue)\b/i,
  /\benviou,? (pelo chip|o crm)\b/i,
  /\bmude a etapa no card\b/i,
  /\bligue do celular do chip\b/i,
  /\bsua voz, do whatsapp do chip\b/i,
];

/**
 * Nada sai com campo sem preencher; mensagem nova nunca leva preço nem link;
 * e as regras da casa (`disparo_config.proibidos`) valem para todo texto
 * automático. Barrou, não entra na fila: o motor registra o motivo.
 */
export function verificarTexto(texto: string, opcoes: OpcoesVerificador = {}): string[] {
  const p: string[] = [];
  if (!texto.trim()) p.push("texto vazio");
  if (INSTRUCAO_AO_OPERADOR.some((re) => re.test(texto))) p.push("tem instrução ao operador");
  if (/\{[a-z_0-9]+\}|\bundefined\b|\bnull\b/i.test(texto)) p.push("tem campo sem preencher");
  if (opcoes.prospeccao) {
    if (/r\$\s?\d|\d+\s?reais|\bpre[cç]o\b/i.test(texto)) p.push("mensagem nova fala de preço");
    if (!opcoes.permitirLink && /https?:\/\/|www\./i.test(texto)) p.push("mensagem nova tem link");
  }
  for (const regra of opcoes.proibidos ?? []) {
    if (regra.excetoUltimo && opcoes.ultimoToque) continue;
    let re: RegExp;
    try {
      re = new RegExp(regra.padrao, "i");
    } catch {
      continue; // regra mal escrita no banco não derruba o motor
    }
    if (re.test(texto)) p.push(regra.motivo);
  }
  return p;
}
