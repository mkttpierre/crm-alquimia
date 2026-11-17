/**
 * Motor de disparo: uma volta por organização ligada, chamada pelo cron
 * `/api/v1/cron/disparo` a cada minuto.
 *
 * Em cada volta, cada chip manda NO MÁXIMO uma mensagem (como no motor de uma organização):
 * primeiro o que venceu na fila (toques, respostas), depois a próxima abertura,
 * se a vez do chip chegou. Antes de sair, tudo é conferido de novo — lead
 * bloqueado ou encerrado, lead que escreveu, limite de respostas automáticas,
 * verificador de texto. Depois de sair, o próximo passo da cadência entra na
 * fila.
 *
 * Única exceção (ritmo humano): partes seguidas de um MESMO funil para o MESMO lead — a sequência do
 * operador (`/funil-valores`), a resposta/funil do atendimento (`tabela_valores:seq`, `da_parada`) e as partes de um toque
 * do kit — são seguidas DENTRO da volta, uma após a outra, no horário de cada uma (`seguirSequencia`: 3 s depois de
 * texto/imagem, 29-34 s depois de áudio), sem o intervalo mínimo entre envios do chip e com TODAS as outras travas.
 * A abertura com prévia também segue suas partes; aberturas simples e toques entre dias mantêm o ritmo normal.
 *
 * "Sair" tem dois sentidos e a diferença é a TRAVA (`lib/disparo/trava.ts`):
 * com as duas chaves viradas, `enviarReal` é chamado; sem elas, o envio só
 * ganha o estado `simulado` e nada fala com canal nenhum. O motor não conhece
 * o banco: tudo passa por `RepositorioDisparo`, e o teste da trava roda o motor
 * inteiro contra um repositório em memória com um `enviarReal` espião.
 */
import { ehRespostaAutomatica } from "./resposta-automatica";
import { semWhatsapp } from "./sem-whatsapp";
import { avaliarHumano, type SituacaoHumana } from "./atendimento/humano";
import { TIPO_RETORNO_RESERVA } from "./atendimento/retorno-reserva";
import { cadenciaPorId, ehCampanha, ehCampanhaDaJanela, horaDoPasso, passoDoTipo, proximoPasso, textoDoLembrete, tiposDeProspeccao, type Passo } from "./cadencia";
import { bateCondicao, type ConfigDisparo, type Ritmo } from "./config";
import {
  abrirDia,
  aposMensagemNova,
  type Chip,
  chipNaVolta,
  type Contagem,
  type EstadoEnvio,
  freioDoChip,
  type OrigemEnvio,
  podeEnviar,
  sinalDeRestricao,
} from "./fila";
import { ehEnvioAgendadoDoKit, ehEnvioNovoDoKit, ehOfertaDoMetodo, ehPosPagamentoDoMetodo } from "./kit-followup";
import { fimDaQuarentena, podeTocar } from "./quarentena";
import { encerraCadencia, lerResposta, motivoParaNaoContatar, naoContatarMarcado, podeResponderSozinho, telefoneFixo } from "./regras";
import { blocosDoDia, inicioDoDia, MIN, relogio as relogioLocal, type Sortear } from "./ritmo";
import { avaliarSaudeDoChip } from "./saude-job";
import type { DadosDaSaude, LinhaDaSaudeDoDia, SaudeGravada } from "./saude";
import { type EnvioDoChip, freioDeChipMudo } from "./sem-confirmacao";
import { type ChipComFilaPresa, filaPresaQueConta, motivoDoChipParado, PREFIXO_AVISO_FILA_PRESA, type SituacaoDoChip, textoDaFilaPresa } from "./fila-presa";
import { listasDoPasso, montar, slotsDoLead, verificarTexto, versaoDoDia } from "./textos";
import { dentroDaJanelaDeResposta, JANELA_RESPOSTA_PADRAO, proximaJanelaDeResposta } from "./janela-resposta";
import { temPartesSeguintes } from "./sequencia-partes";
import { destinoPermitido, envioRealLiberado, MOTIVO_ALLOWLIST, motivoDoSimulado } from "./trava";

/** As duas origens que saem em PARTES, na ordem: a resposta do atendimento e a sequência que o operador agendou. */
export type OrigemDeSequencia = Extract<OrigemEnvio, "auto" | "operador">;
const ehSequencia = (o: OrigemEnvio): o is OrigemDeSequencia => o === "auto" || o === "operador";

/**
 * Tempo máximo que uma volta fica seguindo sequências (`seguirSequencia`). O funil de valores, no ritmo humano de
 * 3 s e 29-34 s, dura ~1 min 25 s; passou disto, o resto fica para a volta seguinte (o cron roda a cada minuto), sempre
 * na ordem. A rota do cron usa este valor.
 */
export const ORCAMENTO_DA_SEQUENCIA_MS = 110_000;

/** Quantas partes seguintes uma volta segue, no máximo (a maior sequência tem 7): corta qualquer laço que não termina. */
const MAX_PARTES_POR_VOLTA = 30;

/**
 * Sequência do operador (`/funil-valores`, `origem = 'operador'`) parada por mais que isto — chip pausado, teto da
 * hora, motor desligado — não sai mais: ela foi pedida para uma conversa que andou, e sair horas depois, fora de
 * hora, é pior que não sair. Descarta a parte e o resto da fila do lead; o operador vê o motivo no painel.
 */
export const VALIDADE_DA_SEQUENCIA_MS = 30 * MIN;

/** Restrições da próxima abertura, lidas de `custom_fields` do lead. Campo ausente/null = sem restrição. */
export type FiltroDeAbertura = {
  /** Só leads com `chip_origem` = este nome de chip. */
  chipOrigem?: string | null;
  /** Só estas classes (`classe`). */
  classes?: string[] | null;
  /** Pula leads com `precisa_operador` = true. */
  semPendenciaOperador?: boolean;
  /** Campos de `custom_fields` que precisam ser iguais (comparação como texto). */
  camposIguais?: Record<string, string> | null;
  /**
   * Quarentena e frequência (`ritmo.quarentena`): o lead em quarentena, com abordagem fria recente ou com
   * mensagens demais sem resposta não é candidato. Ausente = não confere.
   */
  quarentena?: { cfg: Ritmo["quarentena"]; agora: Date } | null;
};

export type LeadDoDisparo = {
  id: string;
  nome: string | null;
  telefone: string | null;
  status: string;
  bloqueado: boolean;
  anonimizado: boolean;
  /** `crm_leads.custom_fields.disparo_grupo`: escolhe o modelo `tipo:grupo`. */
  grupo: string | null;
  /** `crm_leads.custom_fields`: slots do texto, escolha do modelo e relevância. */
  campos: Record<string, unknown>;
};

export type EnvioDaFila = {
  id: string;
  leadId: string;
  chipId: string | null;
  tipo: string;
  origem: OrigemEnvio;
  texto: string;
  /** Nome legível da mídia (o que o jsonb do atendimento chamou). Só para quem lê a fila. */
  midia: string | null;
  /** `media_library.id` da MESMA organização: o que de fato vai ao canal. null = só texto. */
  midiaId: string | null;
  enviarApos: Date;
  estado: EstadoEnvio;
  tentativas: number;
  criadoEm: Date;
  /**
   * Resposta decidida junto com um ponto de parada que pausa a conversa (o pacote
   * de fechamento, os links do site). A pausa que o próprio ponto pôs não a cancela.
   */
  daParada: boolean;
  /** "digitando/gravando" que o canal mostra logo antes deste envio (funil do operador, migration 0248). */
  presenca?: "nenhuma" | "digitando" | "gravando" | null;
  presencaMs?: number | null;
  /** Último motivo gravado na linha (o erro da tentativa anterior, por exemplo). Ausente = não lido. */
  motivo?: string | null;
};

/** Aviso ao celular do operador, na fila de saída `disparo_avisos_operador`. */
export type AvisoDaFila = {
  id: string;
  leadId: string;
  chipId: string | null;
  /** `channel_sessions.id` em que a lead conversa: o aviso só pode sair por ele. */
  canalId: string | null;
  destino: string;
  texto: string;
  enviarApos: Date;
  tentativas: number;
};

export type FimDoAviso = {
  estado: EstadoEnvio;
  motivo?: string | null;
  enviadoEm?: Date | null;
  externalId?: string | null;
  tentativas?: number;
  enviarApos?: Date;
};

export type NovoEnvio = {
  leadId: string;
  chipId: string | null;
  tipo: string;
  origem: OrigemEnvio;
  texto: string;
  midiaId?: string | null;
  enviarApos: Date;
  estado?: EstadoEnvio;
  motivo?: string;
};

export type FimDoEnvio = {
  estado: EstadoEnvio;
  motivo?: string | null;
  enviadoEm?: Date | null;
  externalId?: string | null;
  tentativas?: number;
  enviarApos?: Date;
};

export type PatchDoChip = Partial<
  Pick<Chip, "estado" | "proximoEnvioEm" | "diaRampa" | "enviosDesdePausa" | "pausaACada" | "pausadoAte" | "saude" | "saudeMotivo" | "saudeCalculadaEm">
>;

