import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET /api/v1/conversations/counts — os 4 contadores numa consulta só.
 *
 * Antes eram 4 `count=exact` em paralelo, e duas delas filtravam pelo campo
 * calculado `comando_da_conversa`: cada uma varria a org inteira e recalculava a
 * RLS por linha (medido: ~1,3 s cada numa organização, sob a RLS de um usuário comum). A RPC
 * `fn_contagem_inbox` (migration 0244, SECURITY INVOKER — herda a RLS de quem
 * pergunta) faz uma varredura e devolve os quatro números.
 *
 * O que estes casos vigiam: os conjuntos que decidem o badge continuam vindo do
 * TypeScript (`comandosDaFila`, `CONVERSATION_TERMINAL_STATUSES`) — o badge não
 * pode divergir da aba — e a forma da resposta não muda (`unassigned` = `fila`).
 */
const rpc = vi.fn();
const from = vi.fn();
let automatico: boolean | undefined = true;

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }) },
    rpc,
    from,
  }),
}));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: async () => ({ id: "user-1", idioma: "pt-BR" }),
  resolveActiveOrg: async () => ({ orgId: "org-1" }),
}));
vi.mock("@/lib/ai/agents/org-tem-automatico", () => ({
  orgTemAutomatico: async () => automatico,
}));

import { GET } from "@/app/api/v1/conversations/counts/route";
import { CONVERSATION_TERMINAL_STATUSES } from "@/lib/schemas";

beforeEach(() => {
  rpc.mockReset();
  from.mockReset();
  rpc.mockResolvedValue({
    data: [{ fila: 3, automatico: 5, mine: 2, total: 40 }],
    error: null,
  });
});

describe("contadores do inbox", () => {
  it("uma chamada só, com os conjuntos do TypeScript", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("fn_contagem_inbox", {
      p_org: "org-1",
      p_comandos_fila: ["aguardando"],
      p_terminais: [...CONVERSATION_TERMINAL_STATUSES],
    });
    expect(from).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.data).toEqual({ fila: 3, automatico: 5, unassigned: 3, mine: 2, all: 40 });
  });

  it("org sem automático: a Fila pede os dois comandos", async () => {
    automatico = false;
    await GET();
    expect(rpc.mock.calls[0]![1].p_comandos_fila).toEqual(["aguardando", "automatico"]);
    automatico = true;
  });

  it("erro do banco vira 500, não zero", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    const res = await GET();
    expect(res.status).toBe(500);
  });
});
