/**
 * As seções de "Segurança de envio" (gaveta Personalizar) como DADO: cada campo diz onde mora no ritmo
 * (`caminho`), como se edita e como se lê o recomendado. A gaveta só desenha esta lista; o recomendado vem
 * sempre de `RITMO_PADRAO`, nunca de número escrito aqui.
 */
import { RITMO_PADRAO, type Ritmo } from "@/lib/disparo/config";

export type TipoDeCampo =
  | "numero"
  | "percentual"
  | "faixa"
  | "faixaOuComum"
  | "listaDeFaixas"
  | "listaDeNumeros"
  | "booleano"
  | "blocos"
  | "datas"
  | "listaDeTextos"
  | "mapaDeListas"
  | "mapaDeTextos"
  | "mapaDeNumeros"
  | "condicoes"
  | "midia";

export type CampoDoRitmo = {
  /** Caminho no ritmo, com ponto: `saude.bloqueio.amarelo`. */
  caminho: string;
  rotulo: string;
  tipo: TipoDeCampo;
  unidade?: string;
};

export type SecaoDoRitmo = {
  id: string;
  titulo: string;
  descricao?: string;
  /** Campos de topo do ritmo que "Voltar ao recomendado" devolve ao padrão. */
  chaves: (keyof Ritmo)[];
  campos: CampoDoRitmo[];
};