/** Tudo que o motor precisa do banco. Toda chamada é escopada por organização. */
export interface RepositorioDisparo {
  configsLigadas(): Promise<ConfigDisparo[]>;
  /** Reserva com data futura: verifica cancelamentos também antes de vencer. */
  retornosPendentes?(org: string): Promise<EnvioDaFila[]>;
  tomarTravaDoLead?(org: string, leadId: string, dono: string): Promise<boolean>;
  soltarTravaDoLead?(org: string, leadId: string, dono: string): Promise<void>;
  conferirRetornoReserva?(org: string, envio: EnvioDaFila, agora: Date): Promise<string | null>;
  retornoReservaEnviado?(org: string, envio: EnvioDaFila, agora: Date, modo: "simulado" | "real"): Promise<void>;
  chipsDaVolta(org: string): Promise<Chip[]>;
  contagem(org: string, chipId: string, agora: Date, fusoMinutos: number, tiposNovos: string[]): Promise<Contagem>;
  mandouDesde(org: string, chipId: string, desde: Date, ate: Date): Promise<boolean>;
  /** Quem está no comando do lead (force_human, conversa pausada, dono humano). Ver `atendimento/humano.ts`. */
  situacaoHumana(org: string, leadId: string): Promise<SituacaoHumana>;
  /** Atualiza o chip. Com `somenteSeVezAte`, só grava se a vez dele não passou desse instante (reserva atômica). */
  atualizarChip(org: string, chipId: string, patch: PatchDoChip, somenteSeVezAte?: Date | null): Promise<boolean>;
  /** `filtro`: quem pode sair agora por este chip (ver `filtroAbertura` no ritmo); ausente = qualquer lead da etapa. */
  proximoLeadParaAbertura(org: string, fonteStageId: string, filtro?: FiltroDeAbertura): Promise<LeadDoDisparo | null>;
  /** null = já existia (índice único): outra volta planejou o mesmo passo. */
  enfileirar(org: string, envio: NovoEnvio): Promise<EnvioDaFila | null>;
  midiaDaAberturaValida?(org: string, id: string): Promise<boolean>;
  enfileirarAberturaComPartes?(org: string, envios: NovoEnvio[]): Promise<EnvioDaFila | null>;
  estadoParteAbertura?(org: string, leadId: string, tipo: string): Promise<EstadoEnvio | null>;
  vencidos(org: string, chipId: string, agora: Date, limite: number): Promise<EnvioDaFila[]>;
  lembretesVencidos(org: string, agora: Date, limite: number): Promise<EnvioDaFila[]>;
  /**
   * pendente → enviando, atômico. false = outra volta pegou. `dono` (E5): quem reservou (a volta); a marca de canal e o
   * desfecho dados com o mesmo `dono` só valem enquanto a reserva for dele.
   */
  reservar(org: string, envioId: string, dono?: string): Promise<boolean>;
  /**
   * Grava o desfecho. Com `somenteSeEstado`, só grava se a linha ainda estiver nesse estado (o `enviado` só fecha a
   * linha que esta volta reservou: se a varredura de `enviando` presos já a fechou, nada é sobrescrito). Com `dono`, só
   * grava se a reserva ainda for daquela volta (a varredura pode ter devolvido a linha e outra volta, reservado de novo).
   */
  finalizar(org: string, envioId: string, fim: FimDoEnvio, somenteSeEstado?: EstadoEnvio, dono?: string): Promise<void>;
  lead(org: string, leadId: string): Promise<LeadDoDisparo | null>;
  /** Mensagens que o lead mandou depois de `desde` (só as de gente, não as automáticas). */
  respostasDesde(org: string, leadId: string, desde: Date): Promise<string[]>;
  /**
   * Origem dos últimos envios que saíram para o lead, do mais novo ao mais
   * antigo, UMA POR DECISÃO: as partes de uma resposta (o funil de valores são
   * 7) contam como uma, e as partes da mesma decisão de `envio` não entram —
   * o limite de automáticas seguidas é por decisão, como no atendimento.
   */
  origensRecentes(org: string, leadId: string, limite: number, envio: { id: string; criadoEm: Date }): Promise<string[]>;
  /** `poupaParada`: não cancela as respostas `da_parada` (o pacote já decidido). `origem`: só as pendentes desta origem. */
  marcarSemWhatsapp?(org: string, leadId: string): Promise<void>;
  cancelarPendentesDoLead(org: string, leadId: string, motivo: string, poupaParada?: boolean, origem?: OrigemEnvio, poupaRetorno?: boolean): Promise<number>;
  /** Há resposta automática do lead ainda por sair (pendente ou enviando)? O aviso ao operador espera o pacote. */
  autoEmAberto(org: string, leadId: string): Promise<boolean>;
  /** Avisos ao operador vencidos que saem por este chip, do mais antigo ao mais novo. */
  avisosVencidos(org: string, chipId: string, agora: Date, limite: number): Promise<AvisoDaFila[]>;
  /** pendente → enviando, atômico. false = outra volta pegou. */
  reservarAviso(org: string, avisoId: string): Promise<boolean>;
  finalizarAviso(org: string, avisoId: string, fim: FimDoAviso): Promise<void>;
  /**
   * Resposta automática ainda em aberto para o lead ANTES desta (pendente com
   * hora anterior, ou presa em `enviando`). Uma parte de sequência só sai
   * depois da anterior: sem isto, a parte 2 venceria enquanto a 1 espera nova
   * tentativa, e o funil de valores chegaria fora de ordem.
   */
  autoEmAbertoAntes(org: string, leadId: string, envioId: string, antesDe: Date, origem?: OrigemDeSequencia): Promise<boolean>;
  /**
   * Empurra as partes pendentes do lead marcadas depois de `depoisDe` em `ms`. Devolve quantas. `origem` diz de
   * qual sequência: a resposta automática (padrão) ou a do operador (`/funil-valores`); uma não mexe na outra.
   */
  adiarAutoDoLead(org: string, leadId: string, depoisDe: Date, ms: number, origem?: OrigemDeSequencia): Promise<number>;
  /**
   * Ritmo humano (opcionais: sem eles o motor entrega uma parte por volta, como antes). A próxima parte PENDENTE da
   * mesma sequência que `ref` (mesmo lead e chip, agendada junto: ver `sequencia-partes.ts`), a de menor `enviar_apos`,
   * vencida ou não. null = a sequência acabou.
   */
  proximaParteDaSequencia?(org: string, chipId: string, ref: EnvioDaFila): Promise<EnvioDaFila | null>;
  /** Anota o motivo numa parte que continua `pendente` (limite do chip segurando a sequência). Só grava se ainda estiver pendente. */
  anotarMotivoDaFila?(org: string, envioId: string, motivo: string): Promise<void>;
  /** Quantos envios deste tipo a organização já criou desde `desde` (para girar a versão do texto). */
  criadosDesde(org: string, tipo: string, desde: Date): Promise<number>;
  /** Quando o passo `tipo` saiu para o lead (null = não saiu). */
  saiuEm(org: string, leadId: string, tipo: string): Promise<Date | null>;
  /** Lembretes de um tipo já planejados (não cancelados) para vencer em [inicio, fim). Teto manual. */
  lembretesNoDia(org: string, tipo: string, inicio: Date, fim: Date): Promise<number>;
  /** Entrega o lembrete ao operador como tarefa (`crm_tasks`) na tela Tarefas. Devolve o id. */
  criarTarefa(org: string, t: TarefaDoLembrete): Promise<string>;

  // ---- Freios de saúde e quarentena (migration 0243). Opcionais: um repositório sem eles roda como antes. ----
  /** Linhas cruas para a conta de saúde do chip: aberturas dos últimos dias, respostas dos leads e eventos de conexão desde `desde`. */
  dadosDaSaude?(org: string, chipId: string, p: { agora: Date; desde: Date; janelaDias: number }): Promise<DadosDaSaude>;
  /** O que já está gravado para o chip no dia local `dia` (AAAA-MM-DD). */
  saudeDoDia?(org: string, chipId: string, dia: string): Promise<SaudeGravada | null>;
  gravarSaudeDoDia?(org: string, linha: LinhaDaSaudeDoDia): Promise<void>;
  sessaoConectada?(org: string, chipId: string): Promise<boolean>;
  tomarTravaDaClasse?(org: string, classe: string, dono: string): Promise<boolean>;
  soltarTravaDaClasse?(org: string, classe: string, dono: string): Promise<void>;
  aberturasDaClasseNoDia?(org: string, classe: string, desde: Date): Promise<number>;
  /** Mensagens do motor que saíram para o lead desde `desde` e depois da última resposta dele. */
  semRespostaDesde?(org: string, leadId: string, desde: Date): Promise<number>;
  /** Põe o lead em quarentena até `ate` (idempotente: o fim mais distante vence). */
  entrarEmQuarentena?(org: string, leadId: string, chipId: string | null, ate: Date): Promise<void>;
  /**
   * Estado atual da lead para o que o atendimento agenda com dias de antecedência (toques do kit, oferta do
   * Método, D7/D14): virou cliente, pagou o Método, a conversa pede o operador, quarentena em vigor.
   * Ausente = não confere (config antiga segue como antes).
   */
  situacaoDoKit?(org: string, leadId: string): Promise<SituacaoDoKit>;

  // ---- Travas da auditoria 3. Opcionais: um repositório sem elas roda como antes. ----
  /**
   * Trava por chip (A5): uma volta por chip de cada vez. O cron roda a cada minuto e a volta pode durar ~2 min seguindo
   * um funil; voltas sobrepostas liam a contagem do chip cada uma por si e furavam o intervalo mínimo e o máximo por hora.
   */
  tomarTravaDoChip?(org: string, chipId: string, dono: string, prazoMs: number): Promise<boolean>;
  soltarTravaDoChip?(org: string, chipId: string, dono: string): Promise<void>;
  /** Registra a volta da organização (`disparo_voltas`): a volta sem efeito não audita, mas fica visível. */
  registrarVolta?(org: string, v: VoltaRegistrada): Promise<void>;
  /** Alguma mensagem da organização saiu (enviada ou simulada, fora lembretes) desde `desde`? Para a parada silenciosa. */
  saiuDesde?(org: string, desde: Date): Promise<boolean>;
  /** Linhas `pendente` vencidas SEM chip (resposta de lead que nunca recebeu nada do motor): nenhum chip as pega. */
  semChip?(org: string, agora: Date, limite: number): Promise<EnvioDaFila[]>;
  /** Chip do motor pela conversa da lead (`conversations.channel_session_id` → `disparo_chips`). null = nenhum. */
  chipPelaConversa?(org: string, leadId: string): Promise<string | null>;
  /** Dá chip a uma linha ainda `pendente` e sem chip. */
  atribuirChip?(org: string, envioId: string, chipId: string): Promise<boolean>;
  /** Aviso ao operador na Central (`agent_inbox_items`). Devolve se criou (com `umaVezDesde`, não repete o título). */
  avisarCentral?(org: string, a: AvisoDaCentral): Promise<boolean>;
  /**
   * Marca a linha `enviando` com `MARCA_NO_CANAL` (no `motivo`) logo ANTES de chamar o canal: é o sinal que a varredura
   * lê. Lança se a linha não estiver mais `enviando` — ou, com `dono`, se a reserva não for mais desta volta —, e aí o
   * canal NÃO é chamado.
   */
  marcarNoCanal?(org: string, envioId: string, dono?: string): Promise<void>;
  /** Linhas `enviando` paradas desde antes de `antesDe` (a volta que as reservou morreu ou não gravou o desfecho). */
  enviandoPresos?(org: string, antesDe: Date, limite: number): Promise<EnvioPreso[]>;

  // ---- Chip mudo e fila presa (E3/E4). Opcionais: um repositório sem eles roda como antes. ----
  /** Envios REAIS do chip (`enviado`, com external_id) desde `desde`, do mais novo ao mais antigo, com o que a Evolution confirmou. */
  enviosRecentesDoChip?(org: string, chipId: string, desde: Date, limite: number): Promise<EnvioDoChip[]>;
  /** O aviso vivo da Central com esta chave: o aberto (se houver) e quando o último deles (aberto ou não) foi criado. */
  avisoVivo?(org: string, chave: ChaveDoAvisoVivo): Promise<{ aberto: AvisoVivo | null; ultimoEm: Date | null }>;
  /** Cria (nenhum aberto), atualiza no lugar (já há um aberto) ou fecha (`null`) o aviso vivo. `quando` = o instante da volta. */
  gravarAvisoVivo?(org: string, chave: ChaveDoAvisoVivo, aviso: { titulo: string; corpo: string; nivel: AvisoDaCentral["nivel"] } | null, quando: Date): Promise<void>;
  /** Todos os chips da organização (inclusive pausados e desligados) com o estado da conexão. Só leitura. */
  situacaoDosChips?(org: string): Promise<SituacaoDoChip[]>;
  /** Quantos envios `pendente` deste chip já venceram (fora lembretes) e o `enviar_apos` do mais antigo. Só leitura. */
  vencidosDoChip?(org: string, chipId: string, agora: Date): Promise<{ total: number; desde: Date | null }>;

  // ---- Conferência antes de reenviar (E2). Opcional: um repositório sem ela reenvia como antes. ----
  /**
   * Já há, na conversa da organização, saída para o contato do lead com este corpo (ou, `soMidia`, uma mídia) desde
   * `desde`? É o eco `fromMe` do WhatsApp (ou o espelho). null = respondeu e não achou; LANÇA quando não conseguiu
   * conferir (e aí o motor não reenvia nesta volta). Só leitura.
   */
  saidaNaConversa?(org: string, leadId: string, p: { texto: string; soMidia: boolean; desde: Date }): Promise<{ externalId: string | null; em: Date } | null>;
}

/**
 * Erro da tentativa anterior que PROVA que nada saiu (E2): o canal recusou (`evolution_4xx`), o número não tem
 * WhatsApp, ou o erro nasceu antes do canal (`disparo_*:` de `envio-real.ts`: trava, chip sem canal, mídia). Fora
 * disso — tempo esgotado, 5xx, queda de conexão, erro desconhecido ou motivo já sobrescrito — a mensagem pode ter saído.
 */
const ERRO_CERTO = /evolution_4\d\d\b|sem.?whatsapp|\bdisparo_[a-z_]+:/i;

export const MOTIVO_SAIU_NA_TENTATIVA_ANTERIOR = "a tentativa anterior deu erro, mas a mensagem saiu (achada na conversa): não reenviada";

/** O envio já foi tentado e o erro não prova que nada saiu: confere na conversa antes de chamar o canal de novo. */
export const precisaConferirAntesDeReenviar = (envio: Pick<EnvioDaFila, "tentativas" | "motivo">) =>
  envio.tentativas > 0 && !ERRO_CERTO.test(envio.motivo ?? "");

export type { SituacaoDoChip };

/**
 * Aviso da Central que é UM só enquanto o problema dura (chip mudo, fila presa): achado pelo começo fixo do título,
 * atualizado no lugar e fechado quando o problema some. `chipId`: o aviso é daquele chip (o prefixo já leva o nome).
 */
export type ChaveDoAvisoVivo = { prefixo: string; chipId?: string };
export type AvisoVivo = { id: string; titulo: string; corpo: string; criadoEm: Date };

/** Linha presa em `enviando`, com o que a varredura precisa para decidir sem reenviar às cegas. */
export type EnvioPreso = EnvioDaFila & { externalId: string | null; motivo: string | null; reservadoEm: Date };

/**
 * Gravado no `motivo` da linha logo antes da chamada ao canal. Linha presa em `enviando` COM esta marca e sem
 * external_id pode ter saído (a volta morreu durante ou depois da chamada): nunca é reenviada, vai para o operador.
 */
export const MARCA_NO_CANAL = "chamando o canal (desfecho ainda não gravado)";

export type VoltaRegistrada = { inicio: Date; fim: Date; duracaoMs: number; efeito: boolean; resultado: Record<string, unknown> };

/** Aviso do MOTOR ao operador, na Central. `umaVezDesde`: já existe aviso com o mesmo título desde então = não cria. */
export type AvisoDaCentral = { titulo: string; corpo: string; nivel: "info" | "warn" | "critical"; leadId?: string | null; umaVezDesde?: Date };

