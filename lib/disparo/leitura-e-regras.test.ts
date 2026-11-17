// Portado de `um CRM anterior` e do verificador da organização B
// (`um projeto anterior`), mais as regras de parada dos dois.
import { describe, expect, it } from "vitest";

import { CADENCIAS, horaDoPasso, proximoPasso } from "./cadencia";
import { ritmoSchema } from "./config";
import { combinar, ehSoAceite, kitDoTexto, lerMensagem } from "./leitura";
import {
  automaticasSeguidas,
  irritado,
  lerResposta,
  motivoParaNaoContatar,
  podeResponderSozinho,
  respostaAutomatica,
  telefoneFixo,
} from "./regras";
import { relogio } from "./ritmo";
import { montar, primeiroNome, slotsPadrao, verificarTexto } from "./textos";

const int = (t: string) => lerMensagem(t).intencao;

describe("leitura por regras (exemplo)", () => {
  it("recusa com negação antes ou depois de querer vence uma leitura positiva da IA", () => {
    for (const texto of ["Quero mais ñ.", "quero mais não", "n quero", "não quero mais", "quero não", "nao quero"]) {
      expect(combinar(lerMensagem(texto), { intencao: "elogio", confianca: 0.95 }).intencao, texto).toBe("nao_quer_mais");
    }
  });

  it("reconhece dúvida de preço mesmo quando o Jev entende elogio", () => {
    for (const texto of ["Conta pra mim só não sei se cabe no meu bolso cliquei por concelhos da lin...", "quanto?", "valor?", "preço?", "conta pra mim"]) {
      expect(combinar(lerMensagem(texto), { intencao: "elogio", confianca: 0.95 }).intencao, texto).toBe("pergunta_preco");
    }
    expect(combinar(lerMensagem("caro"), { intencao: "elogio", confianca: 0.95 }).intencao).toBe("objecao_preco");
    expect(combinar(lerMensagem("valor?"), { intencao: "interesse", confianca: 0.95 }).intencao).toBe("pergunta_preco");
  });

  it("identifica pessoa errada nas respostas reais e deixa link para o operador", () => {
    expect(int("Opa\nEla trocou de número")).toBe("numero_errado");
    expect(int("Boa tarde Dr. Acho que se enganou de paciente, não faço tratamento de pele\nInfelizmente")).toBe("numero_errado");
    expect(int("https://exemplo.com/video/1")).toBe("outro");
  });
  it("preço, entrega e interesse", () => {
    expect(int("Quanto custa?")).toBe("pergunta_preco");
    expect(int("me manda os valores")).toBe("pergunta_preco");
    expect(int("Quanto tempo demora pra chegar?")).toBe("pergunta_entrega");
    expect(int("sim, pode contar")).toBe("interesse");
    expect(int("como funciona?")).toBe("interesse");
  });

  it("fechar e escolher kit", () => {
    expect(int("quero comprar")).toBe("quer_fechar");
    expect(int("me manda o pix")).toBe("quer_fechar");
    const l = lerMensagem("quero o de 12 meses");
    expect(l.intencao).toBe("escolheu_kit");
    expect(l.kit).toBe("12 meses");
    expect(kitDoTexto("3 frascos")).toBe("3 frascos");
  });

  it("objeções", () => {
    expect(int("achei caro")).toBe("objecao_preco");
    expect(int("será que funciona mesmo?")).toBe("objecao_funciona");
    expect(int("tenho medo de golpe")).toBe("objecao_medo");
    expect(int("posso pagar na entrega?")).toBe("pagamento");
    expect(int("vou pensar")).toBe("objecao_tempo");
    expect(int("só quando o cartão virar")).toBe("sem_dinheiro_agora");
    expect(int("agora não tenho dinheiro")).toBe("sem_dinheiro_agora");
  });

  it("não quero com motivo de preço é objeção, não recusa", () => {
    expect(int("não quero, está caro")).toBe("objecao_preco");
    expect(int("não, obrigada")).toBe("nao_quer_mais");
  });

  it("parada dura e irritação", () => {
    expect(int("para de me mandar mensagem")).toBe("parada");
    expect(int("onde você conseguiu meu número?")).toBe("parada");
    expect(int("número errado")).toBe("numero_errado");
    expect(lerMensagem("vou denunciar vocês, golpistas").irritada).toBe(true);
  });

  it("reclamação não vende", () => {
    expect(int("o produto que comprei não funcionou")).toBe("reclamacao");
    expect(int("nunca chegou meu pedido")).toBe("reclamacao");
  });

  it("a regra de parada sempre vence a IA", () => {
    const r = combinar(lerMensagem("para de me mandar mensagem"), { intencao: "interesse", confianca: 0.95, quente: 0.9 });
    expect(r.intencao).toBe("parada");
    expect(r.discordou).toBe(true);
  });

  it("IA confiante decide; sem confiança ficam as regras; reclamação das regras vale mais", () => {
    const regras = lerMensagem("hmm ok");
    expect(combinar(regras, { intencao: "pergunta_preco", confianca: 0.9 }).intencao).toBe("pergunta_preco");
    expect(combinar(regras, { intencao: "pergunta_preco", confianca: 0.4 }).intencao).toBe(regras.intencao);
    expect(combinar(lerMensagem("não funcionou, quero estorno"), { intencao: "interesse", confianca: 0.95 }).intencao).toBe("reclamacao");
  });

  it("aceite seco é só aceite; compra de verdade não", () => {
    for (const t of ["Quero sim", "quero", "Pode", "sim, quero", "claro!", "Pode sim", "quero saber"]) expect(ehSoAceite(t)).toBe(true);
    for (const t of ["quero comprar", "quero o de 12 meses", "boa tarde", "quero parar"]) expect(ehSoAceite(t)).toBe(false);
  });
});

