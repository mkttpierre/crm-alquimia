// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { embedText } from "@/lib/ai/embed";
import { createAdminClient } from "@/lib/supabase/admin";
import { bancoDuble } from "@/tests/helpers/disparo-db-double";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/ai/embed", () => ({ embedText: vi.fn(async () => ({ embedding: [0.1, 0.2] })) }));
vi.mock("@/lib/ai/embeddings/chave", () => ({ resolverChaveDeEmbedding: vi.fn(async () => ({ chave: "x" })) }));
vi.mock("@/lib/ai/rag/version", () => ({
  createKnowledgeVersion: vi.fn(async () => ({ versionId: "v1" })),
  markVersionReady: vi.fn(async () => undefined),
  markVersionFailed: vi.fn(async () => undefined),
  activateVersion: vi.fn(async () => undefined),
}));

const ORG = "11111111-1111-4111-8111-111111111111";
const CONV = "22222222-2222-4222-8222-222222222222";

/**
 * Nota de tela (`type = 'system'`) não é fala do atendente.
 *
 * A nota de ligação é gravada como `outbound`, e o transcrito chama toda `outbound` de "Atendente". Sem o filtro,
 * a instrução ao operador virava exemplo de resposta no acervo de conversas que o agente consulta.
 */
describe("ingestão de conversas no RAG", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const banco = bancoDuble({
      ai_knowledge_sources: [{ id: "fonte-1", organization_id: ORG, source_type: "conversas", is_active: true }],
      conversations: [
        {
          id: CONV,
          organization_id: ORG,
          usable_for_rag: true,
          status: "resolved",
          usable_for_rag_marked_at: "2026-11-13T12:00:00Z",
          rag_review_status: null,
        },
      ],
      messages: [
        { organization_id: ORG, conversation_id: CONV, direction: "inbound", type: "text", body: "Quero saber do pacote", sent_at: "2026-11-13T10:00:00Z" },
        { organization_id: ORG, conversation_id: CONV, direction: "outbound", type: "system", body: "Ligação do D10: ligar para o lead", sent_at: "2026-11-13T10:01:00Z" },
        { organization_id: ORG, conversation_id: CONV, direction: "outbound", type: "text", body: "O pacote inclui site e anúncios", sent_at: "2026-11-13T10:02:00Z" },
      ],
    });
    vi.mocked(createAdminClient).mockReturnValue(banco.cliente as never);
  });

  it("a nota de ligação (type=system, outbound) não entra no transcrito como fala do atendente", async () => {
    const { ingestConversationsBatch } = await import("./conversations");
    const r = await ingestConversationsBatch({ organizationId: ORG, agentId: "agente-1", sinceTs: new Date("2026-11-01T00:00:00Z") });
    expect(r.processed).toBe(1);
    const textos = vi.mocked(embedText).mock.calls.map((c) => c[0]).join("\n");
    expect(textos).toContain("Atendente: O pacote inclui site e anúncios");
    expect(textos).not.toContain("Ligação do D10");
  });
});
