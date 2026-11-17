/**
 * O canal (Evolution) roda em container e não alcança o Supabase local por `127.0.0.1`/`localhost`:
 * lá dentro, esse endereço é o próprio contêiner (`connect ECONNREFUSED 127.0.0.1:54321`).
 * `DISPARO_MIDIA_HOST` (ex.: `host.docker.internal`) troca só o host da URL assinada; vazio mantém como veio.
 *
 * Todo caminho que entrega URL assinada ao canal (disparo automático e envio manual do composer)
 * passa por aqui.
 */
export function urlParaOCanal(url: string, host = process.env.DISPARO_MIDIA_HOST?.trim()): string {
  if (!host) return url;
  try {
    const u = new URL(url);
    if (u.hostname !== "127.0.0.1" && u.hostname !== "localhost") return url;
    u.hostname = host;
    return u.toString();
  } catch {
    return url;
  }
}
