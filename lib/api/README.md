# lib/api/

Helpers e convenções compartilhadas por toda rota `/api/v1/*`.

- `wrappers.ts` — `ok(data, opts)` / `fail(code, message, status, opts)` / `noContent()` + tipos `ApiSuccess<T>` / `ApiError`
- `errors.ts` — `ApiErrorCodes` (constante canônica de códigos)
- `idempotencia.ts` — `Idempotency-Key` reservada no banco (`idempotency_keys`, unique por org + chave + endpoint; vale entre processos, TTL 24h). Em uso no `POST /api/v1/messages`; quais rotas leem a chave: `grep -rli "idempotency-key" app/api`

## Exemplo

```ts
import { ok, fail } from "@/lib/api/wrappers";
import { ApiErrorCodes } from "@/lib/api/errors";

export async function GET(req: Request) {
  const data = await fetchSomething();
  if (!data) return fail(ApiErrorCodes.not_found, "Lead não encontrado", 404);
  return ok(data, { meta: { cursor: nextCursor, has_more: true } });
}
```

## A adicionar (próximas specs)

- `auth.ts` — extrai user / tenant da request (cookie OU bearer); valida MFA; retorna `AuthContext`
- `rate-limit.ts` — sliding window via Upstash; injeta headers `X-RateLimit-*`
- `pagination.ts` — encode/decode de cursor opaco base64 + HMAC
- `audit.ts` — fire-and-forget write em `api_audit_log`
- `cors.ts` — allowlist por tenant