describe("regras de parada (organizações A e B)", () => {
  it("parada dura, recusa e conversa", () => {
    expect(lerResposta("pare de me chamar")).toBe("parada");
    expect(lerResposta("PARE")).toBe("parada");
    expect(lerResposta("não aceitamos propostas comerciais")).toBe("parada");
    expect(lerResposta("pode tirar meu número da lista")).toBe("parada");
    expect(lerResposta("não quero, pode tirar meu número da lista")).toBe("parada");
    expect(lerResposta("remove meu contato")).toBe("parada");
    expect(lerResposta("não tenho interesse")).toBe("nao_quer_mais");
    expect(lerResposta("não quero perder paciente")).toBe("conversa");
    expect(lerResposta("aqui não é a clínica")).toBe("numero_errado");
    expect(lerResposta("quanto custa?")).toBe("conversa");
  });

  it("'golpe' sozinho é escolha da casa", () => {
    expect(lerResposta("isso é golpe?")).toBe("conversa");
    expect(lerResposta("isso é golpe?", { golpeEhParada: true })).toBe("parada");
    expect(irritado("isso é golpe?")).toBe(false);
    expect(irritado("vou chamar a polícia")).toBe(true);
  });

  it("resposta automática só quando chega logo depois e tem cara de modelo; aviso de empresa sempre", () => {
    expect(respostaAutomatica("Olá! Seja bem-vindo(a) à clínica", 16)).toBe(true);
    expect(respostaAutomatica("Olá! Seja bem-vindo(a) à clínica", 600)).toBe(false);
    expect(respostaAutomatica("Oi, tudo bem, quem é?", 10)).toBe(false);
    expect(respostaAutomatica("Sua fatura vence amanhã. Não responda esta mensagem", null)).toBe(true);
  });

  it("no máximo 2 respostas automáticas seguidas sem o operador no meio", () => {
    expect(automaticasSeguidas(["auto", "auto", "motor"])).toBe(2);
    expect(podeResponderSozinho(["auto", "auto"], 2)).toBe(false);
    expect(podeResponderSozinho(["auto", "operador", "auto"], 2)).toBe(true);
    expect(podeResponderSozinho([], 2)).toBe(true);
  });

  it("não contatar: bloqueado, anonimizado, encerrado, sem telefone; fixo não recebe abertura", () => {
    const base = { bloqueado: false, anonimizado: false, status: "open", telefone: "+5511999990000" };
    expect(motivoParaNaoContatar(base)).toBeNull();
    expect(motivoParaNaoContatar({ ...base, bloqueado: true })).toMatch(/não contatar/);
    expect(motivoParaNaoContatar({ ...base, anonimizado: true })).toMatch(/LGPD/);
    expect(motivoParaNaoContatar({ ...base, status: "won" })).toMatch(/encerrado/);
    expect(motivoParaNaoContatar({ ...base, telefone: null })).toMatch(/telefone/);
    expect(telefoneFixo("+55 11 3333-4444")).toBe(true);
    expect(telefoneFixo("+5511999990000")).toBe(false);
  });
});

