import { render, screen } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * A lista de conversas só monta no DOM as linhas da janela visível.
 *
 * Com ~800 conversas por organização, a lista desenhava todas as linhas. O jsdom
 * não faz layout, então o teste dá tamanho ao que o virtualizador mede
 * (`offsetHeight`): a rolagem tem 600 px e cada linha 72 px.
 */

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (t: string) => t }));
vi.mock("@/hooks/channels/useChannelSessions", () => ({ useChannelSessions: () => ({ data: [] }) }));
vi.mock("@/hooks/ai/useAutomaticoAtivo", () => ({ useAutomaticoAtivo: () => ({ data: false }) }));
vi.mock("@/components/inbox/ConversationListItem", () => ({
  ConversationListItem: (p: {
    conversation: { id: string };
    isSelected: boolean;
    queuePosition?: number;
  }) => (
    <button
      data-conversation-id={p.conversation.id}
      aria-current={p.isSelected ? "true" : undefined}
      data-pos={p.queuePosition}
    >
      {p.conversation.id}
    </button>
  ),
}));

import { ConversationList } from "@/components/inbox/ConversationList";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";

const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute("data-lista-conversas") ? 600 : 72;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 320 });
});
afterAll(() => {
  if (original) Object.defineProperty(HTMLElement.prototype, "offsetHeight", original);
});

function lista(n: number) {
  return Array.from({ length: n }, (_, i) => ({ id: `c${String(i).padStart(4, "0")}` })) as ConversationWithContact[];
}
function consulta(data: ConversationWithContact[]) {
  return {
    isLoading: false,
    isError: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    data: { pages: [{ data, meta: { has_more: false } }], pageParams: [undefined] },
  } as never;
}
const montadas = () => document.querySelectorAll("[data-conversation-id]");

describe("lista virtualizada", () => {
  it("(f) com 800 conversas monta só a janela visível", () => {
    render(<ConversationList listQuery={consulta(lista(800))} filters={{}} selectedId={null} onSelect={() => {}} />);
    expect(montadas().length).toBeGreaterThan(0);
    expect(montadas().length).toBeLessThan(40);
  });

  it("a conversa selecionada fica montada mesmo fora da janela, com aria-current", () => {
    render(<ConversationList listQuery={consulta(lista(800))} filters={{}} selectedId="c0700" onSelect={() => {}} />);
    const sel = document.querySelector('[data-conversation-id="c0700"]');
    expect(sel).not.toBeNull();
    expect(sel?.getAttribute("aria-current")).toBe("true");
    expect(montadas().length).toBeLessThan(40);
  });

  it("a Fila numera pela posição na lista inteira, não pela janela", () => {
    render(
      <ConversationList
        listQuery={consulta(lista(800))}
        filters={{ comando: ["aguardando"] }}
        selectedId="c0700"
        onSelect={() => {}}
      />,
    );
    expect(document.querySelector('[data-conversation-id="c0700"]')?.getAttribute("data-pos")).toBe("701");
  });

  it("avisa o pai com TODOS os ids (j/k anda pela lista inteira, não só pela janela)", () => {
    const onVisibleChange = vi.fn();
    render(
      <ConversationList
        listQuery={consulta(lista(800))}
        filters={{}}
        selectedId={null}
        onSelect={() => {}}
        onVisibleChange={onVisibleChange}
      />,
    );
    expect(onVisibleChange).toHaveBeenLastCalledWith(expect.arrayContaining(["c0000", "c0799"]));
    expect(onVisibleChange.mock.lastCall?.[0]).toHaveLength(800);
  });

  it("lista vazia mostra o estado vazio e nenhuma linha", () => {
    render(<ConversationList listQuery={consulta([])} filters={{}} selectedId={null} onSelect={() => {}} />);
    expect(montadas().length).toBe(0);
    expect(screen.queryByText("c0000")).toBeNull();
  });
});
