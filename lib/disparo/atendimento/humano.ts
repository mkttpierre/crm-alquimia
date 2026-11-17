/**
 * Quando uma PESSOA está no comando da conversa, o atendimento automático cala.
 *
 * Confirmado no código antes de existir: o atendimento só olhava `is_blocked`,
 * `custom_fields.nao_contatar` e `operadorFalouDesde` (mensagem do operador DEPOIS
 * da última automática). Ele ignorava as três travas que o resto do produto usa
 * para "passou para humano": `contacts.force_human`,
 * `conversations.bot_silenced_until` (futuro ou `infinity`) e o dono humano da
 * conversa (`assignee_kind='user'` / `assigned_to_user_id`). Resultado possível:
 * o operador assume a conversa pela tela e o atendimento responde por cima.
 *
 * A regra NÃO é reescrita aqui: é `decidirElegibilidade` (`lib/ai/elegibilidade/gate.ts`),
 * a mesma que o drain, o turno do agent-engine e o handoff usam, em modo `open`
 * (o gate `allowlist` é decisão de canal do upstream, não nossa — o atendimento
 * já tem a trava dele). Só os três vetos "humano" valem. Duas regras para a mesma
 * pergunta divergiriam na primeira vez que alguém acrescentasse um motivo.
 *
 * O INTERRUPTOR POR CONVERSA é o mesmo par que a tela já tem: `pause-ai`
 * (`bot_silenced_until='infinity'`, e quem pausa assume se ninguém for dono) e
 * `reactivate-bot` (`lib/escalacao/retomada.ts`, solta as três travas). Um campo
 * novo "atendimento ligado/desligado" seria o quarto lugar a consultar e o
 * primeiro que o botão da tela não conhece — o interruptor que não desliga o
 * que a tela mostra desligado. Ver `HANDOFF-silencio-retomada-humana-nao-gruda.md`.
 *
 * A conversa é do CONTATO, não do lead: o veto vale se QUALQUER conversa aberta
 * do contato (outro chip, outra sessão) estiver sob comando humano. Conversa
 * encerrada/arquivada não segura ninguém, a menos que seja a da própria mensagem.
 */
import { decidirElegibilidade, normalizarInstante } from "@/lib/ai/elegibilidade/gate";

export type ConversaHumana = {
  /** `conversations.bot_silenced_until` cru (ISO, `'infinity'` ou null). */
  botSilencedUntil: Date | string | number | null;
  assigneeKind: string | null;
  assignedToUserId: string | null;
};

export type SituacaoHumana = {
  /** `contacts.force_human`. */
  forceHuman: boolean;
  /** As conversas do contato que contam (abertas, mais a da mensagem). */
  conversas: ConversaHumana[];
};

export type MotivoHumano = "force_human" | "conversa_silenciada" | "conversa_de_humano";

export type VetoHumano = { motivo: MotivoHumano; detalhe: string };

const DETALHE: Record<MotivoHumano, string> = {
  force_human: "o contato está marcado para atendimento humano (force_human)",
  conversa_silenciada: "o atendimento automático está pausado nesta conversa",
  conversa_de_humano: "uma pessoa é a dona desta conversa",
};

/**
 * null = ninguém está no comando: o atendimento pode seguir.
 *
 * `ignorarSilencio`: ignora só `bot_silenced_until`. É a pergunta que o PACOTE do
 * ponto de parada faz: o próprio ponto de parada pausa a conversa (o mesmo
 * `pause-ai` da tela) logo depois de enfileirar o pacote, e essa pausa não pode
 * derrubar o que ele mesmo já decidiu mandar. Quem assumiu DE FATO (`force_human`,
 * dono humano) continua calando o pacote.
 */
export function vetoHumano(s: SituacaoHumana, agora: Date, opcoes: { ignorarSilencio?: boolean } = {}): VetoHumano | null {
  const conversas: ConversaHumana[] = s.conversas.length ? s.conversas : [{ botSilencedUntil: null, assigneeKind: null, assignedToUserId: null }];
  for (const c of conversas) {
    const d = decidirElegibilidade({
      modo: "open",
      forceHuman: s.forceHuman,
      botSilencedUntil: opcoes.ignorarSilencio ? null : normalizarInstante(c.botSilencedUntil),
      assigneeKind: c.assigneeKind === "user" || c.assignedToUserId ? "user" : c.assigneeKind,
      aiAuthorizedAt: null,
      preGoLiveAtivo: false,
      numeroDeTesteAutorizado: false,
      agora,
      ttlMs: 0,
    });
    if (!d.permite && (d.motivo === "force_human" || d.motivo === "conversa_silenciada" || d.motivo === "conversa_de_humano")) {
      return { motivo: d.motivo, detalhe: DETALHE[d.motivo] };
    }
  }
  return null;
}

/**
 * As duas perguntas de uma vez, para quem manda mensagem ao lead:
 *  - `veto`: vale para tudo que é automático (cadência, respostas, abertura);
 *  - `vetoDuro`: vale também para o pacote do ponto de parada (sem o silêncio).
 * `vetoDuro` não-nulo implica `veto` não-nulo.
 */
export function avaliarHumano(s: SituacaoHumana, agora: Date): { veto: VetoHumano | null; vetoDuro: VetoHumano | null } {
  return { veto: vetoHumano(s, agora), vetoDuro: vetoHumano(s, agora, { ignorarSilencio: true }) };
}
