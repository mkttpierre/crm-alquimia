import { loadOnboardingChannel } from "@/lib/channels/onboarding-session";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { servidorDeQrConfigurado } from "@/lib/channels/connect-evolution";
import { carregarCanalDoOnboardingEvolution, qrDoOnboardingEvolution } from "@/lib/channels/onboarding-evolution";
import { NextResponse } from "next/server";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";

/**
 * Proxy WAHA's QR endpoint so the browser can <img src="..." /> without
 * exposing the API key.
 *
 * WAHA exposes: GET /api/{session}/auth/qr?format=image → image/png bytes.
 */
export async function GET() {
  const user = await loadAuthUser();
  if (!user) return new NextResponse(null, { status: 401 });
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) return new NextResponse(null, { status: 404 });

  const baseUrl = process.env.WAHA_API_BASE_URL;
  const apiKey = process.env.WAHA_API_KEY;
  const wahaConfigurado = Boolean(baseUrl && apiKey && apiKey !== "dev_plaintext_change_me");

  // Sem WAHA, o QR vem da Evolution (instalação local de um comando): PNG decodificado, sem expor a chave.
  if (!wahaConfigurado && servidorDeQrConfigurado()) {
    try {
      const canal = await carregarCanalDoOnboardingEvolution(await createClient(), activeOrg.orgId);
      if (!canal) return new NextResponse(null, { status: 404 });
      const bytes = await qrDoOnboardingEvolution(createAdminClient(), activeOrg.orgId, canal);
      if (!bytes) return new NextResponse(null, { status: 404 });
      return new NextResponse(bytes.buffer as ArrayBuffer, {
        headers: { "content-type": "image/png", "cache-control": "no-store, max-age=0" },
      });
    } catch {
      return new NextResponse(null, { status: 502 });
    }
  }

  if (!wahaConfigurado || !baseUrl || !apiKey) {
    return new NextResponse(null, { status: 503 });
  }

  const channel = await loadOnboardingChannel(await createClient(), activeOrg.orgId);
  if (!channel || channel.archived_at) return new NextResponse(null, { status: 404 });
  const sessionName = channel.waha_session_name;
  const upstream = await fetch(
    `${baseUrl}/api/${encodeURIComponent(sessionName)}/auth/qr?format=image`,
    { headers: { "X-Api-Key": apiKey }, cache: "no-store" },
  );
  if (!upstream.ok) {
    return new NextResponse(null, {
      status: upstream.status,
      headers: { "x-waha-status": String(upstream.status) },
    });
  }

  const ct = upstream.headers.get("content-type") ?? "image/png";
  const buf = await upstream.arrayBuffer();
  return new NextResponse(buf, {
    status: 200,
    headers: {
      "content-type": ct,
      "cache-control": "no-store, max-age=0",
    },
  });
}