export type SituacaoDoKit = {
  /** Trilha de cliente da config do atendimento (`clientes.trilhas`): já comprou. */
  cliente: boolean;
  /** `disparo_conversas.dados.metodo.etapa = "pago"` ou marca VIP gravada. */
  metodoPago: boolean;
  /** `disparo_conversas.precisa_operador`. */
  precisaOperador: boolean;
  /** `disparo_quarentena.ate` (null = nunca entrou). */
  quarentenaAte: Date | null;
};

export type TarefaDoLembrete = { leadId: string; titulo: string; descricao: string; prazo: Date };

export type EnvioReal = (p: {
  config: ConfigDisparo;
  chipId: string;
  lead: LeadDoDisparo;
  texto: string;
  /** `media_library.id` da organização: com ele o texto vira legenda (ou nada, no áudio). */
  midiaId: string | null;
  /** "digitando/gravando" antes do envio. Ausente = nenhuma. */
  presenca?: { tipo: "digitando" | "gravando"; ms: number } | null;
}) => Promise<{ externalId: string | null }>;

/**
 * Leva o aviso ao celular do operador pelo chip `chipId` (o da conversa). Mesmas
 * travas do `EnvioReal`: modo real, DISPARO_REAL_LIBERADO=sim e allowlist.
 */
export type EnvioDeAviso = (p: {
  config: ConfigDisparo;
  chipId: string;
  /** Sessão de canal esperada; se o chip estiver ligado a outra, o envio é recusado. */
  canalId: string | null;
  destino: string;
  texto: string;
}) => Promise<{ externalId: string | null }>;

/**
 * O que o motor precisa para seguir uma sequência do operador DENTRO da volta, no horário de cada parte: o relógio e
 * a espera. Fora do teste, `relogio = () => new Date()` e `dormir` é um `setTimeout`. Sem isto (qualquer outro
 * chamador do motor) a sequência sai uma parte por volta, como antes.
 */
export type SequenciaNaVolta = {
  relogio: () => Date;
  dormir: (ms: number) => Promise<void>;
  /** Tempo máximo que a volta gasta seguindo sequências (`ORCAMENTO_DA_SEQUENCIA_MS`). */
  orcamentoMs: number;
};

export type DepsDoMotor = {
  repo: RepositorioDisparo;
  agora: Date;
  ambiente: Record<string, string | undefined>;
  sortear: Sortear;
  enviarReal: EnvioReal;
  enviarAviso: EnvioDeAviso;
  sequencia?: SequenciaNaVolta;
  /** Quem é esta volta, para a trava por chip. Ausente = gerado a cada volta. */
  dono?: string;
};

/**
 * Prazo da trava por chip (A5): a volta segura o chip do começo da passada até acabar de seguir a sequência
 * (`ORCAMENTO_DA_SEQUENCIA_MS` + a última chamada ao canal). Se a volta morrer, a trava vence sozinha.
 */
export const TRAVA_DO_CHIP_MS = 4 * 60 * 1000;

export type ResumoDaOrg = {
  organizationId: string;
  modo: "simulado" | "real";
  motivoSimulado: string | null;
  chips: { chipId: string; resultado: string }[];
  lembretes: number;
  /** Avisos ao celular do operador entregues (ou simulados) nesta volta. */
  avisos: number;
  saidos: number;
  simulados: number;
  enviados: number;
  cancelados: number;
  /** Barrados pela allowlist `DISPARO_SO_PARA` (terceira trava, opcional). */
  bloqueadosAllowlist: number;
  falhas: number;
  /** Erro que interrompeu a passada desta organização (as outras seguem). */
  erro?: string;
  /** Envios que SAÍRAM mas cujo registro no banco falhou (a linha ficou `enviando`; a varredura a encerra sem reenviar). */
  registroFalhou?: string[];
};

export type ResumoDisparo = { organizacoes: ResumoDaOrg[]; efeito: boolean };

export async function rodarDisparo(deps: DepsDoMotor): Promise<ResumoDisparo> {
  const relogio = deps.sequencia?.relogio ?? (() => deps.agora);
  const inicio = relogio();
  const dono = deps.dono ?? `volta:${deps.agora.toISOString()}:${Math.random().toString(36).slice(2, 10)}`;
  const configs = await deps.repo.configsLigadas();
  const organizacoes: ResumoDaOrg[] = [];
  const seguir: Seguir[] = [];
  for (const config of configs) organizacoes.push(await voltaDaOrg(config, deps, seguir, dono));
  // Só depois da passada normal de TODOS os chips: seguir uma sequência leva até o orçamento da volta, e não pode
  // atrasar o envio de outro chip (nem de outra organização) que já estava na vez. A trava do chip fica com esta volta
  // até a sequência dele acabar.
  if (deps.sequencia && seguir.length) {
    const prazo = deps.sequencia.relogio().getTime() + deps.sequencia.orcamentoMs;
    await Promise.all(seguir.map((s) => seguirSequencia(s, prazo).finally(() => soltarChip(s.ctx, s.chip.id))));
  }
  const efeitoDa = (o: ResumoDaOrg) => o.saidos + o.cancelados + o.falhas + o.lembretes + o.avisos > 0;
  const efeito = organizacoes.some(efeitoDa);
  // A5: toda volta fica registrada por organização (duração e resultado por chip), com ou sem efeito.
  if (deps.repo.registrarVolta) {
    const fim = relogio();
    for (const o of organizacoes) {
      await semLancar(() =>
        deps.repo.registrarVolta!(o.organizationId, {
          inicio,
          fim,
          duracaoMs: Math.max(0, fim.getTime() - inicio.getTime()),
          efeito: efeitoDa(o),
          resultado: { ...o },
        }),
      );
    }
  }
  return { organizacoes, efeito };
}

async function soltarChip(ctx: Ctx, chipId: string): Promise<void> {
  const repo = ctx.deps.repo;
  if (repo.soltarTravaDoChip) await semLancar(() => repo.soltarTravaDoChip!(ctx.config.organizationId, chipId, ctx.dono));
}

/** Uma sequência que acabou de mandar uma parte (`ref`) e pode ter partes seguintes para seguir na mesma volta. */
type Seguir = { chip: Chip; ref: EnvioDaFila; chamadaEm: Date; ctx: Ctx };

async function voltaDaOrg(config: ConfigDisparo, deps: DepsDoMotor, seguir: Seguir[], dono: string): Promise<ResumoDaOrg> {
  const org = config.organizationId;
  const real = envioRealLiberado(config, deps.ambiente);
  const resumo: ResumoDaOrg = {
    organizationId: org,
    modo: real ? "real" : "simulado",
    motivoSimulado: motivoDoSimulado(config, deps.ambiente),
    chips: [],
    lembretes: 0,
    avisos: 0,
    saidos: 0,
    simulados: 0,
    enviados: 0,
    cancelados: 0,
    bloqueadosAllowlist: 0,
    falhas: 0,
  };
  const ctx: Ctx = { config, deps, real, resumo, seguir, dono };
  // A2: um erro desta organização (banco fora, consulta que falhou) fica no resumo dela; as outras organizações rodam.
  try {
    await passadaDaOrg(ctx);
  } catch (e) {
    resumo.erro = (e as Error).message.slice(0, 300);
    resumo.falhas++;
  }
  return resumo;
}

async function passadaDaOrg(ctx: Ctx): Promise<void> {
  const { config, deps, real, resumo } = ctx;
  const { repo, agora } = deps;
  const org = config.organizationId;

  await varrerEnviandoPresos(ctx);
  await resolverSemChip(ctx);

  // Mesmo antes da data: compra, recusa ou humano encerram a reserva sem esperar ela vencer.
  for (const envio of await repo.retornosPendentes?.(org) ?? []) {
    const motivo = repo.conferirRetornoReserva ? await repo.conferirRetornoReserva(org, envio, agora) : "conferência do retorno indisponível";
    if (motivo) {
      await repo.finalizar(org, envio.id, { estado: "cancelado", motivo }, "pendente");
      resumo.cancelados++;
    }
  }

  // Lembretes ao operador (D4 áudio, D10 ligação): não usam chip nem ritmo, e
  // NUNCA vão para o canal — em nenhum modo. Viram tarefa na tela Tarefas
  // (`crm_tasks`, ligada ao lead); o envio guarda o id da tarefa.
  for (const l of await repo.lembretesVencidos(org, agora, 20)) {
    if (!(await repo.reservar(org, l.id, ctx.dono))) continue;
    const lead = await repo.lead(org, l.leadId);
    const bloqueio = lead ? motivoParaNaoContatar(lead) : "lead não existe mais";
    if (!lead || bloqueio) {
      await repo.finalizar(org, l.id, { estado: "cancelado", motivo: bloqueio }, "enviando", ctx.dono);
      resumo.cancelados++;
      continue;
    }
    try {
      const passo = passoDoTipo(cadenciaPorId(config.cadencia), l.tipo);
      const quem = lead.nome ?? lead.telefone ?? "o lead";
      const acao = passo?.lembrete === "audio" ? "gravar áudio" : "ligar";
      const tarefa = await repo.criarTarefa(org, {
        leadId: l.leadId,
        titulo: `${l.tipo.toUpperCase()}: ${acao} para ${quem}${real ? "" : " (ensaio)"}`.slice(0, 200),
        descricao: l.texto,
        prazo: l.enviarApos,
      });
      await repo.finalizar(org, l.id, {
        estado: real ? "enviado" : "simulado",
        enviadoEm: agora,
        externalId: `crm_task:${tarefa}`,
        motivo: "lembrete entregue como tarefa ao operador",
      }, "enviando", ctx.dono);
      resumo.lembretes++;
    } catch (e) {
      await repo.finalizar(org, l.id, {
        estado: "pendente",
        motivo: `tarefa não criada: ${(e as Error).message.slice(0, 150)}`,
        enviarApos: new Date(agora.getTime() + 10 * MIN),
      }, "enviando", ctx.dono);
      resumo.falhas++;
    }
  }

  const chips = await repo.chipsDaVolta(org);
  for (const chip of chips) {
    // A2: o erro de um chip fica no resultado dele; os outros chips rodam (a linha reservada já voltou à fila).
    // A5: só uma volta por chip; a que acha o chip trancado o deixa para a outra.
    let resultado: string;
    let tranquei = false;
    try {
      if (repo.tomarTravaDoChip && !(await repo.tomarTravaDoChip(org, chip.id, ctx.dono, TRAVA_DO_CHIP_MS))) {
        resultado = "outra volta está com este chip (trava): fica para ela";
      } else {
        tranquei = Boolean(repo.tomarTravaDoChip);
        resultado = await voltaDoChip(chip, ctx);
      }
    } catch (e) {
      resumo.falhas++;
      resultado = `erro na volta do chip: ${(e as Error).message.slice(0, 200)}`;
    }
    resumo.chips.push({ chipId: chip.id, resultado });
    // Chip que vai seguir uma sequência continua trancado até ela acabar (solto em `rodarDisparo`).
    if (tranquei && !ctx.seguir.some((s) => s.ctx === ctx && s.chip.id === chip.id)) await soltarChip(ctx, chip.id);
  }

  await avisarParadaSilenciosa(ctx, chips);
  await avisarFilaPresa(ctx);
}

/**
 * E4: envios vencidos parados em chip que não manda (vermelho, pausado, desligado, conexão caída). Só leitura e UM
 * aviso por organização na Central, regravado só quando o texto muda e fechado quando a fila anda. Nunca move a fila
 * de chip. Ver `fila-presa.ts`.
 */
async function avisarFilaPresa(ctx: Ctx): Promise<void> {
  const { config, deps, real } = ctx;
  const { repo, agora } = deps;
  const org = config.organizationId;
  if (!repo.situacaoDosChips || !repo.vencidosDoChip || !repo.avisoVivo || !repo.gravarAvisoVivo) return;
  const presos: ChipComFilaPresa[] = [];
  for (const s of await repo.situacaoDosChips(org)) {
    const motivo = motivoDoChipParado(s, real);
    if (!motivo) continue;
    const v = await repo.vencidosDoChip(org, s.id, agora);
    if (v.total > 0 && v.desde) presos.push({ nome: s.nome, motivo, total: v.total, desde: v.desde });
  }
  const chave = { prefixo: PREFIXO_AVISO_FILA_PRESA };
  const { aberto } = await repo.avisoVivo(org, chave);
  const contam = filaPresaQueConta(presos, agora);
  if (!contam.length) {
    if (aberto) await repo.gravarAvisoVivo(org, chave, null, agora);
    return;
  }
  const texto = textoDaFilaPresa(contam, config.ritmo.fusoMinutos);
  if (aberto && aberto.titulo === texto.titulo && aberto.corpo === texto.corpo) return;
  await repo.gravarAvisoVivo(org, chave, { ...texto, nivel: "warn" }, agora);
}

