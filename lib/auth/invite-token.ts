/**
 * Stateless HMAC-SHA256 invite token. Self-contained payload, signed and
 * base64url-encoded — no DB row required to issue. Verified at accept time.
 *
 * Format: `<body>.<sig>` where
 *   - body = base64url(JSON({invite_id, email, organization_id, role, exp}))
 *   - sig  = base64url(HMAC_SHA256(secret, body))
 *
 * Secret resolution: INVITE_TOKEN_SECRET → INTERNAL_SECRET (the first non-empty one) → "dev-fallback"
 * outside production. In production, with neither set, signing throws and verification fails closed. Verification uses
 * `timingSafeEqual` to avoid timing oracles.
 */
import { z } from "zod";
import { interfaceSettingsSchema, type InterfaceSettings } from "@/lib/navigation/interface";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * O primeiro segredo NÃO VAZIO (`INTERNAL_SECRET=` vazio, como no .env.example, não pode virar chave vazia).
 * Sem nenhum, em produção não há segredo: emitir lança e verificar recusa. Fora de produção, o fallback de dev.
 */
const SECRET = (): string | null => {
  for (const v of [process.env.INVITE_TOKEN_SECRET, process.env.INTERNAL_SECRET]) {
    if (v && v.trim()) return v;
  }
  return process.env.NODE_ENV === "production" ? null : "dev-fallback";
};

export interface InvitePayload {
  interface_settings?: InterfaceSettings;
  invite_id: string;
  email: string;
  organization_id: string;
  role: string;
  exp: number; // epoch seconds
  iat?: number;
  invited_by?: string;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export function signInviteToken(payload: InvitePayload): string {
  const json = JSON.stringify(payload);
  const body = b64url(Buffer.from(json, "utf8"));
  const segredo = SECRET();
  if (!segredo) throw new Error("convite: sem segredo para assinar (defina INTERNAL_SECRET ou INVITE_TOKEN_SECRET)");
  const sig = b64url(createHmac("sha256", segredo).update(body).digest());
  return `${body}.${sig}`;
}

export function verifyInviteToken(token: string): InvitePayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  if (!body || !sig) return null;

  const segredo = SECRET();
  if (!segredo) return null;
  const expected = b64url(createHmac("sha256", segredo).update(body).digest());
  if (sig.length !== expected.length) return null;

  try {
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch {
    return null;
  }

  let payload: InvitePayload;
  try {
    const json = Buffer.from(body, "base64url").toString("utf8");
    payload = JSON.parse(json) as InvitePayload;
  } catch {
    return null;
  }

  const checked = z
    .object({
      invite_id: z.string().uuid(),
      email: z.string().email(),
      organization_id: z.string().uuid(),
      role: z.enum(["viewer", "agent", "manager", "admin"]),
      exp: z.number().int().positive(),
      iat: z.number().int().positive().optional(),
      invited_by: z.string().uuid().optional(),
      interface_settings: interfaceSettingsSchema.optional(),
    })
    .safeParse(payload);
  if (!checked.success) return null;
  payload = checked.data;

  if (payload.exp * 1000 < Date.now()) return null;
  return payload;
}

export const INVITE_TTL_SECONDS = 60 * 60 * 24; // 24h
