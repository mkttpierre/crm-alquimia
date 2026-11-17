/**
 * A URL do Supabase que o SERVIDOR usa (app, proxy, worker), quando ela é diferente da que o
 * NAVEGADOR usa.
 *
 * Na instalação local de um comando o navegador fala com `http://localhost:<porta>` e os contêineres
 * (que não enxergam o `localhost` da máquina) com `http://host.docker.internal:<porta>`. A pública
 * (`NEXT_PUBLIC_SUPABASE_URL`) segue sendo a do navegador e a única injetada na página.
 * `SUPABASE_URL_INTERNA` é opcional: vazia (o caso de toda instalação que não é essa), vale a pública.
 *
 * Função pura sobre um objeto, e não `process.env`: o Next INLINA `process.env.NEXT_PUBLIC_*` no
 * build da imagem genérica (placeholder), então a leitura tem de vir de `lib/env` (runtime).
 */
export function urlDoSupabaseNoServidor(fonte: {
  SUPABASE_URL_INTERNA?: string | undefined;
  NEXT_PUBLIC_SUPABASE_URL: string;
}): string {
  const interna = (fonte.SUPABASE_URL_INTERNA || "").trim().replace(/\/+$/, "");
  return interna || fonte.NEXT_PUBLIC_SUPABASE_URL;
}

/**
 * Uma URL ASSINADA do Storage, gerada pelo servidor, que vai ser aberta pelo NAVEGADOR (mídia do inbox,
 * anexos, prévias, biblioteca, avatar, link de exportação): troca o endereço interno
 * (`SUPABASE_URL_INTERNA`, que o navegador não alcança) pelo público (`NEXT_PUBLIC_SUPABASE_URL`).
 *
 * Sem `SUPABASE_URL_INTERNA` (toda instalação que não é a local), devolve a URL como veio. O envio de
 * mídia para a Evolution NÃO passa por aqui: ela baixa pelo endereço interno, que é o que o servidor
 * já gera (`lib/messaging/media/url-para-o-canal.ts`).
 */
export function urlAssinadaParaONavegador(
  url: string,
  fonte: { SUPABASE_URL_INTERNA?: string | undefined; NEXT_PUBLIC_SUPABASE_URL: string },
): string {
  const interna = (fonte.SUPABASE_URL_INTERNA || "").trim().replace(/\/+$/, "");
  if (!interna) return url;
  const publica = fonte.NEXT_PUBLIC_SUPABASE_URL.trim().replace(/\/+$/, "");
  if (url === interna || url.startsWith(`${interna}/`) || url.startsWith(`${interna}?`)) {
    return publica + url.slice(interna.length);
  }
  return url;
}
