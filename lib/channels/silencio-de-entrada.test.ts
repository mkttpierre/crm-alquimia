import { describe, expect, it } from "vitest";

import {
  LIMITE_SILENCIO_MIN,
  decidirSilencioDeEntrada,
  dentroDoHorarioComercial,
  minutosUteisEntre,
  type EntradaSilencio,
} from "@/lib/channels/silencio-de-entrada";

/**
 * Alarme de silêncio de entrada (auditoria 05/11/2026, item 3).
 *
 * O vigia só perguntava "o transporte está de pé?", e `open` valia como saudável
 * mesmo com o webhook de entrada quebrado: a conexão responde, mas nada chega.
 * Silêncio é SUSPEITA, nunca prova: a regra abaixo só levanta a mão quando o
 * silêncio é incomum PARA ESTA conexão, em horário comercial.
 *
 * Calendário de 2026 usado nos casos (America/Sao_Paulo, UTC-3, sem horário de
 * verão): qua 04/11, qui 05/11, sex 06/11, sáb 07/11, dom 08/11, seg 09/11.
 */

const sp = (dia: number, hhmm: string) => new Date(`2026-11-${String(dia).padStart(2, "0")}T${hhmm}:00-03:00`);
const QUA = 4, QUI = 5, SEX = 6, SAB = 7, DOM = 8, SEG = 9;

function entrada(extra: Partial<EntradaSilencio> = {}): EntradaSilencio {
  return {
    agora: sp(QUI, "12:00"),
    ultimaInboundEm: sp(QUI, "08:00"),
    inboundPrivadas7d: 5,
    irmaoRecebeuNaUltimaHora: false,
    episodioAbertoRef: null,
    ...extra,
  };
}

describe("horário comercial: seg a sex, 07:00 às 16:00 (America/Sao_Paulo)", () => {
  it("dentro: quinta 12:00", () => {
    expect(decidirSilencioDeEntrada(entrada()).acao).toBe("avisar");
  });

  it("fora do horário: quinta 17:00 não avisa, mesmo com silêncio longo e histórico", () => {
    const d = decidirSilencioDeEntrada(entrada({ agora: sp(QUI, "17:00") }));
    expect(d).toMatchObject({ acao: "nada", motivo: "fora_do_horario" });
  });

  it("fora do horário: quinta 06:59 não avisa", () => {
    const d = decidirSilencioDeEntrada(entrada({ agora: sp(QUI, "06:59"), ultimaInboundEm: sp(QUA, "08:00") }));
    expect(d).toMatchObject({ acao: "nada", motivo: "fora_do_horario" });
  });

  it("as bordas 07:00 e 16:00 contam como dentro", () => {
    expect(dentroDoHorarioComercial(sp(QUI, "07:00")).dentro).toBe(true);
    expect(dentroDoHorarioComercial(sp(QUI, "16:00")).dentro).toBe(true);
    expect(dentroDoHorarioComercial(sp(QUI, "16:01")).dentro).toBe(false);
  });

  it("fuso: 12:00 UTC é 09:00 em São Paulo (dentro); 20:00 UTC é 17:00 (fora)", () => {
    expect(dentroDoHorarioComercial(new Date("2026-11-05T12:00:00Z")).dentro).toBe(true);
    expect(dentroDoHorarioComercial(new Date("2026-11-05T20:00:00Z")).dentro).toBe(false);
  });

  it("sábado e domingo não avaliam", () => {
    for (const dia of [SAB, DOM]) {
      const d = decidirSilencioDeEntrada(entrada({ agora: sp(dia, "12:00"), ultimaInboundEm: sp(SEX, "09:00") }));
      expect(d).toMatchObject({ acao: "nada", motivo: "fim_de_semana" });
    }
  });
});

describe("o silêncio conta só o tempo útil — fim de semana e noite não são silêncio", () => {
  it("sexta 15:00 → segunda 08:00 são 2 h úteis, não 65 h", () => {
    expect(minutosUteisEntre(sp(SEX, "15:00"), sp(SEG, "08:00"))).toBe(120);
  });

  it("segunda 07:00, última mensagem sexta 15:00: NÃO avisa na abertura da semana", () => {
    const d = decidirSilencioDeEntrada(entrada({ agora: sp(SEG, "07:00"), ultimaInboundEm: sp(SEX, "15:00") }));
    expect(d).toMatchObject({ acao: "nada", motivo: "dentro_do_limite" });
  });

  it("depois de 4 h úteis de segunda sem mensagem, avisa", () => {
    // sex 15:00-16:00 = 1 h; seg 07:00-10:00 = 3 h → 4 h úteis às 10:00.
    const d = decidirSilencioDeEntrada(entrada({ agora: sp(SEG, "10:00"), ultimaInboundEm: sp(SEX, "15:00") }));
    expect(d.acao).toBe("avisar");
  });

  it("reconectou há 1 h: o silêncio só começa a contar da reconexão", () => {
    const d = decidirSilencioDeEntrada(entrada({ desdeEm: sp(QUI, "11:00") }));
    expect(d).toMatchObject({ acao: "nada", motivo: "dentro_do_limite" });
  });
});

