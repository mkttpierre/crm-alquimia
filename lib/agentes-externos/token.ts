/**
 * Token de API novo — o mesmo formato de `POST /api/v1/settings/api-tokens`: `dsk_<8-hex>_<32 bytes base64url>`.
 *
 * Só o hash SHA-256 vai ao banco (`api_tokens.token_hash`, bytea como literal `\x<hex>` para o PostgREST); o texto
 * puro volta UMA vez para quem criou e nunca mais existe em lugar nenhum.
 */
import { createHash, randomBytes } from "node:crypto";

export interface TokenNovo {
  prefixo: string;
  /** Mostrar uma vez. Nunca gravar, logar nem auditar. */
  textoPuro: string;
  /** `\x<hex>` do SHA-256, pronto para a coluna bytea. */
  hashLiteral: string;
}

export function gerarTokenDeApi(): TokenNovo {
  const prefixo = `dsk_${randomBytes(4).toString("hex")}`;
  const textoPuro = `${prefixo}_${randomBytes(32).toString("base64url")}`;
  const hash = createHash("sha256").update(textoPuro).digest("hex");
  return { prefixo, textoPuro, hashLiteral: `\\x${hash}` };
}
