// @vitest-environment node
/**
 * Campanha pontual `campanha_kit` (Campanha Exemplo): sai como abertura (teto de aberturas do
 * dia, janela, vez do chip), fica fora da cadência (nenhum toque planejado) e não é reprogramada por ficar velha na
 * fila — a ordem dela vem de `enviar_apos` antigo de propósito.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { configDoMotor, CONTAGEM_ZERADA, motorEmMemoria, SEM_AVISO } from "./apoio-do-motor-teste";
import { cadenciaPorId, ehCampanha, ehCampanhaDaJanela, ehTipoDeProspeccao } from "./cadencia";
import { type EnvioReal, type LeadDoDisparo, rodarDisparo } from "./motor";
import { repositorioSupabase } from "./repositorio-supabase";

const ORG = "00000000-0000-4000-8000-0000000000c9";
const AGORA = new Date("2026-11-05T12:00:00-03:00");
const lead: LeadDoDisparo = { id: "l1", nome: "Maria", telefone: "+5511999990000", status: "open", bloqueado: false, anonimizado: false, grupo: null, campos: {} };

async function volta(contagem: () => typeof CONTAGEM_ZERADA) {
  const config = { ...configDoMotor(ORG, "real"), fonteStageId: null };
  const mem = motorEmMemoria(AGORA, config, [lead], { contagem });
  mem.envios.push({
    id: "c1", leadId: "l1", chipId: "chip-1", tipo: "campanha_kit", origem: "motor", texto: "texto da campanha", midia: null,
    midiaId: "44b4db79-6329-4aa0-8c02-77f0cd58226d", enviarApos: new Date("2026-11-04T09:00:00-03:00"), estado: "pendente",
    tentativas: 0, criadoEm: new Date("2026-11-05T09:00:00-03:00"), daParada: false,
  });
  // A lead já recebeu a abertura da cadência antes: o índice único não pode barrar a campanha.
  mem.envios.push({
    id: "ab", leadId: "l1", chipId: "chip-1", tipo: "abertura", origem: "motor", texto: "x", midia: null, midiaId: null,
    enviarApos: new Date("2026-10-20T09:00:00-03:00"), estado: "enviado", tentativas: 0, criadoEm: new Date("2026-10-20T09:00:00-03:00"), daParada: false,
  });
  const enviarReal = vi.fn<EnvioReal>(async () => ({ externalId: "ext-1", chamadaEm: AGORA }) as never);
  await rodarDisparo({ repo: mem.repo, agora: AGORA, ambiente: { DISPARO_REAL_LIBERADO: "sim" }, sortear: () => 0.5, enviarReal, enviarAviso: SEM_AVISO });
  return { mem, enviarReal };
}

describe("campanha_kit", () => {
  it("sai com folga no teto, mesmo velha na fila e com abertura anterior, e não planeja toque", async () => {
    const { mem, enviarReal } = await volta(() => CONTAGEM_ZERADA);
    expect(enviarReal).toHaveBeenCalledTimes(1);
    expect(mem.envios.find((e) => e.id === "c1")!.estado).toBe("enviado");
    expect(mem.envios.some((e) => e.tipo.startsWith("toque"))).toBe(false);
  });

  it("não fura o teto de aberturas do dia: fica pendente, sem reprogramar", async () => {
    const { mem, enviarReal } = await volta(() => ({ ...CONTAGEM_ZERADA, aberturasHoje: 999, enviosHoje: 5 }));
    expect(enviarReal).not.toHaveBeenCalled();
    const c = mem.envios.find((e) => e.id === "c1")!;
    expect(c.estado).toBe("pendente");
    expect(c.enviarApos.toISOString()).toBe(new Date("2026-11-04T09:00:00-03:00").toISOString());
  });
});

/**
 * Campanha por prefixo (retomada): `campanha_<nome>` (minúsculas, dígitos e `_`, até 30) sai como a
 * `campanha_kit`, sem índice único a esbarrar e sem toque planejado. As janelas da base de uma organização (`campanha_j*`) são o
 * último recado da vez: aceitam o proibido `excetoUltimo` (o brinde extra). Qualquer outra campanha não aceita.
 */
const FRASCO = { padrao: "brinde (extra|a mais)", motivo: "cita brinde extra fora do último toque", excetoUltimo: true };

async function voltaCampanha(tipo: string, texto: string, contagem: () => typeof CONTAGEM_ZERADA = () => CONTAGEM_ZERADA) {
  const config = { ...configDoMotor(ORG, "real"), fonteStageId: null, proibidos: [FRASCO] };
  const mem = motorEmMemoria(AGORA, config, [lead], { contagem });
  mem.envios.push({
    id: "c1", leadId: "l1", chipId: "chip-1", tipo, origem: "motor", texto, midia: null, midiaId: null,
    enviarApos: new Date("2026-11-05T09:00:00-03:00"), estado: "pendente", tentativas: 0, criadoEm: new Date("2026-11-05T09:00:00-03:00"), daParada: false,
  });
  const enviarReal = vi.fn<EnvioReal>(async () => ({ externalId: "ext-1", chamadaEm: AGORA }) as never);
  await rodarDisparo({ repo: mem.repo, agora: AGORA, ambiente: { DISPARO_REAL_LIBERADO: "sim" }, sortear: () => 0.5, enviarReal, enviarAviso: SEM_AVISO });
  return { envio: mem.envios.find((e) => e.id === "c1")!, mem, enviarReal };
}

