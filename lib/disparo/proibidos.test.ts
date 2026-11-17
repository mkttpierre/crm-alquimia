/**
 * Linguagem proibida de uma organização (voz da "Especialista" da equipe): nunca "Dr."/"Dra." e nunca "consultora".
 *
 * Os padrões moram no BANCO da organização (o código não conhece a voz de nenhum negócio): esta lista é só
 * um exemplo, para o repositório ter o teste do verificador com os falsos positivos que importam.
 */
import { describe, expect, it } from "vitest";

import { verificarTexto } from "./textos";

const PROIBIDOS_EXEMPLO = [
  { padrao: "brinde (extra|a mais)|um brinde de cortesia", motivo: "cita brinde extra fora do último toque", excetoUltimo: true },
  { padrao: "anvisa", motivo: "cita Anvisa" },
  { padrao: "\\bdra?\\b", motivo: "usa 'Dr.' (a voz é a Especialista)" },
  { padrao: "\\bconsultoras?\\b", motivo: "usa 'consultora' (a voz é a Especialista)" },
];
const problemas = (t: string, ultimoToque = false) => verificarTexto(t, { proibidos: PROIBIDOS_EXEMPLO, ultimoToque });

describe("proibidos de uma organização", () => {
  it.each(["Oi, aqui é o Dr. Exemplo", "dr exemplo silva", "DR. Exemplo", "Dra. Ana vai te atender", "sou sua consultora", "nossas consultoras", "Consultora Ana"])(
    "barra: %s",
    (t) => expect(problemas(t)).not.toEqual([]),
  );
  it.each([
    "Aqui é a Especialista da equipe",
    "Vamos começar a sua consulta",
    "As consultas são individuais",
    "acompanhamento individual",
    "drenagem e hidratação",
    "a Especialista indica o de 12 meses",
  ])("deixa passar: %s", (t) => expect(problemas(t)).toEqual([]));

  it("o brinde extra só passa no último toque; Anvisa nunca", () => {
    expect(problemas("ganhe um brinde extra")).not.toEqual([]);
    expect(problemas("ganhe um brinde extra", true)).toEqual([]);
    expect(problemas("aprovado na Anvisa", true)).not.toEqual([]);
  });
});
