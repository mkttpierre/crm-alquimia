import { fireEvent, render, screen } from "@testing-library/react";
import { DragDropContext } from "@hello-pangea/dnd";
import { describe, expect, it, vi } from "vitest";

/**
 * Coluna do funil com centenas de cards: uma organização pode ter milhares de leads, e montar todos
 * os `KanbanCard` (componente pesado, com slots) de uma vez trava a aba. A coluna
 * mostra os primeiros e oferece "Mostrar mais" — sempre um PREFIXO da lista, para
 * o índice do arrastar (`@hello-pangea/dnd`) continuar sendo o índice real que o
 * `handleDragEnd` do board usa para calcular a posição.
 */
vi.mock("@/components/kanban/KanbanCard", () => ({
  KanbanCard: ({ lead, index }: { lead: { id: string }; index: number }) => (
    <div data-testid="card" data-index={index}>
      {lead.id}
    </div>
  ),
}));

import { StageColumn, CARDS_POR_VEZ } from "@/components/kanban/StageColumn";
import type { Lead } from "@/lib/types/leads";
import type { Stage } from "@/lib/kanban/types";

const stage = { id: "s1", name: "Novo", color: null } as unknown as Stage;
const leads = Array.from(
  { length: 2 * CARDS_POR_VEZ + 7 },
  (_, i) => ({ id: `lead-${i}`, title: `Lead ${i}`, value_cents: 0 }) as unknown as Lead,
);

function montar() {
  return render(
    <DragDropContext onDragEnd={() => {}}>
      <StageColumn stage={stage} leads={leads} pipelineId="p1" />
    </DragDropContext>,
  );
}

describe("StageColumn com muitos leads", () => {
  it("monta só o primeiro bloco e mostra a contagem total no cabeçalho", () => {
    montar();
    const cards = screen.getAllByTestId("card");
    expect(cards).toHaveLength(CARDS_POR_VEZ);
    expect(cards[0]!.dataset.index).toBe("0");
    expect(screen.getByText(String(leads.length))).toBeTruthy();
  });

  it("'Mostrar mais' acrescenta o próximo bloco até acabar", () => {
    montar();
    fireEvent.click(screen.getByRole("button", { name: /mostrar mais/i }));
    expect(screen.getAllByTestId("card")).toHaveLength(2 * CARDS_POR_VEZ);
    fireEvent.click(screen.getByRole("button", { name: /mostrar mais/i }));
    expect(screen.getAllByTestId("card")).toHaveLength(leads.length);
    expect(screen.queryByRole("button", { name: /mostrar mais/i })).toBeNull();
  });
});

/**
 * Coluna paginada no servidor: a coluna recebe só a primeira página e o TOTAL
 * real da etapa. O contador e o "Mostrar mais (N)" falam do total, e o botão
 * pede a página seguinte em vez de só revelar o que já estava na memória.
 */
describe("StageColumn paginada no servidor", () => {
  const pagina = leads.slice(0, CARDS_POR_VEZ);

  function montarPaginada(lista: Lead[], onLoadMore = vi.fn()) {
    const ui = (l: Lead[]) => (
      <DragDropContext onDragEnd={() => {}}>
        <StageColumn
          stage={stage}
          leads={l}
          pipelineId="p1"
          total={1485}
          onLoadMore={onLoadMore}
        />
      </DragDropContext>
    );
    const r = render(ui(lista));
    return { ...r, onLoadMore, rerenderCom: (l: Lead[]) => r.rerender(ui(l)) };
  }

  it("o contador mostra o total da etapa, não o tamanho da página", () => {
    montarPaginada(pagina);
    expect(screen.getByText("1485")).toBeTruthy();
    expect(screen.getByRole("button", { name: /mostrar mais \(1435\)/i })).toBeTruthy();
  });

  it("'Mostrar mais' pede a página seguinte e monta os cards quando chegam", () => {
    const { onLoadMore, rerenderCom } = montarPaginada(pagina);
    fireEvent.click(screen.getByRole("button", { name: /mostrar mais/i }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
    rerenderCom(leads.slice(0, 2 * CARDS_POR_VEZ));
    const cards = screen.getAllByTestId("card");
    expect(cards).toHaveLength(2 * CARDS_POR_VEZ);
    // prefixo contínuo: o índice do arrastar continua o índice real da lista
    expect(cards.map((c) => Number(c.dataset.index))).toEqual(
      Array.from({ length: 2 * CARDS_POR_VEZ }, (_, i) => i),
    );
  });

  it("sem mais nada no servidor, o botão some", () => {
    render(
      <DragDropContext onDragEnd={() => {}}>
        <StageColumn stage={stage} leads={pagina} pipelineId="p1" total={CARDS_POR_VEZ} onLoadMore={vi.fn()} />
      </DragDropContext>,
    );
    expect(screen.queryByRole("button", { name: /mostrar mais/i })).toBeNull();
  });

  describe("selecionar a etapa", () => {
    const ids = pagina.map((l) => l.id);

    function comSelecao(total: number, selecionados: string[], onSelectMany = vi.fn()) {
      render(
        <DragDropContext onDragEnd={() => {}}>
          <StageColumn
            stage={stage}
            leads={pagina}
            pipelineId="p1"
            total={total}
            onLoadMore={vi.fn()}
            selectedLeadIds={new Set(selecionados)}
            onSelectMany={onSelectMany}
          />
        </DragDropContext>,
      );
      return { onSelectMany, caixa: screen.getByRole("checkbox") as HTMLInputElement };
    }

    it("com mais leads no servidor, marcar os carregados NÃO enche o checkbox e o contador diz N/total", () => {
      const { caixa } = comSelecao(1485, ids);
      expect(caixa.checked).toBe(false);
      expect(caixa.indeterminate).toBe(true);
      expect(screen.getByText(`${CARDS_POR_VEZ}/1485`)).toBeTruthy();
    });

    it("o clique no checkbox parcial desmarca os carregados (alterna o que a seleção alcança)", () => {
      const { caixa, onSelectMany } = comSelecao(1485, ids);
      fireEvent.click(caixa);
      expect(onSelectMany).toHaveBeenCalledWith(ids, false);
    });

    it("sem nada no servidor, marcar todos enche o checkbox", () => {
      const { caixa } = comSelecao(CARDS_POR_VEZ, ids);
      expect(caixa.checked).toBe(true);
      expect(caixa.indeterminate).toBe(false);
    });
  });
});
