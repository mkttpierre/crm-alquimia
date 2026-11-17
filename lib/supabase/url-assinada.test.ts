import { describe, expect, it, vi } from "vitest";

const estado = vi.hoisted(() => ({
  env: { NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321", SUPABASE_URL_INTERNA: "http://host.docker.internal:54321" },
}));
vi.mock("@/lib/env", () => ({ env: estado.env }));

import { urlAssinadaDoNavegador } from "./url-assinada";

describe("urlAssinadaDoNavegador (com o ambiente da instalação)", () => {
  it("troca o host interno pelo público", () => {
    expect(urlAssinadaDoNavegador("http://host.docker.internal:54321/storage/v1/object/sign/b/x.png?token=1")).toBe(
      "http://localhost:54321/storage/v1/object/sign/b/x.png?token=1",
    );
  });

  it("sem URL interna no ambiente, devolve a mesma URL", () => {
    estado.env.SUPABASE_URL_INTERNA = "";
    const url = "http://localhost:54321/storage/v1/object/sign/b/x.png?token=1";
    expect(urlAssinadaDoNavegador(url)).toBe(url);
  });
});
