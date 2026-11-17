import { render, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthUser } from "@/lib/auth/types";

/**
 * /api/v1/auth/realtime-token era pedido DUAS vezes por página (auditoria de
 * 26/10/2026, P8).
 *
 * O mecanismo: o React roda os efeitos dos filhos ANTES dos do pai. O canal do
 * tempo real (filho) monta e já dispara a busca do token; logo depois o efeito
 * do `AuthProvider` (pai) chamava `resetRealtimeAuthentication()` — na
 * MONTAGEM, quando não há nada para invalidar. O reset trocava a época,
 * descartava a resposta em voo, o bootstrap falhava e o canal só voltava 1 s
 * depois, pedindo o token de novo.
 *
 * O reset certo é o da SAÍDA do contexto (troca de usuário/org/suporte ou
 * desmontagem), que a função de limpeza do efeito já faz. Este teste usa o
 * módulo REAL de `lib/supabase/browser` — com ele mockado, como em
 * `organizacoes-cache-por-contexto.test.tsx`, o defeito não aparece.
 */

const user = {
  id: "user-a", organizations: [], idioma: "pt-BR", email: "a@example.test",
  full_name: null, avatar_url: null, is_platform_admin: false,
} as AuthUser;

describe("token do realtime", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock("@supabase/ssr", () => ({
      createBrowserClient: vi.fn(() => ({
        auth: { refreshSession: vi.fn() },
        realtime: { setAuth: vi.fn(async () => {}) },
      })),
    }));
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key-de-teste");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.doUnmock("@supabase/ssr");
  });

  it("montar a página pede o token UMA vez, mesmo com o provider montando junto", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: { access_token: "jwt", expires_at: Math.floor(Date.now() / 1000) + 3600 },
      }),
    });
    vi.stubGlobal("fetch", fetcher);

    const { AuthProvider } = await import("@/hooks/auth/AuthProvider");
    const { prepareRealtimeAuthentication } = await import("@/lib/supabase/browser");

    // Faz o papel de useRealtimeChannel: pede a autenticação no efeito de montagem.
    // Se o bootstrap rejeitar, o hook real agenda nova tentativa (1 s) e pede o token de novo.
    const bootstrap: Array<"ok" | "recusado"> = [];
    function Canal() {
      useEffect(() => {
        prepareRealtimeAuthentication().then(
          () => bootstrap.push("ok"),
          () => bootstrap.push("recusado"),
        );
      }, []);
      return null;
    }

    render(
      <AuthProvider user={user} activeOrg={{ orgId: "org-a", name: "A", role: "admin" }}>
        <Canal />
      </AuthProvider>,
    );

    await waitFor(() => expect(bootstrap).toHaveLength(1));
    expect(bootstrap, "o reset da montagem descartou a resposta em voo").toEqual(["ok"]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
