// @vitest-environment node
import { expect, it } from "vitest";
import { configDoMotor, motorEmMemoria, SEM_AVISO } from "./apoio-do-motor-teste";
import { lerRitmo } from "./config";
import { rodarDisparo, type LeadDoDisparo } from "./motor";

const org = "00000000-0000-4000-8000-0000000000c1";
const midiaId = "00000000-0000-4000-8000-000000000001";
const agora = new Date("2026-11-09T15:00:00Z");

async function caso(opcoes: { midia?: string; valida?: boolean; bloqueado?: boolean; allowlist?: string; respondeu?: boolean; falhar?: boolean; classe?: string; previa?: boolean } = {}) {
  const config = configDoMotor(org, "real");
  config.ritmo = lerRitmo({ ...config.ritmo, aberturaMidiaId: opcoes.midia ?? midiaId });
  config.modelos = { abertura: ["{oi} Qual tratamento você quer começar?"], reposicao: ["{oi} Qual tratamento você quer seguir?"] };
  config.escolha = [
    { tipo: "abertura", quando: [{ campo: "cliente_antigo", igual: "sim" }], lista: "reposicao" },
    { tipo: "abertura", quando: [], lista: "abertura" },
  ];
  const lead: LeadDoDisparo = {
    id: "l1", nome: "Maria", telefone: "+5511999990000", status: "open", bloqueado: opcoes.bloqueado ?? false,
    anonimizado: false, grupo: null, campos: { cliente_antigo: opcoes.classe ?? "nao", ...(opcoes.previa ? { abertura_midia_id: "00000000-0000-4000-8000-000000000002", abertura_fecho: "Fecho da prévia" } : {}) },
  };
  const mem = motorEmMemoria(agora, config, [lead], { respostas: () => opcoes.respondeu ? ["Já respondi"] : [] });
  mem.repo.midiaDaAberturaValida = async (organizationId, id) => organizationId === org && id === midiaId && (opcoes.valida ?? true);
  const saidas: Array<{ texto: string; midiaId: string | null }> = [];
  await rodarDisparo({ repo: mem.repo, agora, ambiente: { DISPARO_REAL_LIBERADO: "sim", ...(opcoes.allowlist ? { DISPARO_SO_PARA: opcoes.allowlist } : {}) }, sortear: () => 0.5, enviarAviso: SEM_AVISO,
    enviarReal: async (envio) => { if (opcoes.falhar) throw new Error("timeout"); saidas.push({ texto: envio.texto, midiaId: envio.midiaId }); return { externalId: "ok" }; },
  });
  return { ...mem, saidas };
}

it("envia uma única imagem com a legenda escolhida para aquele lead", async () => {
  const v = await caso({ classe: "sim", previa: true });
  expect(v.saidas).toEqual([{ texto: "Oi, Maria! Qual tratamento você quer seguir?", midiaId }]);
  expect(v.envios.filter((e) => e.tipo.startsWith("abertura"))).toHaveLength(1);
  expect(v.envios[0]).toMatchObject({ tipo: "abertura", estado: "enviado", midiaId });
});

it("usa a legenda de apresentação para quem não é cliente do Produto A", async () => {
  const v = await caso();
  expect(v.saidas).toEqual([{ texto: "Oi, Maria! Qual tratamento você quer começar?", midiaId }]);
});

it.each([{ midia: "invalida" }, { valida: false }])("barra a abertura inteira quando a imagem não é válida: %j", async (opcoes) => {
  const v = await caso(opcoes);
  expect(v.saidas).toEqual([]);
  expect(v.envios[0]).toMatchObject({ tipo: "abertura", estado: "cancelado", motivo: expect.stringMatching(/imagem.*indisponível/) });
});

it.each([{ bloqueado: true }, { allowlist: "5511888888888" }, { respondeu: true }])("mantém os bloqueios da abertura com imagem: %j", async (opcoes) => {
  const v = await caso(opcoes);
  expect(v.saidas).toEqual([]);
  expect(v.envios.filter((e) => e.tipo.startsWith("abertura_p"))).toEqual([]);
});

it("preserva foto e legenda juntas na fila quando o canal falha", async () => {
  const v = await caso({ falhar: true });
  expect(v.saidas).toEqual([]);
  expect(v.envios[0]).toMatchObject({ tipo: "abertura", estado: "pendente", midiaId, texto: "Oi, Maria! Qual tratamento você quer começar?", tentativas: 1 });
  expect(v.envios).toHaveLength(1);
});