/**
 * Parada silenciosa: uma organização ficou 3 dias sem enviar nada (etapa de origem sem lead elegível, cadência acabada, o único
 * chip com fila vermelho) e ninguém soube — a volta sem efeito não audita e a saída do cron vai para /dev/null. Num dia
 * útil (segunda a sexta, não feriado), com a janela de prospecção aberta há `validade.paradaSilenciosaHoras` e nada
 * saído da organização desde a meia-noite, abre UM aviso na Central por dia, com o motivo de cada chip.
 */
async function avisarParadaSilenciosa(ctx: Ctx, chips: Chip[]): Promise<void> {
  const { config, deps, resumo } = ctx;
  const { repo, agora } = deps;
  const ritmo = config.ritmo;
  if (!repo.avisarCentral || !repo.saiuDesde) return;
  if (resumo.saidos + resumo.lembretes + resumo.avisos > 0) return;
  const r = relogioLocal(agora, ritmo.fusoMinutos);
  if (r.diaSemana === 0 || r.diaSemana === 6) return;
  const blocos = blocosDoDia(agora, ritmo);
  const minutosDeJanela = blocos.reduce((t, b) => t + Math.max(0, Math.min(r.minuto, b.fim) - b.inicio), 0);
  if (minutosDeJanela < ritmo.validade.paradaSilenciosaHoras * 60) return;
  const hoje = inicioDoDia(agora, ritmo.fusoMinutos);
  if (await repo.saiuDesde(config.organizationId, hoje)) return;

  const nome = (id: string) => chips.find((c) => c.id === id)?.nome ?? id.slice(0, 8);
  const linhas = resumo.chips.map((c) => {
    const chip = chips.find((x) => x.id === c.chipId);
    const extra = chip?.saude === "vermelho" && chip.saudeMotivo ? ` (${chip.saudeMotivo})` : "";
    return `• ${nome(c.chipId)}: ${c.resultado}${extra}`;
  });
  const motivos: string[] = [];
  if (!chips.length) motivos.push("nenhum chip ativo ou em rampa");
  else if (chips.every((c) => !chipNaVolta(c, agora).ok)) motivos.push("todos os chips estão parados (saúde vermelha, pausa ou desligado): só o operador os devolve");
  if (resumo.chips.some((c) => /nenhum lead pronto/.test(c.resultado))) motivos.push("a etapa de origem não tem lead elegível para abrir (confira o filtro de abertura: classes, chip de origem, pendência do operador)");
  if (resumo.chips.some((c) => /sem etapa de origem/.test(c.resultado))) motivos.push("não há etapa de origem configurada para as aberturas");
  if (resumo.erro) motivos.push(`erro na volta: ${resumo.erro}`);
  if (!motivos.length) motivos.push("nenhum toque ou resposta na fila e nenhuma abertura possível agora");

  await repo.avisarCentral(config.organizationId, {
    titulo: `Disparo parado hoje (${r.data}): nada saiu`,
    corpo: [
      `O motor está ligado, a janela de envio está aberta há ${Math.floor(minutosDeJanela / 60)} h e nenhuma mensagem saiu hoje.`,
      `Motivo: ${motivos.join("; ")}.`,
      "Chips na última volta:",
      ...linhas,
    ].join("\n"),
    nivel: "warn",
    umaVezDesde: hoje,
  });
}

type Ctx = { config: ConfigDisparo; deps: DepsDoMotor; real: boolean; resumo: ResumoDaOrg; seguir: Seguir[]; dono: string; prazoSequencia?: number };

/**
 * Linhas presas em `enviando` (A1): a volta que as reservou morreu (restart, crash, erro não tratado) ou não conseguiu
 * gravar o desfecho. Presas, travavam a lead para sempre (`autoEmAbertoAntes` segura as partes seguintes,
 * `autoEmAberto` os avisos, `emAberto` o reagendamento). Nunca reenvia às cegas:
 *  - com external_id: o canal aceitou → `enviado`;
 *  - sem a marca de chamada ao canal: a volta parou antes dele → volta à fila (as validades seguem valendo);
 *  - com a marca e sem external_id: PODE ter saído → `falhou`, o resto da mesma sequência cancelado e o operador
 *    avisado na Central para conferir a conversa.
 */
async function varrerEnviandoPresos(ctx: Ctx): Promise<void> {
  const { repo, agora } = ctx.deps;
  const org = ctx.config.organizationId;
  if (!repo.enviandoPresos) return;
  const antesDe = new Date(agora.getTime() - ctx.config.ritmo.validade.enviandoPresoMin * MIN);
  for (const p of await repo.enviandoPresos(org, antesDe, 50)) {
    if (p.externalId) {
      await repo.finalizar(org, p.id, { estado: "enviado", enviadoEm: p.reservadoEm, motivo: "fechado pela varredura: o canal aceitou (external_id), só o registro faltou" }, "enviando");
      continue;
    }
    if (p.motivo !== MARCA_NO_CANAL) {
      await repo.finalizar(org, p.id, { estado: "pendente", motivo: "devolvido pela varredura: a volta parou antes de chamar o canal" }, "enviando");
      continue;
    }
    const motivo = "pode ter saído: a volta parou durante a chamada ao canal e o desfecho não foi gravado (não reenviado)";
    await repo.finalizar(org, p.id, { estado: "falhou", motivo }, "enviando");
    if (ehSequencia(p.origem)) await repo.cancelarPendentesDoLead(org, p.leadId, "parte anterior pode ter saído sem registro (confira)", false, p.origem);
    ctx.resumo.falhas++;
    await repo.avisarCentral?.(org, {
      titulo: "Disparo: mensagem pode ter saído sem registro, confira",
      corpo: `A mensagem ${p.tipo} para esta lead ficou presa em "enviando" desde ${p.reservadoEm.toISOString()}: a volta do motor parou durante a chamada ao WhatsApp. Confira na conversa se ela chegou; o motor não a reenvia${ehSequencia(p.origem) ? " e cancelou o resto da sequência" : ""}.`,
      nivel: "warn",
      leadId: p.leadId,
    });
  }
}

export const MOTIVO_SEM_CHIP = "sem chip para responder: a lead não conversa por nenhum chip do motor (responda na mão)";

/**
 * Linhas vencidas SEM chip (C2): `vencidos` filtra por chip, então elas nunca saíam — e seguravam para sempre os avisos
 * ao celular do operador (`autoEmAberto`). Ganham o chip da conversa da lead; sem conversa num chip do motor, são
 * canceladas e o operador é avisado na Central (uma vez por lead).
 */
async function resolverSemChip(ctx: Ctx): Promise<void> {
  const { repo, agora } = ctx.deps;
  const org = ctx.config.organizationId;
  if (!repo.semChip || !repo.chipPelaConversa || !repo.atribuirChip) return;
  const avisados = new Set<string>();
  for (const e of await repo.semChip(org, agora, 50)) {
    const chipId = await repo.chipPelaConversa(org, e.leadId);
    if (chipId) {
      await repo.atribuirChip(org, e.id, chipId);
      continue;
    }
    if (!(await repo.reservar(org, e.id, ctx.dono))) continue;
    await repo.finalizar(org, e.id, { estado: "cancelado", motivo: MOTIVO_SEM_CHIP }, "enviando", ctx.dono);
    ctx.resumo.cancelados++;
    if (avisados.has(e.leadId)) continue;
    avisados.add(e.leadId);
    await repo.avisarCentral?.(org, {
      titulo: "Disparo: resposta sem chip, responda na mão",
      corpo: `Havia mensagem automática para esta lead (${e.tipo}) sem chip por onde sair: ela não conversa por nenhum chip do motor. A fila dela foi cancelada; responda pela tela de conversas.`,
      nivel: "warn",
      leadId: e.leadId,
    });
  }
}

async function voltaDoChip(chip: Chip, ctx: Ctx): Promise<string> {
  const { config, deps } = ctx;
  const { repo, agora, sortear } = deps;
  const org = config.organizationId;
  const ritmo = config.ritmo;

  if (chip.saude === "vermelho") {
    await avaliarSaudeDoChip(repo, config, chip, agora);
    return chip.saude === "vermelho" ? "saúde vermelha: parado" : "chip recuperado; aguarda próxima volta";
  }
  const naVolta = chipNaVolta(chip, agora);
  if (!naVolta.ok) return naVolta.motivo;

  // A cor atual precisa ser calculada antes de decidir se a rampa sobe.
  const freio = await avaliarSaudeDoChip(repo, config, chip, agora);
  if (freio) return freio;
  // E3: chip mudo (envios seguidos sem nenhum ack) para pelo mesmo freio; com a saúde desligada, só avisa.
  const mudo = await freioDeChipMudo(repo, config, chip, agora);
  if (mudo) return mudo;

  // Abre o dia do chip uma vez: primeiro envio sorteado e degrau da rampa.
  const hoje = inicioDoDia(agora, ritmo.fusoMinutos);
  const mandou = await repo.mandouDesde(org, chip.id, new Date(hoje.getTime() - 4 * 24 * 60 * MIN), hoje);
  const dia = abrirDia(chip, mandou, ritmo, agora, sortear);
  if (dia) {
    const aberto = await repo.atualizarChip(org, chip.id, dia, hoje);
    return aberto ? `abriu o dia (rampa no dia ${dia.diaRampa})` : "outra volta abriu o dia";
  }

  const cad = cadenciaPorId(config.cadencia);
  const novos = [...tiposDeProspeccao(cad)];
  const contagem = await repo.contagem(org, chip.id, agora, ritmo.fusoMinutos, novos);

  // 0) Aviso ao celular do operador (ponto de parada): sai por ESTE chip, o da conversa,
  // depois do pacote e respeitando o mesmo ritmo de qualquer envio do chip.
  const aviso = await processarAviso(chip, contagem, ctx);
  if (aviso) return aviso;

  // 1) A fila: o mais antigo que venceu.
  for (const envio of await repo.vencidos(org, chip.id, agora, 50)) {
    const r = await processar(envio, chip, contagem, ctx);
    // Parte de uma sequência (operador, resposta/funil do atendimento, partes de um toque do kit) que saiu: as
    // seguintes da MESMA sequência, agendadas junto para o mesmo lead, são entregues no ritmo humano (3 s depois de
    // texto/imagem, 29-34 s depois de áudio) logo depois da passada normal de todos os chips, em `seguirSequencia`.
    if (r.saiu && deps.sequencia && repo.proximaParteDaSequencia && temPartesSeguintes(envio)) {
      ctx.seguir.push({ chip, ref: envio, chamadaEm: r.chamadaEm ?? deps.agora, ctx });
    }
    if (!r.saiu && r.texto.includes("parte anterior") && r.texto.startsWith("fila:")) continue;
    if (r.saiu || r.mexeu) return r.texto;
    if (envio.origem === "motor" && /^abertura_p[23]$/.test(envio.tipo)) return r.texto;
    // Fila esperando o ritmo: abertura também esperaria; segue para não travar a volta.
    if (!r.texto.startsWith("fila:")) return r.texto;
  }

  // 2) Abertura, se a vez do chip chegou.
  if (!config.fonteStageId) return "sem etapa de origem configurada para aberturas";
  const pode = podeEnviar("abertura", chip, contagem, ritmo, config.tetoDiario, agora);
  if (!pode.ok) return `abertura: ${pode.motivo}`;
  const fa = ritmo.filtroAbertura;
  const filtro: FiltroDeAbertura = {
    chipOrigem: fa.porChipOrigem ? (chip.nome ?? null) : null,
    classes: fa.classes.length ? fa.classes : null,
    semPendenciaOperador: fa.semPendenciaOperador,
    camposIguais: Object.keys(fa.camposIguais).length ? fa.camposIguais : null,
    quarentena: ritmo.quarentena.ligado ? { cfg: ritmo.quarentena, agora } : null,
  };
  const lead = await repo.proximoLeadParaAbertura(org, config.fonteStageId, filtro);
  if (!lead) return "abertura: nenhum lead pronto na etapa de origem";

  const base = { leadId: lead.id, chipId: chip.id, tipo: "abertura", origem: "motor" as const, enviarApos: agora };
  const bloqueio = motivoParaNaoContatar(lead) ?? (lead.telefone && telefoneFixo(lead.telefone) ? "telefone fixo" : null);
  if (bloqueio) {
    await repo.enfileirar(org, { ...base, texto: "", estado: "cancelado", motivo: bloqueio });
    ctx.resumo.cancelados++;
    return `abertura: lead pulado (${bloqueio})`;
  }
  const texto = await textoDoPasso(passoDoTipo(cad, "abertura")!, lead, ctx);
  if (!texto.ok) {
    // Sem nenhuma lista de texto configurada: problema de configuração, espera (não queima os leads).
    // Com listas configuradas, mas nenhuma serve a ESTE lead (ex.: sem segmento/trilha): cancela só este e segue,
    // senão o mesmo lead voltaria a cada volta e o chip pararia de abrir conversas.
    if (texto.semModelo && Object.keys(config.modelos).length === 0) return `abertura: ${texto.motivo}`;
    await repo.enfileirar(org, { ...base, texto: texto.texto, estado: "cancelado", motivo: texto.motivo });
    ctx.resumo.cancelados++;
    return `abertura barrada (${texto.motivo})`;
  }
  const imagemComLegenda = ritmo.aberturaMidiaId;
  const midia = imagemComLegenda ?? lead.campos.abertura_midia_id;
  let nova: EnvioDaFila | null;
  if (imagemComLegenda !== null && imagemComLegenda !== undefined) {
    // A configuração da organização vence a prévia por lead: foto e legenda são UM envio,
    // preservando o tipo abertura, o índice de deduplicação e os limites do chip.
    const valida = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(imagemComLegenda)
      && repo.midiaDaAberturaValida && await repo.midiaDaAberturaValida(org, imagemComLegenda);
    if (!valida) {
      await repo.enfileirar(org, { ...base, texto: texto.texto, estado: "cancelado", motivo: "imagem da abertura indisponível ou de outra organização" });
      ctx.resumo.cancelados++;
      return "abertura barrada (imagem indisponível)";
    }
    nova = await repo.enfileirar(org, { ...base, texto: texto.texto, midiaId: imagemComLegenda });
  } else if (midia !== undefined && midia !== null && midia !== "") {
    const fecho = lead.campos.abertura_fecho;
    const problemas = typeof fecho === "string" && fecho.trim() ? verificarTexto(fecho, { prospeccao: true, proibidos: config.proibidos }) : [];
    const valida = typeof midia === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(midia) && repo.midiaDaAberturaValida && await repo.midiaDaAberturaValida(org, midia);
    const motivo = !valida ? "prévia indisponível ou de outra organização" : problemas.length ? `fecho inválido: ${problemas.join(", ")}` : null;
    if (motivo) {
      await repo.enfileirar(org, { ...base, texto: texto.texto, estado: "cancelado", motivo });
      ctx.resumo.cancelados++;
      return `abertura barrada (${motivo})`;
    }
    if (!repo.enfileirarAberturaComPartes || !repo.estadoParteAbertura) return "abertura barrada (repositório sem suporte à prévia)";
    const partes: NovoEnvio[] = [
      { ...base, texto: texto.texto },
      { ...base, tipo: "abertura_p2", texto: "", midiaId: midia as string, enviarApos: new Date(agora.getTime() + 3000) },
    ];
    if (typeof fecho === "string" && fecho.trim()) partes.push({ ...base, tipo: "abertura_p3", texto: fecho, enviarApos: new Date(agora.getTime() + 6000) });
    nova = await repo.enfileirarAberturaComPartes(org, partes);
  } else nova = await repo.enfileirar(org, { ...base, texto: texto.texto });
  if (!nova) return "abertura: outra volta já planejou este lead";
  const resultado = await processar(nova, chip, contagem, ctx);
  if (resultado.saiu && deps.sequencia && repo.proximaParteDaSequencia && midia && !imagemComLegenda) ctx.seguir.push({ chip, ref: nova, chamadaEm: resultado.chamadaEm ?? agora, ctx });
  return resultado.texto;
}

