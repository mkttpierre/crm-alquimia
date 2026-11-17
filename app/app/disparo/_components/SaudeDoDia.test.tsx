/**
 * Painel diário de saúde da tela Disparo: uma linha por chip, com os números do dia e o motivo
 * do amarelo ou do vermelho. Só leitura — não há botão que devolva o chip.
 */
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ChipDaTela, SaudeDoDiaDaTela } from "@/lib/disparo-painel/esquemas";

import { SaudeDoDia } from "./SaudeDoDia";

const dia = (p: Partial<SaudeDoDiaDaTela> = {}): SaudeDoDiaDaTela => ({
  dia: "2026-10-16", saude: "verde", dia_rampa: 3, aberturas: 14, respostas: 3, aberturas_janela: 40, respostas_janela: 4, maduras: 10, com_ack: 10,
  bloqueio_provavel: 0, nao_quero: 1, irritacao: 0, reconexoes: 0, quedas: 0, motivos: [], calculado_em: "2026-10-16T15:00:00Z", ...p,
});

const chip = (p: Partial<ChipDaTela> = {}): ChipDaTela => ({
  id: "c1", nome: "chip-alfa", estado: "rampa", saude: "verde", dia_rampa: 3, channel_session_id: null, tem_canal: true, pausado_ate: null, proximo_envio_em: null,
  ultimo_envio_em: null, envios_hoje: 5, teto_hoje: 40, saude_motivo: null, saude_do_dia: dia(), ...p,
});

const linha = (nome: string) => screen.getByRole("row", { name: new RegExp(nome) });

describe("SaudeDoDia", () => {
  it("uma linha por chip com aberturas, respostas, bloqueio provável, não quero e irritação", () => {
    render(<SaudeDoDia chips={[chip(), chip({ id: "c2", nome: "chip-beta" })]} />);
    expect(screen.getAllByRole("row")).toHaveLength(3); // cabeçalho + 2 chips
    const l = within(linha("chip-alfa"));
    expect(l.getByText("Saúde boa")).toBeTruthy();
    expect(l.getByText("14")).toBeTruthy(); // aberturas
    expect(l.getByText("10,0%")).toBeTruthy(); // taxa: 4 de 40 em 7 dias, com 40 aberturas (>= 30)
    expect(l.getByText(/0 de 10/)).toBeTruthy(); // bloqueio provável sobre as com status de entrega
    expect(l.getByText(/7,1%/)).toBeTruthy(); // não quero: 1 de 14
    expect(l.getByText("Em rampa")).toBeTruthy();
  });

  it("amarelo e vermelho trazem o motivo do cálculo", () => {
    render(
      <SaudeDoDia
        chips={[
          chip({ saude: "amarelo", saude_do_dia: dia({ saude: "amarelo", irritacao: 1, motivos: [{ indicador: "irritacao", cor: "amarelo", texto: "1 resposta com irritação, spam, denúncia ou Procon no dia" }] }) }),
          chip({ id: "c2", nome: "chip-beta", estado: "pausado", saude: "vermelho", saude_do_dia: dia({ saude: "vermelho", quedas: 1, motivos: [{ indicador: "conexao", cor: "vermelho", texto: "Conexão caiu 1x no dia (close, 428 ou logout)" }] }) }),
        ]}
      />,
    );
    expect(within(linha("chip-alfa")).getByText("Saúde em atenção")).toBeTruthy();
    expect(within(linha("chip-alfa")).getByText(/1 resposta com irritação/)).toBeTruthy();
    expect(within(linha("chip-beta")).getByText("Saúde ruim")).toBeTruthy();
    expect(within(linha("chip-beta")).getByText(/Conexão caiu 1x/)).toBeTruthy();
    expect(within(linha("chip-beta")).getByText("Pausado")).toBeTruthy();
  });

  it("vermelho do freio de restrição (erro de envio) mostra o motivo gravado no chip, mesmo sem cálculo do dia", () => {
    render(<SaudeDoDia chips={[chip({ saude: "vermelho", saude_do_dia: null, saude_motivo: "Erro de envio com sinal de restrição: 428" })]} />);
    expect(screen.getByText(/Erro de envio com sinal de restrição: 428/)).toBeTruthy();
    expect(screen.getByText("Ainda sem cálculo hoje.")).toBeTruthy();
  });

  it("sem status de entrega da Evolution o bloqueio provável é 'sem dado', nunca zero nem problema", () => {
    render(<SaudeDoDia chips={[chip({ saude_do_dia: dia({ maduras: 12, com_ack: 0, bloqueio_provavel: 0 }) })]} />);
    expect(within(linha("chip-alfa")).getByText("sem dado")).toBeTruthy();
  });

  it("antes de 30 aberturas na janela a taxa de resposta não aparece", () => {
    render(<SaudeDoDia chips={[chip({ saude_do_dia: dia({ aberturas_janela: 29, respostas_janela: 0 }) })]} />);
    expect(within(linha("chip-alfa")).queryByText("0%")).toBeNull();
    expect(within(linha("chip-alfa")).getAllByText("—").length).toBeGreaterThan(0);
  });

  it("é só leitura: nenhum botão", () => {
    render(<SaudeDoDia chips={[chip({ saude: "vermelho" })]} />);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});
