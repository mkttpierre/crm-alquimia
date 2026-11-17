import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import manifest from "@/app/manifest";
import { isPublicPath } from "@/lib/auth/public-paths";

const RAIZ = process.cwd();

/**
 * A marca nas saídas que não são tela: o manifest do app e o cabeçalho dos e-mails
 * de acesso (cadastro e recuperação de senha).
 */

describe("o manifest do app", () => {
  const m = manifest();

  it("os ícones são as imagens da marca, e não arquivos em public/", () => {
    const srcs = (m.icons ?? []).map((i) => i.src);
    expect(srcs).toEqual(["/icone-da-marca/app-192", "/icone-da-marca/app-512"]);
    expect((m.icons ?? []).map((i) => i.sizes)).toEqual(["192x192", "512x512"]);
    // Sem imagem estática por revendedor: a imagem Docker é uma só.
    expect(fs.existsSync(path.join(RAIZ, "public/icone-crm-256.png"))).toBe(false);
    expect(fs.existsSync(path.join(RAIZ, "public/icone-crm-512.png"))).toBe(false);
  });

  it("todo ícone do manifest alcança quem ainda não entrou", () => {
    for (const i of m.icons ?? []) expect(isPublicPath(i.src)).toBe(true);
  });
});

describe("o cabeçalho dos e-mails de acesso", () => {
  const modelos = ["confirmation", "recovery"] as const;
  const ler = (n: string) => fs.readFileSync(path.join(RAIZ, `supabase/templates/${n}.html`), "utf8");

  it.each(modelos)("%s: o modelo cru leva a arte do produto, por URL absoluta do app", (n) => {
    const h = ler(n);
    // O modelo funciona CRU: nenhum marcador nem placeholder para o cabeçalho — quem
    // decide o que a imagem mostra é a rota, na hora da leitura.
    expect(h).not.toContain("marca-produto");
    expect(h).not.toMatch(/<img[^>]*__/);
    // Cliente de e-mail só busca imagem por URL absoluta — e `{{ .SiteURL }}` é o
    // endereço do app configurado como Site URL do GoTrue. Nada de
    // `data:` (Gmail bloqueia) nem de host fixo no arquivo.
    expect(h).toMatch(/<img[^>]*src="\{\{ \.SiteURL \}\}\/icone-da-marca\/email"/);
    expect(h).not.toContain("data:image");
    // E o e-mail só pode pedir uma imagem que a rota serve E que é pública.
    expect(isPublicPath("/icone-da-marca/email")).toBe(true);
  });

  it.each(modelos)("%s: o `&` do link continua único (nenhuma query nova entrou)", (n) => {
    expect(ler(n)).toContain("{{ .RedirectTo }}&token_hash={{ .TokenHash }}");
  });
});