describe("campanha por prefixo (campanha_j*, campanha_repo_*, campanha_ab_p2)", () => {
  it("campanha_j0101 sai no ritmo de abertura, não planeja toque e aceita o brinde extra", async () => {
    const { envio, mem, enviarReal } = await voltaCampanha("campanha_j0101", "Nos kits de 9 e 12 meses vai um brinde extra.");
    expect(enviarReal).toHaveBeenCalledTimes(1);
    expect(envio.estado).toBe("enviado");
    expect(mem.envios.some((e) => e.tipo.startsWith("toque"))).toBe(false);
  });

  it("os lembretes da janela (campanha_j0101_l1) também aceitam o brinde extra", async () => {
    const { envio } = await voltaCampanha("campanha_j0101_l1", "Lembrando: o brinde extra vale até domingo.");
    expect(envio.estado).toBe("enviado");
  });

  it("campanha_j0101 não fura o teto de aberturas do dia", async () => {
    const { envio, enviarReal } = await voltaCampanha("campanha_j0101", "Oi, tudo bem?", () => ({ ...CONTAGEM_ZERADA, aberturasHoje: 999, enviosHoje: 5 }));
    expect(enviarReal).not.toHaveBeenCalled();
    expect(envio.estado).toBe("pendente");
  });

  it("campanha_xyz qualquer sai como campanha, mas NÃO aceita o brinde extra", async () => {
    const ok = await voltaCampanha("campanha_xyz", "Oi, tudo bem? Separei uma condição para você.");
    expect(ok.envio.estado).toBe("enviado");
    const barrada = await voltaCampanha("campanha_xyz", "Hoje vai um brinde extra no seu kit.");
    expect(barrada.enviarReal).not.toHaveBeenCalled();
    expect(barrada.envio.estado).toBe("cancelado");
    expect(barrada.envio.motivo).toMatch(/verificador/);
  });

  it("campanha nova fica fora da cadência: não planeja toque", async () => {
    const { mem } = await voltaCampanha("campanha_repo_261121", "Oi, tudo bem? Como está o seu tratamento?");
    expect(mem.envios.filter((e) => e.id !== "c1")).toHaveLength(0);
  });
});

describe("ehCampanha e ehCampanhaDaJanela", () => {
  it("reconhece o prefixo e mantém os nomes antigos", () => {
    for (const t of ["campanha_kit", "campanha_kit_l", "campanha_j0101", "campanha_j0101_l2", "campanha_repo_261121", "campanha_ab_p2"]) expect(ehCampanha(t), t).toBe(true);
    for (const t of ["campanha_", "campanha", "Campanha_x", "campanha_x-y", `campanha_${"a".repeat(31)}`, "abertura", "toque_2", "kit_t1_261014130000"]) expect(ehCampanha(t), t).toBe(false);
  });

  it("só campanha_j* é janela", () => {
    expect(ehCampanhaDaJanela("campanha_j0101")).toBe(true);
    expect(ehCampanhaDaJanela("campanha_j0101_l1")).toBe(true);
    expect(ehCampanhaDaJanela("campanha_kit")).toBe(false);
    expect(ehCampanhaDaJanela("campanha_repo_261121")).toBe(false);
    expect(ehCampanhaDaJanela("campanha_")).toBe(false);
    // Estrito: só `campanha_j<DDMM>` e os lembretes `_l<n>`; um futuro `campanha_produto_*` não
    // libera o brinde extra.
    expect(ehCampanhaDaJanela("campanha_j0101_l2")).toBe(true);
    expect(ehCampanhaDaJanela("campanha_produto_0101")).toBe(false);
    expect(ehCampanhaDaJanela("campanha_j19")).toBe(false);
    expect(ehCampanhaDaJanela("campanha_j0101_l12")).toBe(false);
    expect(ehCampanhaDaJanela("campanha_j0101_x")).toBe(false);
  });

  it("a campanha conta como mensagem nova de prospecção", () => {
    const cad = cadenciaPorId("reativacao_3_toques");
    expect(ehTipoDeProspeccao(cad, "campanha_j0101")).toBe(true);
    expect(ehTipoDeProspeccao(cad, "abertura")).toBe(true);
    expect(ehTipoDeProspeccao(cad, "tabela_valores:seq")).toBe(false);
  });
});

describe("contagem do chip conta as campanhas por prefixo (repositório do Supabase)", () => {
  it("aberturas do dia/hora e a última nova incluem campanha_*", async () => {
    const chamadas: { tabela: string; passos: [string, unknown[]][] }[] = [];
    const db = {
      from(tabela: string) {
        const passos: [string, unknown[]][] = [];
        chamadas.push({ tabela, passos });
        const proxy: unknown = new Proxy({}, {
          get(_a, nome: string) {
            if (nome === "then") return (ok: (v: unknown) => unknown) => ok({ data: [], error: null, count: 0 });
            return (...args: unknown[]) => (passos.push([nome, args]), proxy);
          },
        });
        return proxy;
      },
    } as unknown as SupabaseClient;
    await repositorioSupabase(db).contagem(ORG, "chip-1", AGORA, -180, ["abertura", "toque_2", "toque_3"]);
    const ors = chamadas.filter((c) => c.tabela === "disparo_envios").flatMap((c) => c.passos.filter(([n]) => n === "or").map(([, a]) => String(a[0])));
    // aberturasHoje, aberturasUltimaHora e ultimaNovaEm.
    expect(ors.filter((o) => o.includes("tipo.like.campanha_*"))).toHaveLength(3);
  });
});
