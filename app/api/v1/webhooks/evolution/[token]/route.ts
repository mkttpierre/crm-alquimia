/**
 * POST /api/v1/webhooks/evolution/[token] — a URL que se cadastra na Evolution.
 *
 * É a MESMA rota de `webhooks/channel/[token]`: o token identifica a sessão, a
 * sessão diz qual é o canal, e quem lê o payload é `handleInboundWebhook`
 * (`lib/channels/inbound.ts`). Existe como caminho próprio só porque a URL é
 * colada num painel de terceiro e um caminho que diz o que é facilita conferir a
 * configuração — a lógica NÃO é duplicada, e este arquivo não nomeia o canal no
 * código (o `lint:channels` olha o conteúdo, não o caminho).
 *
 * O token vai NO CAMINHO, nunca na query: API key em query string vaza em log
 * (doutrina do CLAUDE.md). Para a Evolution isto basta — ela aceita qualquer URL
 * no cadastro do webhook.
 */
export { POST } from "../../channel/[token]/route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