/** Aviso parado há mais que isto (chip fora do ar, fila cheia) já não serve: a Central avisou antes. */
export const VALIDADE_DO_AVISO_MS = 6 * 60 * MIN;

/**
 * Entrega, no máximo, UM aviso ao celular do operador por volta e por chip, pelo
 * chip da conversa (`disparo_avisos_operador.chip_id`, nunca outro). Regras:
 *  - entra no ritmo como qualquer resposta do chip (`podeEnviar("resposta")`:
 *    intervalo mínimo desde o último envio, máximo por hora, teto do dia) — a
 *    contagem do chip já inclui os avisos que saíram;
 *  - espera o pacote: enquanto o lead tiver resposta automática por sair, o aviso fica;
 *  - mesmas travas do envio real: modo real E DISPARO_REAL_LIBERADO=sim (senão vira
 *    `simulado`) e a allowlist `DISPARO_SO_PARA` (o número do operador também precisa estar nela).
 * null = nada a fazer (a volta segue para a fila de sempre).
 */
async function processarAviso(chip: Chip, contagem: Contagem, ctx: Ctx): Promise<string | null> {
  const { config, deps } = ctx;
  const { repo, agora } = deps;
  const org = config.organizationId;
  const [aviso] = await repo.avisosVencidos(org, chip.id, agora, 1);
  if (!aviso) return null;

  if (agora.getTime() - aviso.enviarApos.getTime() > VALIDADE_DO_AVISO_MS) {
    if (!(await repo.reservarAviso(org, aviso.id))) return null;
    await repo.finalizarAviso(org, aviso.id, { estado: "cancelado", motivo: "aviso vencido (a Central já avisou)" });
    ctx.resumo.cancelados++;
    return "aviso ao operador cancelado (vencido)";
  }
  if (!podeEnviar("resposta", chip, contagem, config.ritmo, config.tetoDiario, agora).ok) return null;
  if (await repo.autoEmAberto(org, aviso.leadId)) return null; // o pacote sai antes
  if (!(await repo.reservarAviso(org, aviso.id))) return null;

  if (!ctx.real) {
    await repo.finalizarAviso(org, aviso.id, { estado: "simulado", enviadoEm: agora, motivo: ctx.resumo.motivoSimulado });
    ctx.resumo.avisos++;
    return "aviso ao operador simulado";
  }
  if (!destinoPermitido(aviso.destino, deps.ambiente)) {
    await repo.finalizarAviso(org, aviso.id, { estado: "cancelado", motivo: MOTIVO_ALLOWLIST });
    ctx.resumo.bloqueadosAllowlist++;
    return `aviso ao operador cancelado (${MOTIVO_ALLOWLIST})`;
  }
  let externalId: string | null;
  try {
    ({ externalId } = await deps.enviarAviso({ config, chipId: chip.id, canalId: aviso.canalId, destino: aviso.destino, texto: aviso.texto }));
  } catch (e) {
    const erro = (e as Error).message.slice(0, 200);
    const tentativas = aviso.tentativas + 1;
    await repo.finalizarAviso(
      org,
      aviso.id,
      tentativas >= 3
        ? { estado: "falhou", tentativas, motivo: `falhou ${tentativas}x: ${erro}` }
        : { estado: "pendente", tentativas, motivo: `falhou ${tentativas}x: ${erro}`, enviarApos: new Date(agora.getTime() + 10 * MIN) },
    );
    await repo.atualizarChip(org, chip.id, freioDoChip(erro, agora));
    ctx.resumo.falhas++;
    return `falha no aviso ao operador${sinalDeRestricao(erro) ? ", chip parado por sinal de restrição" : ""}`;
  }
  // O aviso SAIU: erro de banco daqui em diante não o devolve à fila (seria aviso em dobro) nem freia o chip.
  ctx.resumo.avisos++;
  const registro = await semLancar(() => repo.finalizarAviso(org, aviso.id, { estado: "enviado", enviadoEm: agora, externalId, motivo: null }));
  if (registro) {
    ctx.resumo.falhas++;
    (ctx.resumo.registroFalhou ??= []).push(`aviso ${aviso.id}: ${registro} (external_id ${externalId ?? "?"})`);
  }
  return "aviso ao operador enviado";
}

/** `chamadaEm`: o instante da chamada ao canal (só quando saiu), de onde conta a pausa até a parte seguinte. */
type Resultado = { texto: string; saiu: boolean; mexeu: boolean; chamadaEm?: Date };

/**
 * `continuacao`: esta é uma parte SEGUINTE de uma sequência cuja parte anterior acabou de sair (vem do laço
 * `seguirSequencia`). É ela que dispensa o intervalo mínimo do chip: a pausa entre partes do mesmo funil é a de uma
 * pessoa digitando (3 s / 29-34 s), não a do ritmo entre conversas. A PRIMEIRA parte de qualquer sequência segue o
 * ritmo do chip, exceto a do operador (foi ele quem pediu agora).
 */
async function processar(envio: EnvioDaFila, chip: Chip, contagem: Contagem, ctx: Ctx, continuacao = false): Promise<Resultado> {
  const { repo } = ctx.deps;
  const org = ctx.config.organizationId;
  if (envio.tipo === "abertura" && Object.keys(ctx.config.ritmo.limitePorClasseDia).length) {
    const lead = await repo.lead(org, envio.leadId);
    const classe = String(lead?.campos.classe ?? "");
    const teto = ctx.config.ritmo.limitePorClasseDia[classe];
    if (teto !== undefined) {
      if (!repo.tomarTravaDaClasse || !repo.soltarTravaDaClasse || !repo.aberturasDaClasseNoDia) return { texto: "teto por classe indisponível", saiu: false, mexeu: false };
      const dono = `${ctx.dono}:${chip.id}`;
      if (!(await repo.tomarTravaDaClasse(org, classe, dono))) return { texto: "classe aguardando outra volta", saiu: false, mexeu: false };
      try {
        const inicio = inicioDoDia(ctx.deps.agora, ctx.config.ritmo.fusoMinutos);
        if (await repo.aberturasDaClasseNoDia(org, classe, inicio) >= teto) return { texto: "teto diário da classe atingido", saiu: false, mexeu: false };
        return await processarComTrava(envio, chip, contagem, ctx, continuacao);
      } finally {
        await repo.soltarTravaDaClasse(org, classe, dono);
      }
    }
  }
  if (envio.tipo !== TIPO_RETORNO_RESERVA || !repo.tomarTravaDoLead) return processarComTrava(envio, chip, contagem, ctx, continuacao);
  const dono = "retorno:" + envio.id;
  if (!(await repo.tomarTravaDoLead(org, envio.leadId, dono))) return { texto: "retorno aguardando a leitura da lead", saiu: false, mexeu: false };
  try {
    return await processarComTrava(envio, chip, contagem, ctx, continuacao);
  } finally {
    await repo.soltarTravaDoLead?.(org, envio.leadId, dono);
  }
}