export const SECOES_DO_RITMO: SecaoDoRitmo[] = [
  {
    id: "janela",
    titulo: "Janela e feriados",
    descricao: "Quando o motor pode mandar mensagem nova. Dia sem bloco não prospecta.",
    chaves: ["janela", "feriados"],
    campos: [
      { caminho: "janela.semana", rotulo: "Segunda a sexta", tipo: "blocos" },
      { caminho: "janela.sabado", rotulo: "Sábado", tipo: "blocos" },
      { caminho: "janela.domingo", rotulo: "Domingo", tipo: "blocos" },
      { caminho: "feriados", rotulo: "Feriados (sem envio)", tipo: "datas" },
    ],
  },
  {
    id: "intervalos",
    titulo: "Intervalo entre conversas novas",
    chaves: ["intervaloNova", "intervaloNovaMaduro", "intervaloInicioRampa", "intervaloDomingo", "intervaloNovaPisoMin"],
    campos: [
      { caminho: "intervaloNova", rotulo: "Chip em rampa", tipo: "faixa", unidade: "min" },
      { caminho: "intervaloNovaMaduro", rotulo: "Chip maduro", tipo: "faixa", unidade: "min" },
      { caminho: "intervaloInicioRampa", rotulo: "Primeiros dias da rampa (dia 1, dia 2...)", tipo: "listaDeFaixas", unidade: "min" },
      { caminho: "intervaloDomingo", rotulo: "Domingo", tipo: "faixa", unidade: "min" },
      { caminho: "intervaloNovaPisoMin", rotulo: "Nunca menos que", tipo: "numero", unidade: "min" },
    ],
  },
  {
    id: "minimo",
    titulo: "Intervalo mínimo entre quaisquer mensagens",
    chaves: ["intervaloMinimoSeg"],
    campos: [{ caminho: "intervaloMinimoSeg", rotulo: "Entre duas mensagens do chip", tipo: "numero", unidade: "s" }],
  },
  {
    id: "porHora",
    titulo: "Máximos por hora",
    chaves: ["maxEnviosHora", "maxAberturasHora"],
    campos: [
      { caminho: "maxEnviosHora", rotulo: "Mensagens por hora", tipo: "numero" },
      { caminho: "maxAberturasHora", rotulo: "Conversas novas por hora", tipo: "numero" },
    ],
  },
  {
    id: "pausas",
    titulo: "Pausas longas",
    descricao: "De tempos em tempos o chip para, como uma pessoa pararia.",
    chaves: ["pausa", "pausaACada", "pausaMaduro", "pausaACadaMaduro", "pausaDomingo", "pausaACadaDomingo"],
    campos: [
      { caminho: "pausa", rotulo: "Duração", tipo: "faixa", unidade: "min" },
      { caminho: "pausaACada", rotulo: "A cada (envios novos)", tipo: "faixa" },
      { caminho: "pausaMaduro", rotulo: "Duração no chip maduro", tipo: "faixaOuComum", unidade: "min" },
      { caminho: "pausaACadaMaduro", rotulo: "A cada, no chip maduro", tipo: "faixaOuComum" },
      { caminho: "pausaDomingo", rotulo: "Duração no domingo", tipo: "faixaOuComum", unidade: "min" },
      { caminho: "pausaACadaDomingo", rotulo: "A cada, no domingo", tipo: "faixaOuComum" },
    ],
  },
  {
    id: "rampa",
    titulo: "Rampa de conversas novas por dia",
    descricao: "Quantas conversas novas cada chip abre no dia 1, no dia 2... Depois do último, vale o último.",
    chaves: ["rampa", "diaMaduro"],
    campos: [
      { caminho: "rampa", rotulo: "Por dia da rampa", tipo: "listaDeNumeros" },
      { caminho: "diaMaduro", rotulo: "Chip maduro a partir do dia", tipo: "numero" },
    ],
  },
  {
    id: "teto",
    titulo: "Teto total do dia",
    descricao: "Respostas e toques também contam: teto = conversas novas × fator + folga.",
    chaves: ["fatorTotal", "folgaTotal"],
    campos: [
      { caminho: "fatorTotal", rotulo: "Fator", tipo: "numero" },
      { caminho: "folgaTotal", rotulo: "Folga", tipo: "numero" },
    ],
  },
  {
    id: "saude",
    titulo: "Saúde do chip",
    descricao: "Amarelo segura a rampa; vermelho para o chip.",
    chaves: ["saude"],
    campos: [
      { caminho: "saude.ligado", rotulo: "Freio de saúde ligado", tipo: "booleano" },
      { caminho: "saude.horasSemEntrega", rotulo: "Sem entrega depois de", tipo: "numero", unidade: "h" },
      { caminho: "saude.bloqueio.amarelo", rotulo: "Bloqueio provável: amarelo a partir de", tipo: "percentual", unidade: "%" },
      { caminho: "saude.bloqueio.vermelho", rotulo: "Bloqueio provável: vermelho a partir de", tipo: "percentual", unidade: "%" },
      { caminho: "saude.naoQuero.amarelo", rotulo: "\"Não quero\": amarelo a partir de", tipo: "percentual", unidade: "%" },
      { caminho: "saude.naoQuero.vermelho", rotulo: "\"Não quero\": vermelho a partir de", tipo: "percentual", unidade: "%" },
      { caminho: "saude.irritacao.amarelo", rotulo: "Irritação no dia: amarelo a partir de", tipo: "numero" },
      { caminho: "saude.irritacao.vermelho", rotulo: "Irritação no dia: vermelho a partir de", tipo: "numero" },
      { caminho: "saude.resposta.ok", rotulo: "Taxa de resposta boa a partir de", tipo: "percentual", unidade: "%" },
      { caminho: "saude.resposta.vermelho", rotulo: "Taxa de resposta vermelha abaixo de", tipo: "percentual", unidade: "%" },
      { caminho: "saude.vermelhoHoras", rotulo: "Vermelho para o chip por", tipo: "numero", unidade: "h" },
    ],
  },
  {
    id: "quarentena",
    titulo: "Quarentena do lead",
    chaves: ["quarentena"],
    campos: [
      { caminho: "quarentena.ligado", rotulo: "Quarentena ligada", tipo: "booleano" },
      { caminho: "quarentena.dias", rotulo: "Depois do último toque sem resposta", tipo: "numero", unidade: "dias" },
      { caminho: "quarentena.diasEntreAbordagens", rotulo: "Entre abordagens frias", tipo: "numero", unidade: "dias" },
      { caminho: "quarentena.maxSemRespostaMes", rotulo: "Mensagens sem resposta no mês", tipo: "numero" },
    ],
  },
  {
    id: "validade",
    titulo: "Validade da fila",
    descricao: "O que ficou parado não sai depois fora de contexto.",
    chaves: ["validade"],
    campos: [
      { caminho: "validade.autoHoras", rotulo: "Resposta automática atrasada é cancelada depois de", tipo: "numero", unidade: "h" },
      { caminho: "validade.toqueAtrasoHoras", rotulo: "Toque atrasado é reprogramado depois de", tipo: "numero", unidade: "h" },
      { caminho: "validade.toqueEspalharHoras", rotulo: "Toque reprogramado cai nas próximas", tipo: "numero", unidade: "h" },
      { caminho: "validade.enviandoPresoMin", rotulo: "Envio preso é encerrado depois de", tipo: "numero", unidade: "min" },
      { caminho: "validade.paradaSilenciosaHoras", rotulo: "Aviso de motor parado depois de", tipo: "numero", unidade: "h" },
    ],
  },
  {
    id: "automaticas",
    titulo: "Respostas automáticas seguidas",
    chaves: ["limiteAutomaticasSeguidas"],
    campos: [{ caminho: "limiteAutomaticasSeguidas", rotulo: "Sem o operador no meio, no máximo", tipo: "numero" }],
  },
  {
    id: "travas",
    titulo: "Não entregue e chip mudo",
    descricao: "Lead com 1 tique por muito tempo sai da fila; chip que para de confirmar entrega gera aviso.",
    chaves: ["naoEntregue", "chipMudo"],
    campos: [
      { caminho: "naoEntregue.ligado", rotulo: "Trava de não entregue ligada", tipo: "booleano" },
      { caminho: "naoEntregue.horasMarcar", rotulo: "Para de mandar ao lead depois de", tipo: "numero", unidade: "h" },
      { caminho: "naoEntregue.horasRemover", rotulo: "Tira o lead da fila do chip depois de", tipo: "numero", unidade: "h" },
      { caminho: "naoEntregue.janelaDias", rotulo: "Olha os envios dos últimos", tipo: "numero", unidade: "dias" },
      { caminho: "chipMudo.pausa", rotulo: "Pausar o chip mudo (além do aviso)", tipo: "booleano" },
    ],
  },
  {
    id: "avancado",
    titulo: "Avançado",
    descricao: "Para quem já opera o motor: fuso, rampas próprias por chip, imagem da abertura, quem pode receber e lembretes.",
    chaves: ["fusoMinutos", "rampasPorChip", "aberturaMidiaId", "filtroAbertura", "lembretes"],
    campos: [
      { caminho: "fusoMinutos", rotulo: "Fuso em relação a UTC", tipo: "numero", unidade: "min" },
      { caminho: "rampasPorChip", rotulo: "Rampa própria por chip (nome do chip: conversas por dia)", tipo: "mapaDeListas" },
      { caminho: "aberturaMidiaId", rotulo: "Imagem da abertura (a mensagem vai como legenda)", tipo: "midia" },
      { caminho: "filtroAbertura.porChipOrigem", rotulo: "Lead só sai pelo chip de origem dele", tipo: "booleano" },
      { caminho: "filtroAbertura.classes", rotulo: "Só estas classes de lead (vazio = todas)", tipo: "listaDeTextos" },
      { caminho: "filtroAbertura.semPendenciaOperador", rotulo: "Pular lead com pendência do operador", tipo: "booleano" },
      { caminho: "filtroAbertura.camposIguais", rotulo: "Só leads com estes campos (campo = valor)", tipo: "mapaDeTextos" },
      { caminho: "lembretes.tetoDia", rotulo: "Máximo de lembretes por dia (tipo = quantos)", tipo: "mapaDeNumeros" },
      { caminho: "lembretes.relevancia", rotulo: "Lembrete só para leads com (campo, valor ou mínimo)", tipo: "condicoes" },
    ],
  },
];

