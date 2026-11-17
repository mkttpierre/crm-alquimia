/**
 * O motor trata o follow-up do kit e a oferta do Método (planejados pelo atendimento, origem `motor`) como
 * mensagens NOVAS: janela, vez do chip, freios de saúde e verificador de prospecção valem. Já D7 e D14 do
 * Método (depois do pagamento) são resposta ao cliente: só o ritmo do chip.
 */
import { describe, expect, it, vi } from "vitest";

import { configDoMotor, motorEmMemoria, SEM_AVISO } from "./apoio-do-motor-teste";
import { rodarDisparo, type LeadDoDisparo } from "./motor";

const ORG = "00000000-0000-4000-8000-000000000009";
const QUARTA = new Date("2026-10-14T13:00:00Z"); // 10h em Brasília, dentro da janela
const DOMINGO_NOITE = new Date("2026-10-19T00:00:00Z"); // domingo 21h em Brasília, fora da janela

const lead: LeadDoDisparo = { id: "lead-1", nome: "Maria", telefone: "+5511999990000", status: "open", bloqueado: false, anonimizado: false, grupo: null, campos: {} };

function volta(agora: Date, envio: { tipo: string; texto: string }, ajuste: (m: ReturnType<typeof motorEmMemoria>) => void = () => undefined) {
  const config = { ...configDoMotor(ORG, "simulado"), fonteStageId: null };
  const m = motorEmMemoria(agora, config, [lead]);
  ajuste(m);
  return {
    m,
    async rodar() {
      await m.repo.enfileirar(ORG, { leadId: lead.id, chipId: "chip-1", origem: "motor", enviarApos: new Date(agora.getTime() - 60_000), ...envio });
      await rodarDisparo({ repo: m.repo, agora, ambiente: {}, sortear: () => 0.5, enviarReal: vi.fn(), enviarAviso: SEM_AVISO });
      return m.envios[0]!;
    },
  };
}

describe("motor: toques do follow-up do kit", () => {
  it("dentro da janela o toque sai (simulado) e a vez do chip anda como em qualquer mensagem nova", async () => {
    const v = volta(QUARTA, { tipo: "kit_t1_261014130000", texto: "Maria, ficou alguma dúvida sobre os tratamentos?" });
    const vezAntes = v.m.chip.proximoEnvioEm!.getTime();
    const e = await v.rodar();
    expect(e.estado).toBe("simulado");
    expect(v.m.chip.proximoEnvioEm!.getTime()).toBeGreaterThan(vezAntes);
    expect(v.m.envios).toHaveLength(1); // não há "próximo passo da cadência" a planejar: o atendimento já gravou os 7
  });

  it("fora da janela de prospecção o toque espera; D7 do Método (resposta ao cliente) sai", async () => {
    const toque = await volta(DOMINGO_NOITE, { tipo: "kit_t2_261014130000", texto: "Uma coisa que muita gente me pergunta: o Produto A é simples de usar." }).rodar();
    expect(toque.estado).toBe("pendente");
    const d7 = await volta(DOMINGO_NOITE, { tipo: "metodo_d7", texto: "Uma semana! Como está indo?" }).rodar();
    expect(d7.estado).toBe("simulado");
  });

  it("chip em saúde vermelha não manda toque (freio de saúde)", async () => {
    const e = await volta(QUARTA, { tipo: "kit_t3_261014130000", texto: "O que mais pesa para você agora?" }, (m) => {
      m.chip.saude = "vermelho";
    }).rodar();
    expect(e.estado).toBe("pendente");
  });

  it("toque com preço é barrado como prospecção; a oferta do Método (que fala de R$ 30) não", async () => {
    const toque = await volta(QUARTA, { tipo: "kit_t4_261014130000", texto: "Hoje fica R$ 30 no Pix" }).rodar();
    expect(toque.estado).toBe("cancelado");
    expect(toque.motivo).toMatch(/preço/);
    const oferta = await volta(QUARTA, { tipo: "metodo_oferta_261014130000_p4", texto: "São R$ 30, uma vez só, no Pix." }).rodar();
    expect(oferta.estado).toBe("simulado");
    const primeira = await volta(QUARTA, { tipo: "metodo_oferta_261014130000", texto: "Entendo que agora não é o momento do plano completo." }).rodar();
    expect(primeira.estado).toBe("simulado");
  });
});

/**
 * Conferência na hora de ENVIAR: o follow-up é planejado dias antes, e a lead pode ter comprado, entrado em
 * quarentena, pedido para parar ou caído no colo do operador nesse meio-tempo. O motor olha de novo.
 */
