import { imagemEmCache, chaveDaImagem } from "@/lib/branding/cache-da-imagem";
import {
  CACHE_DA_IMAGEM_DA_MARCA,
  cabecalhoDeEmail,
  iconeDaMarca,
  type VarianteDoIcone,
} from "@/lib/branding/icone-imagem";
import { marcaDaSaida } from "@/lib/branding/saida";

/**
 * As imagens da marca que NÃO têm convenção de arquivo do Next.
 *
 * `app/icon.tsx` e `app/apple-icon.tsx` cobrem a aba clara e o apple-touch. Falta:
 *
 * - `aba-escuro`: o sol BRANCO para o navegador em tema escuro (o layout raiz o
 *   declara com `media="(prefers-color-scheme: dark)"`). Convenção de arquivo não
 *   aceita `media`, e o `icon.tsx` do Next não lê query — por isso uma rota;
 * - `app-192` e `app-512`: os ícones do `app/manifest.ts` (o PWA pede esses dois);
 * - `email`: o cabeçalho dos e-mails de acesso. O e-mail é renderizado pelo GoTrue,
 *   um processo que não é o nosso, e só pode buscar imagem por URL absoluta —
 *   `{{ .SiteURL }}/icone-da-marca/email`. A imagem decide na hora da leitura: o sol
 *   e a escrita do produto quando nada está configurado, o NOME da marca em texto
 *   quando algo está (ver `cabecalhoDeEmail`).
 *
 * Todas resolvem `marcaDaSaida(null)` (instalação -> `.env` -> padrão; nunca lança).
 *
 * Lista FECHADA de variantes, e é de propósito: um `?tamanho=` livre deixaria
 * qualquer um pedir uma imagem de 10 mil pixels a uma rota pública e gerar custo
 * de CPU. Toda variante nova entra aqui E em `PUBLIC_PATHS`
 * (`lib/auth/public-paths.ts`) — sem a entrada, o proxy responde 307 para
 * `/login`, e o e-mail chega com a imagem quebrada. Pelo mesmo motivo o PNG pronto
 * fica em cache por 60 s (`lib/branding/cache-da-imagem.ts`).
 *
 * `force-dynamic` pelo mesmo motivo de `app/icon.tsx`: a marca é lida em runtime,
 * nunca congelada na imagem pré-buildada.
 */

export const dynamic = "force-dynamic";

const VARIANTES: Readonly<
  Record<string, { variante: VarianteDoIcone; lado: number } | "email">
> = {
  "aba-escuro": { variante: "aba-escuro", lado: 64 },
  "app-192": { variante: "app", lado: 192 },
  "app-512": { variante: "app", lado: 512 },
  email: "email",
};

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ variante: string }> },
): Promise<Response> {
  const { variante } = await params;
  // `hasOwn` e não `VARIANTES[variante]`: "constructor" e "__proto__" existem em
  // todo objeto e não são variante nenhuma.
  const pedido = Object.hasOwn(VARIANTES, variante) ? VARIANTES[variante] : undefined;
  if (!pedido) return new Response(null, { status: 404 });

  const marca = await marcaDaSaida(null);
  const corpo = await imagemEmCache(chaveDaImagem(variante, marca), () =>
    (pedido === "email"
      ? cabecalhoDeEmail(marca)
      : iconeDaMarca(marca, pedido.variante, pedido.lado)
    ).arrayBuffer(),
  );

  return new Response(corpo, {
    headers: {
      "content-type": "image/png",
      "cache-control": CACHE_DA_IMAGEM_DA_MARCA,
    },
  });
}