async function processarComTrava(envio: EnvioDaFila, chip: Chip, contagem: Contagem, ctx: Ctx, continuacao = false): Promise<Resultado> {
  const { config, deps } = ctx;
  const { repo, agora, sortear } = deps;
  const org = config.organizationId;
  const ritmo = config.ritmo;
  const cad = cadenciaPorId(config.cadencia);
  const passo = passoDoTipo(cad, envio.tipo);
  if (envio.origem === "motor" && /^abertura_p[23]$/.test(envio.tipo)) {
    const anterior = envio.tipo === "abertura_p2" ? "abertura" : "abertura_p2";
    const estado = await repo.estadoParteAbertura?.(org, envio.leadId, anterior);
    if (estado !== "enviado" && estado !== "simulado") {
      if ((estado === "cancelado" || estado === "falhou" || estado === null) && await repo.reservar(org, envio.id, ctx.dono)) {
        await repo.finalizar(org, envio.id, { estado: "cancelado", motivo: "parte anterior da abertura não saiu" }, "enviando", ctx.dono);
        return { texto: "cancelado (parte anterior da abertura não saiu)", saiu: false, mexeu: true };
      }
      // Uma tentativa anterior pode ter sido adiada. Deixe esta parte atrás dela na fila,
      // senão a parte vencida bloquearia indefinidamente a própria tentativa anterior.
      if ((estado === "pendente" || estado === "enviando") && await repo.reservar(org, envio.id, ctx.dono)) {
        await repo.finalizar(org, envio.id, { estado: "pendente", enviarApos: new Date(agora.getTime() + MIN), motivo: "aguarda parte anterior da abertura" }, "enviando", ctx.dono);
        return { texto: "fila: parte anterior da abertura ainda não saiu", saiu: false, mexeu: true };
      }
      return { texto: "fila: parte anterior da abertura ainda não saiu", saiu: false, mexeu: false };
    }
  }
  // Mensagem nova = passo da cadência OU toque do follow-up do kit / oferta do Método (planejados pelo atendimento).
  const retorno = envio.tipo === TIPO_RETORNO_RESERVA;
  // Campanha por prefixo (`campanha_<nome>`): sai como abertura, fora da cadência.
  const campanha = ehCampanha(envio.tipo) && envio.origem === "motor";
  const nova = retorno || campanha || ((Boolean(passo) || ehEnvioNovoDoKit(envio.tipo)) && envio.origem === "motor");

  if (envio.origem === "operador" && agora.getTime() - envio.enviarApos.getTime() > VALIDADE_DA_SEQUENCIA_MS) {
    if (!(await repo.reservar(org, envio.id, ctx.dono))) return { texto: "outra volta pegou o envio", saiu: false, mexeu: false };
    const motivo = `sequência do operador vencida (parada há mais de ${VALIDADE_DA_SEQUENCIA_MS / MIN} min)`;
    await repo.finalizar(org, envio.id, { estado: "cancelado", motivo }, "enviando", ctx.dono);
    await repo.cancelarPendentesDoLead(org, envio.leadId, motivo, true);
    ctx.resumo.cancelados++;
    return { texto: `cancelado (${motivo})`, saiu: false, mexeu: true };
  }

  // Validade da fila (C3): o que ficou parado — chip vermelho dias, pausa, motor desligado — não sai depois fora de
  // contexto. Resposta automática velha é cancelada (a lead já não está naquela conversa) e o operador avisado.
  const validade = ritmo.validade;
  const atrasoMs = agora.getTime() - envio.enviarApos.getTime();
  if (envio.origem === "auto" && atrasoMs > validade.autoHoras * 60 * MIN) {
    if (!(await repo.reservar(org, envio.id, ctx.dono))) return { texto: "outra volta pegou o envio", saiu: false, mexeu: false };
    const motivo = `resposta automática vencida (parada há mais de ${validade.autoHoras} h)`;
    await repo.finalizar(org, envio.id, { estado: "cancelado", motivo }, "enviando", ctx.dono);
    await repo.cancelarPendentesDoLead(org, envio.leadId, motivo, false, "auto", true);
    await repo.avisarCentral?.(org, {
      titulo: "Disparo: resposta automática vencida, responda na mão",
      corpo: `A resposta automática para esta lead (${envio.tipo}) ficou parada desde ${envio.enviarApos.toISOString()} e não sai mais fora de contexto. Ela foi cancelada; confira a conversa e responda pela tela.`,
      nivel: "warn",
      leadId: envio.leadId,
    });
    ctx.resumo.cancelados++;
    return { texto: `cancelado (${motivo})`, saiu: false, mexeu: true };
  }
  // Toque de cadência atrasado demais não sai em rajada quando o chip volta: vai para um horário sorteado à frente,
  // e o ritmo do chip (janela, vez, piso entre novas) segue valendo quando ele vencer de novo.
  if (nova && envio.tipo !== "abertura" && !campanha && atrasoMs > validade.toqueAtrasoHoras * 60 * MIN) {
    if (!(await repo.reservar(org, envio.id, ctx.dono))) return { texto: "outra volta pegou o envio", saiu: false, mexeu: false };
    const novaHora = new Date(agora.getTime() + Math.max(MIN, Math.round(sortear() * validade.toqueEspalharHoras * 60 * MIN)));
    const motivo = `reprogramado: atrasou ${Math.round(atrasoMs / (60 * MIN))} h (chip parado); sai a partir de ${novaHora.toISOString()}`;
    await repo.finalizar(org, envio.id, { estado: "pendente", enviarApos: novaHora, motivo }, "enviando", ctx.dono);
    return { texto: `${envio.tipo} ${motivo}`, saiu: false, mexeu: true };
  }

  // A4: a janela de resposta (padrão 8h–22h) vale também na HORA DO ENVIO, não só no planejamento. Resposta automática
  // fora dela vai, com as partes seguintes, para a abertura da próxima janela. O funil do OPERADOR não passa por aqui
  // (regra: envio manual só exige chip saudável; quem clicou está na conversa naquela hora).
  if (ehSequencia(envio.origem) && envio.origem !== "operador") {
    const janela = config.janelaResposta ?? JANELA_RESPOSTA_PADRAO;
    if (!dentroDaJanelaDeResposta(agora, janela, ritmo)) {
      if (!(await repo.reservar(org, envio.id, ctx.dono))) return { texto: "outra volta pegou o envio", saiu: false, mexeu: false };
      const faixa = `${Math.floor(janela.inicioMin / 60)}h–${Math.floor(janela.fimMin / 60)}h`;
      const novaHora = proximaJanelaDeResposta(agora, janela, ritmo, sortear);
      await repo.adiarAutoDoLead(org, envio.leadId, envio.enviarApos, novaHora.getTime() - envio.enviarApos.getTime(), "auto");
      const motivo = `fora da janela de resposta (${faixa}): reprogramada para ${novaHora.toISOString()}`;
      await repo.finalizar(org, envio.id, { estado: "pendente", enviarApos: novaHora, motivo }, "enviando", ctx.dono);
      return { texto: `${envio.tipo} ${motivo}`, saiu: false, mexeu: true };
    }
  }

  // Ritmo humano entre partes do mesmo funil: o intervalo mínimo entre envios do chip (`intervaloMinimoSeg`, 90 s) não
  // vale para a sequência do operador nem para uma parte seguinte de qualquer sequência. TODO o resto de `podeEnviar`
  // vale: máximo por hora e teto do dia (e, para mensagem nova, janela, vez do chip e piso entre novas).
  const emSequencia = envio.origem === "operador" || continuacao;
  const ritmoDoEnvio = emSequencia ? { ...ritmo, intervaloMinimoSeg: 0 } : ritmo;
  const pode = podeEnviar(envio.tipo === "abertura" || campanha ? "abertura" : nova ? "toque" : "resposta", chip, contagem, ritmoDoEnvio, config.tetoDiario, agora);
  if (!pode.ok) {
    // A sequência para aqui e o motivo fica na própria linha (o painel mostra): nunca fura o limite.
    if (emSequencia) await repo.anotarMotivoDaFila?.(org, envio.id, `sequência parada: ${pode.motivo}`);
    return { texto: `fila: ${pode.motivo}`, saiu: false, mexeu: false };
  }
  if (ehSequencia(envio.origem) && (await repo.autoEmAbertoAntes(org, envio.leadId, envio.id, envio.enviarApos, envio.origem))) {
    return { texto: "fila: a parte anterior da resposta ainda não saiu", saiu: false, mexeu: false };
  }
  // A vez do chip: reserva atômica (duas voltas juntas não mandam duas novas).
  if (nova) {
    const vez = await repo.atualizarChip(org, chip.id, { proximoEnvioEm: new Date(agora.getTime() + 2 * MIN) }, agora);
    if (!vez) return { texto: "outra volta pegou a vez do chip", saiu: false, mexeu: false };
  }
  // E5: a reserva leva o dono (esta volta). Se ela travar mais que `enviandoPresoMin`, a varredura de outra volta pode
  // devolver a linha e reservá-la de novo: daí em diante a marca de canal e o desfecho desta volta não valem mais.
  if (!(await repo.reservar(org, envio.id, ctx.dono))) return { texto: "outra volta pegou o envio", saiu: false, mexeu: false };

  // A2: erro (de banco) depois da reserva e ANTES da chamada ao canal não pode deixar a linha órfã em `enviando`
  // (travaria a lead): ela volta à fila. Depois da chamada, o desfecho já está gravado (ou fica para a varredura).
  const sinal = { canalChamado: false };
  try {
    return await depoisDaReserva(envio, chip, ctx, nova, passo, sinal);
  } catch (e) {
    const erro = (e as Error).message.slice(0, 200);
    if (!sinal.canalChamado) {
      await semLancar(() => repo.finalizar(org, envio.id, { estado: "pendente", motivo: `erro antes do envio (volta à fila): ${erro}` }, "enviando", ctx.dono));
    }
    throw e;
  }
}

