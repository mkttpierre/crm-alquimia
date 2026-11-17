/**
 * Nuvemshop integration — static configuration + env-derived credentials.
 *
 * Env vars `NUVEMSHOP_APP_ID`, `NUVEMSHOP_CLIENT_ID`, `NUVEMSHOP_CLIENT_SECRET`
 * are intentionally optional at build time. `getConfig()` returns null when any
 * of them is missing — callers must surface a `not_configured` error and the UI
 * shows a "configure env" card. Once Rafael drops in real keys, the integration
 * activates without code changes.
 */

import { DEFAULT_APP_NAME } from "@/lib/branding";

export const NUVEMSHOP_AUTH_BASE = "https://www.tiendanube.com";
export const NUVEMSHOP_API_BASE = "https://api.tiendanube.com/v1";
/**
 * A API da Nuvemshop exige User-Agent com o nome do app E um contato (e-mail ou URL). O padrão aponta para o
 * projeto; cada instalação põe o próprio contato em `NUVEMSHOP_USER_AGENT` (ex.: `Minha Loja (contato@minhaloja.com)`).
 */
export const USER_AGENT_PADRAO = `${DEFAULT_APP_NAME} (+https://github.com/mkttpierre/crm-alquimia)`;

export function userAgentDaNuvemshop(): string {
  return process.env.NUVEMSHOP_USER_AGENT?.trim() || USER_AGENT_PADRAO;
}

export interface NuvemshopConfig {
  appId: string;
  clientId: string;
  clientSecret: string;
}

export function getConfig(): NuvemshopConfig | null {
  const appId = process.env.NUVEMSHOP_APP_ID || "";
  const clientId = process.env.NUVEMSHOP_CLIENT_ID || "";
  const clientSecret = process.env.NUVEMSHOP_CLIENT_SECRET || "";
  if (!appId || !clientId || !clientSecret) return null;
  return { appId, clientId, clientSecret };
}

export function isConfigured(): boolean {
  return getConfig() !== null;
}

/**
 * Mandatory webhook events to subscribe at OAuth callback time. LGPD-specific
 * events (`store/redact`, `customers/redact`, `customers/data_request`) are
 * deferred to EPIC-08.
 */
export const SUBSCRIBED_EVENTS = [
  "order/created",
  "order/updated",
  "order/paid",
  "order/cancelled",
  "product/created",
  "product/updated",
  "product/deleted",
  "app/uninstalled",
] as const;

export type NuvemshopEvent = (typeof SUBSCRIBED_EVENTS)[number];

/**
 * URL-safe slug used in the catch-all webhook route segment. Nuvemshop allows
 * arbitrary URLs per webhook, but we want one route per event for legibility
 * and per-event observability. Slashes -> hyphens.
 */
export function eventToSlug(event: NuvemshopEvent): string {
  return event.replace("/", "-");
}

const SLUG_TO_EVENT: Record<string, NuvemshopEvent> = Object.fromEntries(
  SUBSCRIBED_EVENTS.map((e) => [eventToSlug(e), e]),
);

export function slugToEvent(slug: string): NuvemshopEvent | null {
  return SLUG_TO_EVENT[slug] ?? null;
}