describe("textos: montar e verificador", () => {
  const agora = new Date("2026-10-07T10:00:00-03:00");

  it("atalhos de saudação de uma organização, com e sem nome", () => {
    const com = slotsPadrao("Maria das Graças", agora, -180);
    expect(montar("{oi} Tudo bem?", com).texto).toBe("Oi, Maria! Tudo bem?");
    expect(montar("{saudacao}{virg_nome}!", com).texto).toBe("Bom dia, Maria!");
    const sem = slotsPadrao("+55 11 90000-0001", agora, -180);
    expect(montar("{nome_virgula}lembrei de você hoje.", sem).texto).toBe("Lembrei de você hoje.");
    expect(montar("{oi} Tudo bem?", sem).texto).toBe("Oi! Tudo bem?");
    expect(primeiroNome("Dra. Ana")).toBeNull();
  });

  it("slot desconhecido volta em faltando e o verificador barra", () => {
    const r = montar("Oi, {clinica}!", {});
    expect(r.faltando).toEqual(["clinica"]);
    expect(verificarTexto(r.texto)).toContain("tem campo sem preencher");
  });

  it("mensagem nova sem preço e sem link; regras da casa, com a última cartada só no último toque", () => {
    expect(verificarTexto("Fica R$ 1.500", { prospeccao: true })).toContain("mensagem nova fala de preço");
    expect(verificarTexto("veja https://x.com", { prospeccao: true })).toContain("mensagem nova tem link");
    expect(verificarTexto("veja https://meet.google.com/x", { prospeccao: true, permitirLink: true })).toEqual([]);
    const proibidos = [
      { padrao: "brinde (extra|a mais)", motivo: "cita brinde extra fora do último toque", excetoUltimo: true },
      { padrao: "anvisa", motivo: "cita Anvisa" },
      { padrao: "[—–]|\\s-\\s", motivo: "tem travessão" },
      { padrao: "(", motivo: "regex quebrada não derruba" },
    ];
    expect(verificarTexto("um brinde extra de presente", { proibidos })).toEqual(["cita brinde extra fora do último toque"]);
    expect(verificarTexto("um brinde extra de presente", { proibidos, ultimoToque: true })).toEqual([]);
    expect(verificarTexto("aprovado pela Anvisa", { proibidos, ultimoToque: true })).toEqual(["cita Anvisa"]);
    expect(verificarTexto("é simples — e rápido", { proibidos })).toEqual(["tem travessão"]);
  });
});

describe("cadência da organização B (14 dias corridos)", () => {
  const cad = CADENCIAS["prospeccao_14_dias"]!;
  const alq = ritmoSchema.parse({
    janela: { semana: [{ inicio: 480, fim: 720 }, { inicio: 780, fim: 1080 }], sabado: [], domingo: [] },
  });
  const sp = (iso: string) => new Date(`${iso}-03:00`);
  const dia = (d: Date) => relogio(d, -180);

  it("D2, D7 e D14 automáticos; D4 áudio e D10 ligação só lembrete", () => {
    expect(cad.passos.filter((p) => p.automatico).map((p) => p.tipo)).toEqual(["abertura", "d2", "d7", "d14"]);
    expect(cad.passos.filter((p) => !p.automatico).map((p) => [p.tipo, p.lembrete])).toEqual([
      ["d4", "audio"],
      ["d10", "ligacao"],
    ]);
    expect(proximoPasso(cad, "d14")).toBeNull();
  });

  it("conta dias corridos da D1, passa fim de semana para segunda e evita o almoço", () => {
    const d1 = sp("2026-10-07T10:00:00"); // quarta
    const d2 = horaDoPasso(cad, cad.passos[1]!, d1, alq, () => 0);
    expect(dia(d2).data).toBe("2026-10-08");
    expect(dia(d2).minuto).toBe(600);
    const d4 = horaDoPasso(cad, cad.passos[2]!, d1, alq, () => 0); // sábado 10/10 → segunda 12/10 (feriado) → terça 13/10
    expect(dia(d4).data).toBe("2026-10-13");
    const almoco = horaDoPasso(cad, cad.passos[1]!, sp("2026-10-07T11:55:00"), alq, () => 0.99);
    const m = dia(almoco).minuto;
    expect(m >= 780 && m < 1080).toBe(true);
  });
});