/** O que `processar` faz com a linha já reservada (`enviando`): as conferências finais, a chamada ao canal e o depois. */
async function depoisDaReserva(
  envio: EnvioDaFila,
  chip: Chip,
  ctx: Ctx,
  nova: boolean,
  passo: Passo | null,
  sinal: { canalChamado: boolean },
): Promise<Resultado> {
  const { config, deps } = ctx;
  const { repo, agora, sortear } = deps;
  const org = config.organizationId;
  const ritmo = config.ritmo;

  /**
   * `alcance`: só este envio; a fila do lead SEM as respostas `da_parada` (o pacote
   * já decidido segue); ou tudo (opt-out, lead que sumiu, humano que assumiu de fato).
   */
  /** Desfecho desta reserva: só vale se a linha ainda for desta volta (E5). */
  const fechar = (fim: FimDoEnvio) => repo.finalizar(org, envio.id, fim, "enviando", ctx.dono);
  const cancelar = async (motivo: string, alcance: "esta" | "fila" | "tudo" = "esta"): Promise<Resultado> => {
    await fechar({ estado: "cancelado", motivo });
    if (alcance !== "esta") await repo.cancelarPendentesDoLead(org, envio.leadId, motivo, alcance === "fila", undefined, motivo === "o lead escreveu de novo");
    ctx.resumo.cancelados++;
    return { texto: `cancelado (${motivo})`, saiu: false, mexeu: true };
  };

  const lead = await repo.lead(org, envio.leadId);
  if (!lead) return cancelar("lead não existe mais", "tudo");
  const bloqueio = motivoParaNaoContatar(lead);
  if (bloqueio) return cancelar(bloqueio, "tudo");
  const retorno = envio.tipo === TIPO_RETORNO_RESERVA;
  if (retorno) {
    if (naoContatarMarcado(lead.campos)) return cancelar("lead na lista de não contatar", "tudo");
    const motivo = repo.conferirRetornoReserva ? await repo.conferirRetornoReserva(org, envio, agora) : "conferência do retorno indisponível";
    if (motivo) return cancelar(motivo);
  }

  // Frequência: mensagens do motor sem resposta dentro da janela do mês (toque, não a abertura, que o filtro já conferiu).
  // (O follow-up do kit tem sequência própria de 7 toques, maior que o teto mensal de 3 sem resposta: fora desta conta.)
  if (nova && Boolean(passo) && envio.tipo !== "abertura" && ritmo.quarentena.ligado && repo.semRespostaDesde) {
    const desde = new Date(agora.getTime() - ritmo.quarentena.diasEntreAbordagens * 24 * 60 * MIN);
    const limite = podeTocar(await repo.semRespostaDesde(org, lead.id, desde), ritmo.quarentena);
    if (!limite.ok) return cancelar(limite.motivo, "tudo");
  }

  // Humano no comando (force_human, conversa pausada, dono humano): nem cadência
  // nem resposta pendente saem. É o mesmo veto do atendimento (`atendimento/humano.ts`
  // sobre `decidirElegibilidade`). Exceção: o pacote do ponto de parada (`daParada`)
  // ignora só a PAUSA — a que o próprio ponto de parada pôs depois de enfileirá-lo —;
  // quem assumiu de fato (force_human, dono humano) cala também o pacote.
  if (envio.origem === "motor" || envio.origem === "auto") {
    const { veto, vetoDuro } = avaliarHumano(await repo.situacaoHumana(org, lead.id), agora);
    const barra = envio.daParada ? vetoDuro : veto;
    if (barra) return cancelar(`humano no comando (${barra.motivo})`, vetoDuro ? "tudo" : "fila");
  }

  // Toque do kit, oferta do Método e D7/D14 foram agendados dias antes: o estado da lead é conferido de novo agora.
  if ((retorno || (envio.origem === "motor" && ehEnvioAgendadoDoKit(envio.tipo))) && repo.situacaoDoKit) {
    const s = await repo.situacaoDoKit(org, lead.id);
    // D7/D14 são para quem PAGOU o Método: a marca de Método pago não os barra; outra compra (cliente) sim.
    if (s.cliente) return cancelar("a lead já é cliente (comprou)", "tudo");
    if (s.metodoPago && !ehPosPagamentoDoMetodo(envio.tipo)) return cancelar("a lead já comprou o Método", "tudo");
    if (ritmo.quarentena.ligado && s.quarentenaAte && s.quarentenaAte.getTime() > agora.getTime()) {
      return cancelar(`lead em quarentena até ${s.quarentenaAte.toISOString().slice(0, 10)}`, "tudo");
    }
    if (s.precisaOperador && !retorno) return cancelar("a conversa está com o operador (precisa_operador)", "fila");
  }

  // Lead escreveu depois que isto foi planejado: o automático sai de cena. Vale também para a resposta automática
  // (C3: o atendimento cancela ao ler a mensagem nova, mas a leitura pode não ter rodado — webhook que falhou, conversa
  // pausada): só o pacote do ponto de parada (`daParada`) segue, como decidido.
  // Saudação pronta do WhatsApp Business do lead não conta como resposta (`./resposta-automatica.ts`).
  const respostas = (await repo.respostasDesde(org, lead.id, envio.criadoEm)).filter((t) => !ehRespostaAutomatica(t));
  if (respostas.length && !(envio.origem === "auto" && envio.daParada)) {
    const parou = respostas.map((t) => lerResposta(t, { golpeEhParada: ritmo.golpeEhParada })).find(encerraCadencia);
    if (parou || !retorno) return cancelar(parou ? `lead pediu para parar (${parou})` : "o lead escreveu de novo", parou ? "tudo" : "fila");
  }
  if (envio.origem === "auto" && !podeResponderSozinho(await repo.origensRecentes(org, lead.id, Math.max(5, ritmo.limiteAutomaticasSeguidas), retorno ? { id: envio.id, criadoEm: agora } : envio), ritmo.limiteAutomaticasSeguidas)) {
    return cancelar(`limite de ${ritmo.limiteAutomaticasSeguidas} respostas automáticas seguidas`);
  }
  // Parte só de mídia (o áudio do funil) não tem texto a conferir; legenda, quando há, passa pelo verificador.
  const soMidia = Boolean(envio.midiaId) && !envio.texto.trim();
  const problemas = soMidia
    ? []
    : verificarTexto(envio.texto, {
        // A oferta do Método fala de preço por natureza (é o produto): vale a trava de preço do atendimento, não esta.
        prospeccao: nova && !ehOfertaDoMetodo(envio.tipo),
        // A janela da base (`campanha_j*`) é o último recado da vez: libera só o proibido `excetoUltimo` (brinde extra).
        ultimoToque: Boolean(passo?.ultimo) || (envio.origem === "motor" && ehCampanhaDaJanela(envio.tipo)),
        proibidos: config.proibidos,
      });
  if (problemas.length) return cancelar(`verificador: ${problemas.join(", ")}`);

  const prazoEsgotado = () => ctx.prazoSequencia !== undefined && deps.sequencia!.relogio().getTime() + (envio.presencaMs ?? 0) >= ctx.prazoSequencia;
  const devolverAoFimDaVolta = async (): Promise<Resultado> => {
    await fechar({ estado: "pendente", motivo: null });
    return { texto: "o tempo da volta acabou: o resto sai na volta seguinte, na ordem", saiu: false, mexeu: true };
  };
  if (prazoEsgotado()) return devolverAoFimDaVolta();
  let chamadaEm = agora;
  // E2: a tentativa anterior deu erro incerto (tempo esgotado, 5xx, queda de conexão): a mensagem pode ter saído.
  // Confere na conversa ANTES de chamar o canal de novo. Sem conseguir conferir, não reenvia nesta volta.
  let jaSaiu: { externalId: string | null; em: Date } | null = null;
  if (ctx.real && destinoPermitido(lead.telefone, deps.ambiente) && repo.saidaNaConversa && precisaConferirAntesDeReenviar(envio)) {
    try {
      jaSaiu = await repo.saidaNaConversa(org, lead.id, { texto: envio.texto, soMidia, desde: envio.criadoEm });
    } catch (e) {
      const erro = (e as Error).message.slice(0, 150);
      await fechar({ estado: "pendente", motivo: `conferência da tentativa anterior falhou, não reenviado nesta volta: ${erro}`, enviarApos: new Date(agora.getTime() + 10 * MIN) });
      ctx.resumo.falhas++;
      return { texto: "não reenviado: a conferência da tentativa anterior falhou", saiu: false, mexeu: true };
    }
  }
  if (!ctx.real) {
    await fechar({ estado: "simulado", enviadoEm: agora, motivo: ctx.resumo.motivoSimulado });
    ctx.resumo.simulados++;
  } else if (!destinoPermitido(lead.telefone, deps.ambiente)) {
    // Terceira trava (DISPARO_SO_PARA): destino fora da lista. Não é erro, não
    // tenta de novo, não freia o chip e não encerra a cadência do lead.
    await fechar({ estado: "cancelado", motivo: MOTIVO_ALLOWLIST });
    ctx.resumo.bloqueadosAllowlist++;
    return { texto: `cancelado (${MOTIVO_ALLOWLIST})`, saiu: false, mexeu: true };
  } else if (jaSaiu) {
    // Saiu na tentativa anterior apesar do erro: fica `enviado` com o id achado, sem chamar o canal, e o resto segue
    // como num envio (vez do chip, próximo passo). Se o registro falhar, a varredura devolve a linha e a conferência
    // da volta seguinte a acha de novo: não há reenvio.
    const achada = jaSaiu;
    chamadaEm = achada.em;
    const registro = await semLancar(() => fechar({ estado: "enviado", enviadoEm: achada.em, externalId: achada.externalId, motivo: MOTIVO_SAIU_NA_TENTATIVA_ANTERIOR }));
    if (registro) {
      ctx.resumo.falhas++;
      (ctx.resumo.registroFalhou ??= []).push(`${envio.id}: ${registro} (external_id ${achada.externalId ?? "?"})`);
    }
  } else {
    // O atraso é medido no instante da CHAMADA ao canal (não no começo da volta): é entre chamadas que a pausa do ritmo
    // humano vale, e as leituras de banco antes da chamada atrasam a 1ª parte mais que as seguintes.
    // A marca ANTES da chamada separa, para a varredura de presos, "a volta morreu antes do canal" (pode voltar à fila)
    // de "morreu durante ou depois" (pode ter saído: nunca reenvia). Sem a marca gravada, o canal não é chamado.
    // E5: com o dono, a marca só passa se a reserva ainda for desta volta; senão o canal NÃO é chamado.
    const marca = await semLancar(async () => repo.marcarNoCanal?.(org, envio.id, ctx.dono));
    if (marca) {
      await semLancar(() => fechar({ estado: "pendente", motivo: `canal não chamado (registro falhou): ${marca}` }));
      ctx.resumo.falhas++;
      return { texto: `falha antes do envio (${marca})`, saiu: false, mexeu: true };
    }
    if (prazoEsgotado()) return devolverAoFimDaVolta();
    const instante = deps.sequencia ? deps.sequencia.relogio() : agora;
    chamadaEm = instante;
    let externalId: string | null;
    try {
      sinal.canalChamado = true;
      const presenca =
        (envio.presenca === "digitando" || envio.presenca === "gravando") && (envio.presencaMs ?? 0) > 0
          ? { tipo: envio.presenca, ms: envio.presencaMs! }
          : null;
      ({ externalId } = await deps.enviarReal({ config, chipId: chip.id, lead, texto: envio.texto, midiaId: envio.midiaId, ...(presenca ? { presenca } : {}) }));
    } catch (e) {
      // Só o erro do CANAL é falha de envio: nova tentativa, sequência esperando junto e freio do chip.
      return falhaNoCanal(envio, chip, (e as Error).message, ctx);
    }
    // O canal aceitou: a mensagem SAIU. Daqui em diante nenhum erro (de banco) devolve a linha a `pendente` — seria
    // envio em dobro — nem freia o chip — o erro não é do chip. Se o registro falhar, a linha fica `enviando` e a
    // varredura de presos (`varrerEnviandoPresos`) a encerra sem reenviar.
    ctx.resumo.enviados++;
    const registro = await semLancar(() =>
      // M5: o instante em que a mensagem saiu, não o começo da volta (que pode ser dezenas de segundos antes).
      fechar({ estado: "enviado", enviadoEm: chamadaEm, externalId, motivo: null }),
    );
    if (registro) {
      ctx.resumo.falhas++;
      (ctx.resumo.registroFalhou ??= []).push(`${envio.id}: ${registro} (external_id ${externalId ?? "?"})`);
    }
    // Saiu atrasada (o cron passa a cada minuto, o piso do ritmo segura): as
    // partes seguintes andam junto, para a pausa entre elas continuar a que o
    // atendimento planejou (o tempo do áudio tocar, o de ler a tabela).
    const atraso = instante.getTime() - envio.enviarApos.getTime();
    const origem = envio.origem;
    if (ehSequencia(origem) && atraso > 0) {
      const adiar = await semLancar(() => repo.adiarAutoDoLead(org, lead.id, envio.enviarApos, atraso, origem));
      if (adiar) ctx.resumo.falhas++;
    }
  }
  ctx.resumo.saidos++;
  if (retorno && repo.retornoReservaEnviado) {
    const erro = await semLancar(() => repo.retornoReservaEnviado!(org, envio, chamadaEm, ctx.real ? "real" : "simulado"));
    if (erro) {
      ctx.resumo.falhas++;
      await repo.avisarCentral?.(org, { titulo: "Retorno da reserva saiu: confira a lead quente", corpo: "O retorno foi enviado, mas o registro ou aviso ao operador falhou. Confira a conversa e assuma o fechamento.", nivel: "warn", leadId: lead.id });
    }
  }

  let prox = "";
  if (nova) {
    const depois = aposMensagemNova(chip, ritmo, agora, sortear);
    await repo.atualizarChip(org, chip.id, {
      proximoEnvioEm: depois.proximoEnvioEm,
      enviosDesdePausa: depois.enviosDesdePausa,
      pausaACada: depois.pausaACada,
    });
    prox = `, próxima nova em ${depois.esperaMin} min${depois.pausou ? " (pausa longa)" : ""}`;
    // Toque do follow-up do kit: os sete já estão na fila (o atendimento os gravou), não há próximo a planejar.
    if (passo) prox += await planejarProximo(passo, envio, lead, ctx);
    // Todos os toques saíram e o lead não respondeu (se tivesse, o envio teria sido cancelado acima): quarentena.
    if (passo?.ultimo && ritmo.quarentena.ligado && repo.entrarEmQuarentena) {
      const ate = fimDaQuarentena(agora, ritmo.quarentena);
      await repo.entrarEmQuarentena(org, lead.id, chip.id, ate);
      prox += ` · lead em quarentena por ${ritmo.quarentena.dias} dias`;
    }
  }
  return { texto: `${envio.tipo} ${ctx.real ? "enviado" : "simulado"}${prox}`, saiu: true, mexeu: true, chamadaEm };
}

/** Roda `f` e devolve a mensagem do erro em vez de lançar (null = deu certo). */
async function semLancar(f: () => Promise<unknown>): Promise<string | null> {
  try {
    await f();
    return null;
  } catch (e) {
    return (e as Error).message.slice(0, 200);
  }
}

/**
 * O CANAL recusou ou falhou (nada saiu): nova tentativa em 10 min — com a sequência esperando junto —, ou `falhou` na
 * terceira; e o freio do chip (restrição = vermelho). Só para erro vindo de `enviarReal`, nunca de banco.
 */
async function falhaNoCanal(envio: EnvioDaFila, chip: Chip, erro: string, ctx: Ctx): Promise<Resultado> {
  const { repo, agora } = ctx.deps;
  const org = ctx.config.organizationId;
  const tentativas = envio.tentativas + 1;
  if (semWhatsapp(erro)) {
    await repo.marcarSemWhatsapp?.(org, envio.leadId);
    await repo.cancelarPendentesDoLead(org, envio.leadId, "sem_whatsapp");
    await repo.finalizar(org, envio.id, { estado: "falhou", tentativas, motivo: "sem_whatsapp: numero nao possui WhatsApp" }, "enviando", ctx.dono);
    ctx.resumo.falhas++;
    return { texto: "falha no envio: numero sem WhatsApp", saiu: false, mexeu: true };
  }
  erro = erro.slice(0, 200);
  const novaHora = new Date(agora.getTime() + 10 * MIN);
  const chanceExtra = envio.tipo === "abertura" && envio.origem === "motor" && tentativas === 3
    && !/evolution_400|sem.?whatsapp|n[aã]o.contatar|bloque|restri/i.test(erro)
    && /timeout|timed.out|abort|evolution_5\d\d|\b5\d\d\b|sem chip/i.test(erro);
  let canceladasDaSequencia: number | null = null;
  if (ehSequencia(envio.origem)) {
    // Parte de resposta: o resto da sequência espera junto (nova tentativa)
    // ou não sai mais (a tabela sem a explicação não faz sentido). Antes de
    // finalizar: esta linha ainda está `enviando` e não entra no adiamento.
    // M1: o que não sai mais é só o que é DESTA origem (o toque da cadência e a sequência de outra origem não dependem
    // desta parte); o pacote da parada, já decidido, só cai se a própria parte que falhou é dele.
    if (tentativas >= 3) {
      const motivo = `parte anterior da sequência falhou ${tentativas}x: ${erro}`;
      canceladasDaSequencia = await repo.cancelarPendentesDoLead(org, envio.leadId, motivo, !envio.daParada, envio.origem);
    } else await repo.adiarAutoDoLead(org, envio.leadId, envio.enviarApos, novaHora.getTime() - envio.enviarApos.getTime(), envio.origem);
  }
  await repo.finalizar(
    org,
    envio.id,
    chanceExtra
      ? { estado: "pendente", tentativas, motivo: `segunda chance após 24h: ${erro}`, enviarApos: new Date(agora.getTime() + 24 * 60 * MIN) }
      : tentativas >= 3
      ? { estado: "falhou", tentativas, motivo: `falhou ${tentativas}x: ${erro}` }
      : { estado: "pendente", tentativas, motivo: `falhou ${tentativas}x: ${erro}`, enviarApos: novaHora },
    "enviando",
    ctx.dono,
  );
  await repo.atualizarChip(org, chip.id, freioDoChip(erro, agora));
  ctx.resumo.falhas++;
  if (canceladasDaSequencia !== null) {
    const quem = envio.origem === "operador" ? "a sequência do operador (/funil-valores)" : "a resposta automática";
    // Aviso na Central como os demais do motor: o resto da sequência não sai, e só o operador sabe se vale reenviar.
    await semLancar(async () =>
      repo.avisarCentral?.(org, {
        titulo: "Disparo: parte da sequência falhou 3x, confira a conversa",
        corpo: `A parte ${envio.tipo} de ${quem} falhou ${tentativas}x no canal (${erro}). ${canceladasDaSequencia} parte(s) seguinte(s) dessa mesma sequência foram canceladas; os toques da cadência e as outras sequências da lead seguem na fila. Confira a conversa e responda pela tela se for preciso.`,
        nivel: "warn",
        leadId: envio.leadId,
      }),
    );
  }
  return { texto: `falha no envio${sinalDeRestricao(erro) ? ", chip parado por sinal de restrição" : ""}`, saiu: false, mexeu: true };
}

