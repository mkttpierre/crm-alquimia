import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { urlAssinadaParaONavegador, urlDoSupabaseNoServidor } from "./url-do-servidor";
import { urlParaOCanal } from "../messaging/media/url-para-o-canal";

describe("urlDoSupabaseNoServidor", () => {
  it("sem URL interna, vale a pública (toda instalação que não é a local)", () => {
    expect(urlDoSupabaseNoServidor({ NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co" })).toBe("https://x.supabase.co");
    expect(urlDoSupabaseNoServidor({ NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co", SUPABASE_URL_INTERNA: "" })).toBe(
      "https://x.supabase.co",
    );
    expect(urlDoSupabaseNoServidor({ NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co", SUPABASE_URL_INTERNA: "   " })).toBe(
      "https://x.supabase.co",
    );
  });

  it("com URL interna, o servidor usa a interna e o navegador segue com a pública", () => {
    const fonte = {
      NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321",
      SUPABASE_URL_INTERNA: "http://host.docker.internal:54321/",
    };
    expect(urlDoSupabaseNoServidor(fonte)).toBe("http://host.docker.internal:54321");
    expect(fonte.NEXT_PUBLIC_SUPABASE_URL).toBe("http://localhost:54321");
  });
});

describe("quem fala com o Supabase pelo servidor usa a URL do servidor", () => {
  const raiz = process.cwd();
  const ler = (arquivo: string) => readFileSync(join(raiz, arquivo), "utf8");

  it.each([
    "lib/supabase/server.ts",
    "lib/supabase/admin.ts",
    "proxy.ts",
    "app/api/v1/health/route.ts",
    "lib/agent-engine/agent/request-deps.ts",
    "workers/agent-worker/main.ts",
  ])("%s resolve a URL por urlDoSupabaseNoServidor", (arquivo) => {
    expect(ler(arquivo)).toContain("urlDoSupabaseNoServidor");
  });

  it("a página (PublicEnvScript) continua entregando ao navegador só a URL pública", () => {
    const pagina = ler("app/public-env-script.tsx");
    expect(pagina).toContain("env.NEXT_PUBLIC_SUPABASE_URL");
    expect(pagina).not.toContain("SUPABASE_URL_INTERNA");
    expect(ler("lib/supabase/browser.ts")).not.toContain("SUPABASE_URL_INTERNA");
  });
});


describe("URL assinada: navegador usa a pública, a Evolution usa a interna", () => {
  const fonte = {
    NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321",
    SUPABASE_URL_INTERNA: "http://host.docker.internal:54321",
  };
  // O servidor assina com o client que fala pela URL interna.
  const assinadaNoServidor =
    "http://host.docker.internal:54321/storage/v1/object/sign/whatsapp-media/org/conv/a.png?token=abc";

  it("para o NAVEGADOR (inbox, anexos, prévias, biblioteca) sai com o host público", () => {
    expect(urlAssinadaParaONavegador(assinadaNoServidor, fonte)).toBe(
      "http://localhost:54321/storage/v1/object/sign/whatsapp-media/org/conv/a.png?token=abc",
    );
  });

  it("para a EVOLUTION (envio de mídia) segue com o host interno, sem reescrever", () => {
    expect(urlParaOCanal(assinadaNoServidor, "")).toBe(assinadaNoServidor);
    expect(urlParaOCanal(assinadaNoServidor, undefined)).toBe(assinadaNoServidor);
  });

  it("sem SUPABASE_URL_INTERNA (instalação atual do dono) tudo continua como hoje: mesma URL", () => {
    const url = "https://x.supabase.co/storage/v1/object/sign/b/c.png?token=t";
    expect(urlAssinadaParaONavegador(url, { NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co" })).toBe(url);
    expect(
      urlAssinadaParaONavegador(url, { NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co", SUPABASE_URL_INTERNA: "" }),
    ).toBe(url);
  });

  it("URL de outro host (já pública, ou de terceiro) não é mexida; barra final da interna não atrapalha", () => {
    const outra = "https://cdn.exemplo.test/a.png?token=1";
    expect(urlAssinadaParaONavegador(outra, fonte)).toBe(outra);
    expect(
      urlAssinadaParaONavegador(assinadaNoServidor, { ...fonte, SUPABASE_URL_INTERNA: "http://host.docker.internal:54321/" }),
    ).toContain("http://localhost:54321/storage/");
    // porta diferente da interna não é a interna
    const outraPorta = "http://host.docker.internal:54399/storage/x";
    expect(urlAssinadaParaONavegador(outraPorta, fonte)).toBe(outraPorta);
  });
});

describe("toda URL assinada do servidor tem destino declarado", () => {
  const raiz = process.cwd();
  const ler = (arquivo: string) => readFileSync(join(raiz, arquivo), "utf8");

  it.each([
    "app/api/v1/messages/[id]/media/route.ts",
    "app/api/v1/media-library/[id]/file/route.ts",
    "app/api/v1/contacts/[id]/avatar/route.ts",
    "app/api/v1/channels/partner/templates/media/route.ts",
    "app/api/v1/lgpd/requests/[id]/route.ts",
    "workers/lgpd-export-worker.ts",
    "lib/notifications/push.handler.ts",
  ])("%s entrega ao navegador a URL pública", (arquivo) => {
    expect(ler(arquivo)).toContain("urlAssinadaDoNavegador(");
  });

  it.each(["app/api/v1/messages/_handler.ts", "lib/disparo/envio-real.ts"])(
    "%s (envio pela Evolution) NÃO reescreve para a pública: usa só urlParaOCanal",
    (arquivo) => {
      const texto = ler(arquivo);
      expect(texto).toContain("urlParaOCanal(");
      expect(texto).not.toContain("urlAssinadaDoNavegador");
    },
  );
});