export function lerCaminho(objeto: unknown, caminho: string): unknown {
  return caminho.split(".").reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), objeto);
}

/** Cópia do objeto com `valor` gravado no caminho (cria os objetos do meio). */
export function gravarCaminho<T>(objeto: T, caminho: string, valor: unknown): T {
  const [k, ...resto] = caminho.split(".");
  const atual = (objeto ?? {}) as Record<string, unknown>;
  return { ...atual, [k!]: resto.length ? gravarCaminho(atual[k!], resto.join("."), valor) : valor } as T;
}

/** O ritmo com as chaves da seção devolvidas ao recomendado. */
export function voltarSecaoAoRecomendado(ritmo: Ritmo, secao: SecaoDoRitmo): Ritmo {
  const novo = { ...ritmo };
  for (const chave of secao.chaves) (novo as Record<string, unknown>)[chave] = structuredClone(RITMO_PADRAO[chave]);
  return novo;
}

const ordenado = (_k: string, v: unknown) =>
  v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v;
export const mesmoValor = (a: unknown, b: unknown) => JSON.stringify(a, ordenado) === JSON.stringify(b, ordenado);

/** O ritmo parcial do PATCH: só as chaves de topo que mudaram em relação ao gravado. */
export function ritmoAlterado(original: Ritmo, editado: Ritmo): Partial<Ritmo> {
  const mudou: Record<string, unknown> = {};
  for (const chave of Object.keys(editado) as (keyof Ritmo)[]) {
    if (!mesmoValor(original[chave], editado[chave])) mudou[chave] = editado[chave];
  }
  return mudou as Partial<Ritmo>;
}