describe("motor: o estado da lead é conferido de novo na hora de enviar (toques, oferta, D7/D14)", () => {
  const LIVRE = { cliente: false, metodoPago: false, precisaOperador: false, quarentenaAte: null as Date | null };
  type Situacao = typeof LIVRE;
  const comSituacao = (s: Partial<Situacao>) => (m: ReturnType<typeof motorEmMemoria>) => {
    m.repo.situacaoDoKit = async () => ({ ...LIVRE, ...s });
  };
  const TIPOS = [
    ["toque do kit", "kit_t3_261014130000"],
    ["oferta do Método", "metodo_oferta_261014130000"],
    ["D7 do Método", "metodo_d7"],
    ["D14 do Método", "metodo_d14"],
  ] as const;
  const TEXTO = "O que mais pesa para você agora?";

  it.each(TIPOS)("%s sai quando nada mudou", async (_n, tipo) => {
    const e = await volta(QUARTA, { tipo, texto: TEXTO }, comSituacao({})).rodar();
    expect(e.estado).toBe("simulado");
  });

  it.each(TIPOS)("%s é cancelado se a lead virou cliente (trilha de cliente)", async (_n, tipo) => {
    const v = volta(QUARTA, { tipo, texto: TEXTO }, comSituacao({ cliente: true }));
    const e = await v.rodar();
    expect(e.estado).toBe("cancelado");
    expect(e.motivo).toMatch(/cliente/);
  });

  it.each(TIPOS.slice(0, 2))("%s é cancelado se o Método já foi pago", async (_n, tipo) => {
    const e = await volta(QUARTA, { tipo, texto: TEXTO }, comSituacao({ metodoPago: true })).rodar();
    expect(e.estado).toBe("cancelado");
    expect(e.motivo).toMatch(/comprou|pago/);
  });

  it.each(TIPOS.slice(2))("%s (feito para quem pagou o Método) não é barrado pela marca de Método pago", async (_n, tipo) => {
    const e = await volta(QUARTA, { tipo, texto: TEXTO }, comSituacao({ metodoPago: true })).rodar();
    expect(e.estado).toBe("simulado");
  });

  it.each(TIPOS)("%s é cancelado com a lead em quarentena", async (_n, tipo) => {
    const e = await volta(QUARTA, { tipo, texto: TEXTO }, comSituacao({ quarentenaAte: new Date(QUARTA.getTime() + 86_400_000) })).rodar();
    expect(e.estado).toBe("cancelado");
    expect(e.motivo).toMatch(/quarentena/);
  });

  it.each(TIPOS)("%s sai se a quarentena já acabou", async (_n, tipo) => {
    const e = await volta(QUARTA, { tipo, texto: TEXTO }, comSituacao({ quarentenaAte: new Date(QUARTA.getTime() - 1000) })).rodar();
    expect(e.estado).toBe("simulado");
  });

  it.each(TIPOS)("%s é cancelado se a conversa precisa do operador", async (_n, tipo) => {
    const e = await volta(QUARTA, { tipo, texto: TEXTO }, comSituacao({ precisaOperador: true })).rodar();
    expect(e.estado).toBe("cancelado");
    expect(e.motivo).toMatch(/operador/);
  });

  it.each(TIPOS)("%s é cancelado se a conversa está pausada (humano no comando)", async (_n, tipo) => {
    const e = await volta(QUARTA, { tipo, texto: TEXTO }, (m) => {
      m.humano.set(lead.id, { forceHuman: false, conversas: [{ botSilencedUntil: "infinity", assigneeKind: null, assignedToUserId: null }] });
    }).rodar();
    expect(e.estado).toBe("cancelado");
    expect(e.motivo).toMatch(/humano/);
  });

  it.each(TIPOS)("%s é cancelado se a lead respondeu depois do agendamento", async (_n, tipo) => {
    const e = await volta(QUARTA, { tipo, texto: TEXTO }, (m) => {
      m.repo.respostasDesde = async () => ["oi, tenho uma dúvida"];
    }).rodar();
    expect(e.estado).toBe("cancelado");
    expect(e.motivo).toMatch(/escreveu/);
  });

  it.each(TIPOS)("%s é cancelado, e a fila toda da lead com ele, se ela pediu para parar", async (_n, tipo) => {
    const v = volta(QUARTA, { tipo, texto: TEXTO }, (m) => {
      m.repo.respostasDesde = async () => ["pare de me mandar mensagem"];
    });
    await v.m.repo.enfileirar(ORG, { leadId: lead.id, chipId: "chip-1", origem: "motor", tipo: "kit_t5_261014130000", texto: TEXTO, enviarApos: new Date(QUARTA.getTime() + 86_400_000) });
    const e = await v.rodar();
    expect(e.estado).toBe("cancelado");
    expect(e.motivo).toMatch(/parar/);
    expect(v.m.envios.every((x) => x.estado === "cancelado")).toBe(true);
  });

  it("cancelar por compra leva junto o resto da fila da lead", async () => {
    const v = volta(QUARTA, { tipo: "kit_t3_261014130000", texto: TEXTO }, comSituacao({ cliente: true }));
    await v.m.repo.enfileirar(ORG, { leadId: lead.id, chipId: "chip-1", origem: "motor", tipo: "kit_t6_261014130000", texto: TEXTO, enviarApos: new Date(QUARTA.getTime() + 86_400_000) });
    await v.rodar();
    expect(v.m.envios.map((x) => x.estado)).toEqual(["cancelado", "cancelado"]);
  });

  it("repositório sem a consulta (config antiga) segue como antes", async () => {
    const e = await volta(QUARTA, { tipo: "kit_t3_261014130000", texto: TEXTO }).rodar();
    expect(e.estado).toBe("simulado");
  });
});