describe("o limite de 4 horas", () => {
  it("o limite é 4 h", () => {
    expect(LIMITE_SILENCIO_MIN).toBe(240);
  });

  it("4 h exatas avisam", () => {
    const d = decidirSilencioDeEntrada(entrada({ ultimaInboundEm: sp(QUI, "08:00"), agora: sp(QUI, "12:00") }));
    expect(d).toMatchObject({ acao: "avisar", silencioMin: 240 });
  });

  it("3 h 59 min não avisam", () => {
    const d = decidirSilencioDeEntrada(entrada({ ultimaInboundEm: sp(QUI, "08:01"), agora: sp(QUI, "12:00") }));
    expect(d).toMatchObject({ acao: "nada", motivo: "dentro_do_limite" });
  });

  it("4 h 01 min avisam", () => {
    const d = decidirSilencioDeEntrada(entrada({ ultimaInboundEm: sp(QUI, "07:59"), agora: sp(QUI, "12:00") }));
    expect(d.acao).toBe("avisar");
  });
});

describe("quem merece aviso: histórico ou chip irmão ativo", () => {
  it("sem histórico (2 mensagens em 7 dias) e sem irmão ativo: não avisa", () => {
    const d = decidirSilencioDeEntrada(entrada({ inboundPrivadas7d: 2 }));
    expect(d).toMatchObject({ acao: "nada", motivo: "sem_historico" });
  });

  it("exatamente 3 mensagens em 7 dias já é histórico", () => {
    const d = decidirSilencioDeEntrada(entrada({ inboundPrivadas7d: 3 }));
    expect(d).toMatchObject({ acao: "avisar", motivo: "historico" });
  });

  it("chip irmão recebeu na última hora: avisa mesmo sem histórico, e diz o motivo", () => {
    const d = decidirSilencioDeEntrada(entrada({ inboundPrivadas7d: 0, irmaoRecebeuNaUltimaHora: true }));
    expect(d).toMatchObject({ acao: "avisar", motivo: "irmao_ativo" });
  });

  it("chip irmão ativo, mas este chip nunca recebeu nada: não há como falar em silêncio", () => {
    const d = decidirSilencioDeEntrada(
      entrada({ inboundPrivadas7d: 0, irmaoRecebeuNaUltimaHora: true, ultimaInboundEm: null }),
    );
    expect(d).toMatchObject({ acao: "nada", motivo: "sem_referencia" });
  });

  it("chip irmão ativo não avisa antes das 4 h", () => {
    const d = decidirSilencioDeEntrada(
      entrada({ inboundPrivadas7d: 0, irmaoRecebeuNaUltimaHora: true, ultimaInboundEm: sp(QUI, "09:00") }),
    );
    expect(d).toMatchObject({ acao: "nada", motivo: "dentro_do_limite" });
  });
});

describe("episódio: avisa uma vez e resolve quando volta a chegar", () => {
  it("mesmo episódio (mesma última mensagem) não avisa de novo", () => {
    const ref = sp(QUI, "08:00").toISOString();
    const d = decidirSilencioDeEntrada(entrada({ episodioAbertoRef: ref }));
    expect(d).toMatchObject({ acao: "nada", motivo: "ja_avisado" });
  });

  it("chegou mensagem nova: resolve", () => {
    const ref = sp(QUI, "08:00").toISOString();
    const d = decidirSilencioDeEntrada(
      entrada({ episodioAbertoRef: ref, ultimaInboundEm: sp(QUI, "11:30") }),
    );
    expect(d).toMatchObject({ acao: "resolver", motivo: "voltou_a_receber" });
  });

  it("a resolução acontece até fora do horário e no fim de semana", () => {
    const ref = sp(SEX, "08:00").toISOString();
    const d = decidirSilencioDeEntrada(
      entrada({ agora: sp(SAB, "10:00"), episodioAbertoRef: ref, ultimaInboundEm: sp(SEX, "15:30") }),
    );
    expect(d.acao).toBe("resolver");
  });

  it("a referência do episódio é a última mensagem recebida (ISO), para o dedup", () => {
    const d = decidirSilencioDeEntrada(entrada());
    expect(d).toMatchObject({ acao: "avisar", referencia: sp(QUI, "08:00").toISOString() });
  });
});