/**
 * Segue uma sequência DENTRO da volta (ritmo humano), uma parte após a outra, no `enviar_apos` de cada uma (3 s depois de
 * texto/imagem, 29-34 s depois de áudio): pega a próxima parte pendente da MESMA sequência — mesmo lead, agendada junto:
 * operador, resposta/funil do atendimento, partes de um toque do kit; ver `sequencia-partes.ts` —, espera o horário e a
 * manda pelo MESMO `processar` de qualquer envio (com `continuacao`: só isso dispensa o intervalo mínimo do chip), então toda trava de lá vale aqui — lead que escreveu ou pediu para parar, bloqueio,
 * descarte de parte vencida há mais de 30 min, allowlist, trava do envio real, teto do dia e máximo por hora.
 *
 * A ordem não depende deste laço: `processar` só manda a parte N depois da N-1 (`autoEmAbertoAntes`), e a reserva
 * atômica (`reservar`) impede que este laço e uma volta do cron mandem a mesma parte; quem perde a reserva sai do laço.
 *
 * Para quando: acabou a sequência; uma parte não saiu (limite do chip, lead escreveu, falha) — o motivo vai para a
 * linha; o chip foi pausado, ficou vermelho ou sumiu da volta; o motor foi desligado; ou o orçamento de tempo da volta
 * acabou — o resto fica `pendente` para a volta seguinte, na mesma ordem. Antes de CADA parte relê o chip, a config e a
 * contagem do banco: o que mudou desde a parte anterior (operador pausou o chip, falha com sinal de restrição) vale.
 */
async function seguirSequencia({ chip: chipDaVolta, ref: primeira, chamadaEm: primeiraChamada, ctx: ctxDaVolta }: Seguir, prazo: number): Promise<void> {
  const seq = ctxDaVolta.deps.sequencia!;
  const { repo } = ctxDaVolta.deps;
  const org = ctxDaVolta.config.organizationId;
  const entrada = ctxDaVolta.resumo.chips.find((c) => c.chipId === chipDaVolta.id);
  let ref = primeira;
  let chamadaEm = primeiraChamada;
  /** Quanto o trabalho entre acordar e chamar o canal (conferências no banco) levou na parte anterior: a espera o desconta. */
  let latenciaMs = 0;
  let seguidas = 0;
  let usouPresenca = (primeira.presencaMs ?? 0) > 0;
  let parou = "a sequência acabou";
  try {
    for (let i = 0; i < MAX_PARTES_POR_VOLTA; i++) {
      const prox = await repo.proximaParteDaSequencia!(org, chipDaVolta.id, ref);
      if (!prox) break;
      if (usouPresenca && (prox.presencaMs ?? 0) > 0) {
        parou = "presença já usada nesta volta: o resto sai na volta seguinte";
        break;
      }

      // Horário da parte. Nas origens em que o atraso de uma parte empurra as seguintes (`ehSequencia`) ele já vem
      // ajustado; nas demais (toque do kit) a pausa planejada conta da CHAMADA anterior, nunca menos que ela.
      const alvo = ref.origem === "motor" && (ref.tipo === "abertura" || /^abertura_p[23]$/.test(ref.tipo))
        ? Math.max(prox.enviarApos.getTime(), chamadaEm.getTime() + 3000)
        : ehSequencia(ref.origem)
        ? prox.enviarApos.getTime()
        : Math.max(prox.enviarApos.getTime(), chamadaEm.getTime() + (prox.enviarApos.getTime() - ref.enviarApos.getTime()));
      const espera = alvo - seq.relogio().getTime();
      if (seq.relogio().getTime() + Math.max(0, espera) + (prox.presencaMs ?? 0) >= prazo) {
        parou = "o tempo da volta acabou: o resto sai na volta seguinte, na ordem";
        break;
      }
      if (espera > 0) {
        await seq.dormir(Math.max(0, espera - latenciaMs));
      }
      const agora = seq.relogio();

      // O que pode ter mudado durante a pausa: o motor desligado, o chip (pausado, vermelho, sumiu da volta).
      const config = (await repo.configsLigadas()).find((c) => c.organizationId === org);
      if (!config) {
        parou = "o motor foi desligado";
        break;
      }
      const chip = (await repo.chipsDaVolta(org)).find((c) => c.id === chipDaVolta.id);
      const naVolta = chip ? chipNaVolta(chip, agora) : ({ ok: false, motivo: "chip fora da volta (pausado ou desligado)" } as const);
      if (!chip || !naVolta.ok) {
        const motivo = naVolta.ok ? "chip fora da volta" : naVolta.motivo;
        await repo.anotarMotivoDaFila?.(org, prox.id, `sequência parada: ${motivo}`);
        parou = motivo;
        break;
      }

      const real = envioRealLiberado(config, ctxDaVolta.deps.ambiente);
      const ctx: Ctx = { config, deps: { ...ctxDaVolta.deps, agora }, real, resumo: ctxDaVolta.resumo, seguir: [], dono: ctxDaVolta.dono, prazoSequencia: prazo };
      const contagem = await repo.contagem(
        org,
        chip.id,
        agora,
        config.ritmo.fusoMinutos,
        [...tiposDeProspeccao(cadenciaPorId(config.cadencia))],
      );
      if (seq.relogio().getTime() >= prazo) {
        parou = "o tempo da volta acabou: o resto sai na volta seguinte, na ordem";
        break;
      }
      const r = await processar(prox, chip, contagem, ctx, true);
      if (!r.saiu) {
        parou = r.texto;
        break;
      }
      latenciaMs = Math.max(0, (r.chamadaEm ?? agora).getTime() - agora.getTime());
      chamadaEm = r.chamadaEm ?? agora;
      ref = prox;
      usouPresenca ||= (prox.presencaMs ?? 0) > 0;
      seguidas++;
    }
  } catch (e) {
    ctxDaVolta.resumo.falhas++;
    parou = `erro ao seguir a sequência: ${(e as Error).message.slice(0, 150)}`;
  }
  if (entrada) entrada.resultado += ` · sequência (${primeira.origem}): ${seguidas} parte(s) seguida(s) na volta; ${parou}`;
}

/** Grava na fila o passo seguinte da cadência (um de cada vez, como no motor da organização B). */
async function planejarProximo(feito: Passo, envio: EnvioDaFila, lead: LeadDoDisparo, ctx: Ctx): Promise<string> {
  const { config, deps } = ctx;
  const { repo, agora, sortear } = deps;
  const org = config.organizationId;
  const cad = cadenciaPorId(config.cadencia);
  let passo = proximoPasso(cad, feito.tipo);
  const abertaEm = feito.tipo === "abertura" ? agora : ((await repo.saiuEm(org, lead.id, "abertura")) ?? agora);

  const pulos: string[] = [];
  while (passo) {
    const quando = horaDoPasso(cad, passo, abertaEm, config.ritmo, sortear, agora);
    if (!passo.automatico) {
      // Lembrete: sem chip (não sai por canal, não conta no ritmo do chip).
      const base = { leadId: lead.id, chipId: null, tipo: passo.tipo, origem: "lembrete" as const, enviarApos: quando };
      const roteiro = await textoDoPasso(passo, lead, ctx, quando);
      const texto = [textoDoLembrete(passo, lead.nome ?? lead.telefone ?? "o lead"), roteiro.ok ? roteiro.texto : ""]
        .filter(Boolean)
        .join("\n\n");
      const fora = await foraDoLembrete(passo.tipo, lead, quando, ctx);
      await repo.enfileirar(org, fora ? { ...base, texto, estado: "cancelado", motivo: fora } : { ...base, texto });
      if (fora) pulos.push(`${passo.tipo} pulado (${fora})`);
      // O lembrete não segura a cadência: o próximo automático é planejado junto.
      passo = proximoPasso(cad, passo.tipo);
      continue;
    }
    const texto = await textoDoPasso(passo, lead, ctx, quando);
    if (!texto.ok) {
      // Como na organização B: passo sem texto possível é pulado (e registrado), a cadência segue.
      await repo.enfileirar(org, {
        leadId: lead.id, chipId: envio.chipId, tipo: passo.tipo, origem: "motor", texto: texto.texto,
        enviarApos: quando, estado: "cancelado", motivo: texto.motivo,
      });
      pulos.push(`${passo.tipo} pulado (${texto.motivo})`);
      passo = proximoPasso(cad, passo.tipo);
      continue;
    }
    await repo.enfileirar(org, {
      leadId: lead.id, chipId: envio.chipId, tipo: passo.tipo, origem: "motor", texto: texto.texto, enviarApos: quando,
    });
    return `${pulos.map((p) => ` · ${p}`).join("")} · ${passo.tipo} planejado`;
  }
  return `${pulos.map((p) => ` · ${p}`).join("")} · fim da cadência`;
}

/**
 * Lembrete fora do filtro da organização (`ritmo.lembretes`): lead que não
 * bate em nenhuma condição de relevância, ou teto do dia daquele tipo já
 * cheio. null = entra. Portado do `avancar`/`cabeNoTetoManual` da organização B.
 */
async function foraDoLembrete(tipo: string, lead: LeadDoDisparo, quando: Date, ctx: Ctx): Promise<string | null> {
  const { relevancia, tetoDia } = ctx.config.ritmo.lembretes;
  if (relevancia.length && !relevancia.some((c) => bateCondicao(c, lead.campos))) return "fora do filtro de relevância";
  const teto = tetoDia[tipo];
  if (teto === undefined) return null;
  const inicio = inicioDoDia(quando, ctx.config.ritmo.fusoMinutos);
  const fim = new Date(inicio.getTime() + 24 * 60 * MIN);
  const ja = await ctx.deps.repo.lembretesNoDia(ctx.config.organizationId, tipo, inicio, fim);
  return ja >= teto ? `teto de ${teto} lembretes ${tipo} no dia` : null;
}

type Texto = { ok: true; texto: string } | { ok: false; texto: string; motivo: string; semModelo?: boolean };

/**
 * Texto do passo para o lead: tenta as listas que a escolha da organização
 * aponta, em ordem, e fica com a primeira que preenche tudo e passa no
 * verificador. Nenhuma passou = o motivo da ÚLTIMA tentativa (a mais genérica).
 */
async function textoDoPasso(passo: Passo, lead: LeadDoDisparo, ctx: Ctx, quando?: Date): Promise<Texto> {
  const { config, deps } = ctx;
  const ritmo = config.ritmo;
  const listas = listasDoPasso(config.modelos, config.escolha, passo.tipo, lead);
  if (!listas.length) return { ok: false, texto: "", motivo: `sem modelo para ${passo.tipo}`, semModelo: true };
  const hoje = inicioDoDia(deps.agora, ritmo.fusoMinutos);
  const usadas = await deps.repo.criadosDesde(config.organizationId, passo.tipo, hoje);
  const slots = slotsDoLead(lead, config.slots, quando ?? deps.agora, ritmo.fusoMinutos);
  let falha: Texto = { ok: false, texto: "", motivo: `sem modelo para ${passo.tipo}` };
  for (const { lista, versoes } of listas) {
    const { texto, faltando } = montar(versoes[versaoDoDia(usadas, versoes.length)]!, slots);
    if (faltando.length) {
      falha = { ok: false, texto, motivo: `campo sem preencher em ${lista}: ${faltando.join(", ")}` };
      continue;
    }
    const problemas = verificarTexto(texto, { prospeccao: true, ultimoToque: Boolean(passo.ultimo), proibidos: config.proibidos });
    if (problemas.length) {
      falha = { ok: false, texto, motivo: `verificador em ${lista}: ${problemas.join(", ")}` };
      continue;
    }
    return { ok: true, texto };
  }
  return falha;
}