/** "08:00–19:00" de um bloco em minutos. */
export const horaDoMinuto = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

/** O recomendado de um campo, em texto curto ("10–18 min", "08:00–19:00", "sim"). */
export function textoDoRecomendado(campo: CampoDoRitmo, sim: string, nao: string, igualAComum: string, nenhum = "—"): string {
  const v = lerCaminho(RITMO_PADRAO, campo.caminho);
  const u = campo.unidade ? ` ${campo.unidade}` : "";
  switch (campo.tipo) {
    case "midia":
      return v ? String(v) : nenhum;
    case "listaDeTextos":
    case "condicoes":
      return (v as unknown[]).length ? (v as unknown[]).map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(", ") : nenhum;
    case "mapaDeListas":
    case "mapaDeTextos":
    case "mapaDeNumeros": {
      const m = Object.entries(v as Record<string, unknown>);
      return m.length ? m.map(([k, x]) => `${k}: ${Array.isArray(x) ? x.join(", ") : String(x)}`).join("; ") : nenhum;
    }
    case "booleano":
      return v ? sim : nao;
    case "percentual":
      return `${Math.round(Number(v) * 1000) / 10}${u}`;
    case "faixa":
    case "faixaOuComum": {
      if (v === null) return igualAComum;
      const f = v as { min: number; max: number };
      return `${f.min}–${f.max}${u}`;
    }
    case "listaDeFaixas":
      return (v as { min: number; max: number }[]).map((f) => `${f.min}–${f.max}`).join(", ") + u;
    case "listaDeNumeros":
      return (v as number[]).join(", ");
    case "blocos": {
      const b = v as { inicio: number; fim: number }[];
      return b.length ? b.map((x) => `${horaDoMinuto(x.inicio)}–${horaDoMinuto(x.fim)}`).join(", ") : nao;
    }
    case "datas":
      return `${(v as string[]).length}`;
    default:
      return `${v as number}${u}`;
  }
}
