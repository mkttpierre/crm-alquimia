/**
 * O cache de verdade do gasto do Meta é o `unstable_cache` do Next, por organização+conta+período+moeda.
 * Aqui só se prova a COLA: chave e validade chegam como pedidas, e o que a função lança passa direto (o `unstable_cache`
 * não guarda o que lança, e é isso que impede uma falha da plataforma de ficar 15 minutos na tela).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { unstableCache, usos } = vi.hoisted(() => ({
  unstableCache: vi.fn(),
  usos: [] as Array<{ chave: readonly string[]; opcoes: { revalidate?: number; tags?: string[] } }>,
}));

vi.mock("next/cache", () => ({ unstable_cache: unstableCache }));

import { memorizarNoServidor } from "./meta";

beforeEach(() => {
  usos.length = 0;
  unstableCache.mockReset();
  unstableCache.mockImplementation((fn: () => Promise<unknown>, chave: readonly string[], opcoes: { revalidate?: number; tags?: string[] }) => {
    usos.push({ chave, opcoes });
    return fn;
  });
});

describe("memorizarNoServidor", () => {
  it("⭐ entrega ao unstable_cache a chave e a validade em segundos, e devolve o que a função devolveu", async () => {
    const r = await memorizarNoServidor(["gasto-meta", "org-1", "act_1"], 900, async () => ({ gasto: 10 }));
    expect(r).toEqual({ gasto: 10 });
    expect(usos).toEqual([{ chave: ["gasto-meta", "org-1", "act_1"], opcoes: { revalidate: 900 } }]);
  });

  it("o que a função lança passa direto (nada de engolir erro para guardá-lo)", async () => {
    await expect(
      memorizarNoServidor(["k"], 60, async () => {
        throw new Error("plataforma fora do ar");
      }),
    ).rejects.toThrow("plataforma fora do ar");
  });
});
