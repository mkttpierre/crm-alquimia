import { describe, expect, it } from "vitest";
import { chipMudo } from "./chip-mudo";

const agora = new Date("2026-11-10T15:00:00Z");
describe("chip mudo", () => {
  it("aponta chip aberto que enviou sem receber por mais de 24 horas", () => {
    expect(chipMudo({ estado: "open", ultimoRecebimento: "2026-11-09T14:59:00Z", enviouNasUltimas24h: true, unknownNasUltimas24h: false, agora })).toBe(true);
  });
  it("aponta mensagens recebidas desconhecidas no Evolution", () => {
    expect(chipMudo({ estado: "open", ultimoRecebimento: "2026-11-10T14:00:00Z", enviouNasUltimas24h: false, unknownNasUltimas24h: true, agora })).toBe(true);
  });
  it("não aponta chip fechado ou chip com recebimento recente sem unknown", () => {
    expect(chipMudo({ estado: "close", ultimoRecebimento: null, enviouNasUltimas24h: true, unknownNasUltimas24h: true, agora })).toBe(false);
    expect(chipMudo({ estado: "open", ultimoRecebimento: "2026-11-10T14:00:00Z", enviouNasUltimas24h: true, unknownNasUltimas24h: false, agora })).toBe(false);
  });
});

it("não presume 24 horas sem entrada quando o canal é recente", () => {
  expect(chipMudo({ estado: "open", ultimoRecebimento: null, inicioObservacao: "2026-11-10T14:00:00Z", enviouNasUltimas24h: true, unknownNasUltimas24h: false, agora })).toBe(false);
});


it("coleta só timestamps do canal e organização e não oculta falha como saudável", async () => {
  const { coletarChipMudo } = await import("./chip-mudo");
  const consultas: Array<Record<string, unknown>> = [];
  let erro = false;
  const db = { from: (table: string) => {
    const filtros: Record<string, unknown> = { table }; consultas.push(filtros);
    const q = {
      select: (cols: string) => { filtros.cols = cols; return q; },
      eq: (k: string, v: unknown) => { filtros[k] = v; return q; },
      neq: (k: string, v: unknown) => { filtros[`not_${k}`] = v; return q; },
      in: (k: string, v: unknown) => { filtros[k] = v; return q; },
      gte: (k: string, v: unknown) => { filtros[k] = v; return q; },
      order: () => q, limit: () => q,
      maybeSingle: async () => ({ data: filtros.direction === "inbound" ? { created_at: "2026-11-08T14:00:00Z" } : { created_at: "2026-11-10T14:00:00Z" }, error: erro ? { message: "failure" } : null }),
    }; return q;
  } };
  const canal = { id: "canal", created_at: "2026-11-01T00:00:00Z", status: "WORKING" };
  expect(await coletarChipMudo(db as never, "org", canal, agora)).toBe(true);
  expect(consultas).toHaveLength(2);
  for (const q of consultas) {
    expect(q.organization_id).toBe("org"); expect(q.channel_session_id).toBe("canal"); expect(q.cols).toBe("created_at"); expect(q.not_type).toBe("system");
  }
  expect(consultas[1]?.sent_at).toBe("2026-11-09T15:00:00.000Z");
  erro = true;
  expect(await coletarChipMudo(db as never, "org", canal, agora)).toBeNull();
});
