import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ItemsBar } from "@/components/inbox/composer/ItemsBar";
import type { ItemDeAtalho } from "@/lib/inbox/atalhos/tipos";

const itens: ItemDeAtalho[] = [
  { tipo: "funil", id: "f1", nome: "Funil de valores", atalho: "funil-valores", palavrasChave: ["valores"], favorito: false, resumo: "7 mensagens · ~1 min 20 s" },
  { tipo: "audio", id: "a1", nome: "Áudio valores", atalho: null, palavrasChave: [], favorito: false, resumo: "Áudio" },
  { tipo: "mensagem", id: "m1", nome: "Boas-vindas", atalho: null, palavrasChave: [], favorito: false, resumo: "Oi!" },
];

beforeEach(() => {
  vi.useFakeTimers();
  try {
    window.localStorage.clear();
  } catch {
    /* sem storage */
  }
});
afterEach(() => vi.useRealTimers());

function montar(texto: string) {
  const onEscolher = vi.fn();
  const onFechar = vi.fn();
  const r = render(<ItemsBar texto={texto} itens={itens} onEscolher={onEscolher} onFechar={onFechar} />);
  act(() => void vi.advanceTimersByTime(400));
  return { ...r, onEscolher, onFechar };
}

describe("ItemsBar — a barra de atalhos do chat (mensagens prontas)", () => {
  it("digitar 'valores' e esperar 400 ms mostra o cartão do funil", () => {
    montar("valores");
    expect(screen.getByRole("button", { name: /Funil de valores/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Áudio valores/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Boas-vindas/ })).toBeNull();
  });

  it("antes dos 400 ms não mostra nada (não pisca a cada letra)", () => {
    const onEscolher = vi.fn();
    render(<ItemsBar texto="valores" itens={itens} onEscolher={onEscolher} onFechar={() => {}} />);
    act(() => void vi.advanceTimersByTime(200));
    expect(screen.queryByRole("button", { name: /Funil de valores/ })).toBeNull();
  });

  it("clicar no cartão chama onEscolher com o item", () => {
    const m = montar("valores");
    fireEvent.click(screen.getByRole("button", { name: /Funil de valores/ }));
    expect(m.onEscolher).toHaveBeenCalledWith(expect.objectContaining({ id: "f1", tipo: "funil" }));
  });

  it("Esc num cartão fecha a barra", () => {
    const m = montar("valores");
    fireEvent.keyDown(screen.getByRole("button", { name: /Funil de valores/ }), { key: "Escape" });
    expect(m.onFechar).toHaveBeenCalled();
  });

  it("Enter com um cartão em foco escolhe; → passa para o próximo", () => {
    const m = montar("valores");
    const primeiro = screen.getByRole("button", { name: /Funil de valores/ });
    primeiro.focus();
    fireEvent.keyDown(primeiro, { key: "ArrowRight" });
    expect(document.activeElement?.textContent).toMatch(/Áudio valores/);
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    expect(m.onEscolher).toHaveBeenCalledWith(expect.objectContaining({ id: "a1" }));
  });

  it("frase digitada + Enter fora da barra não escolhe nada", () => {
    const m = montar("valores ok me manda");
    fireEvent.keyDown(document.body, { key: "Enter" });
    expect(m.onEscolher).not.toHaveBeenCalled();
  });

  it("o filtro 'Áudios' esconde o funil", () => {
    montar("valores");
    fireEvent.click(screen.getByRole("button", { name: /Filtrar atalhos/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Funis/ }));
    expect(screen.queryByRole("button", { name: /Funil de valores/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Áudio valores/ })).toBeTruthy();
  });

  it("texto que não casa com nada mostra o aviso com o caminho para criar", () => {
    montar("xyz");
    expect(screen.getByText(/Nenhum atalho/)).toBeTruthy();
  });

  it("texto vazio não mostra a barra", () => {
    const { container } = montar("");
    expect(container.textContent).toBe("");
  });
});

describe("a faixa de cartões não alarga a conversa (15/11/2026)", () => {
  // Bug: com muitos cartões, a faixa media a largura de TODOS eles e empurrava o painel do contato e os
  // botões do topo (Assumir, Transferir...) para fora da tela. `contain: inline-size` faz a largura da faixa
  // não depender dos cartões: ela ocupa o que sobra e rola de lado. `min-w-0` sozinho não resolve (medido no
  // navegador: painel em x=2768 com min-w-0, x=1683 com contain).
  it("a faixa rolável tem contain: inline-size", () => {
    montar("valores");
    const faixa = screen.getByRole("button", { name: /Funil de valores/ }).parentElement!;
    expect(faixa.className).toMatch(/overflow-x-auto/);
    expect(faixa.className).toMatch(/\[contain:inline-size\]/);
  });
});
