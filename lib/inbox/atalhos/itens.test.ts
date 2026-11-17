import { describe, expect, it } from "vitest";

import { itensDeAtalho } from "./itens";

describe("itensDeAtalho — modelos e funis viram cartões da barra", () => {
  const modelos = [
    { id: "t1", title: "Boas-vindas", body: "Oi {{primeiro_nome}}!", shortcut: "/oi", favorito: true, palavras_chave: ["ola"], media: null },
    { id: "t2", title: "Áudio preço", body: "", shortcut: null, favorito: false, palavras_chave: [], media: { id: "m", kind: "audio" as const, name: "a.ogg", mime: "audio/ogg", size_bytes: 9 } },
    { id: "t3", title: "Tabela", body: "", shortcut: null, media: { id: "m2", kind: "document" as const, name: "t.pdf", mime: "application/pdf", size_bytes: 9 } },
  ];
  const funis = [{ id: "f1", nome: "Funil de valores", atalho: "funil-valores", palavras_chave: ["valores"], favorito: false, compartilhado: true, passos: [{}, {}, {}], duracao_ms: 84000 }];

  it("modelo sem anexo vira 'mensagem', com o atalho sem a barra", () => {
    const [m] = itensDeAtalho(modelos, []);
    expect(m).toMatchObject({ tipo: "mensagem", id: "t1", atalho: "oi", favorito: true, palavrasChave: ["ola"], resumo: "Oi {{primeiro_nome}}!" });
  });

  it("modelo com anexo vira o tipo do anexo (audio, documento)", () => {
    const tipos = itensDeAtalho(modelos, []).map((i) => i.tipo);
    expect(tipos).toEqual(["mensagem", "audio", "documento"]);
  });

  it("funil vira cartão com quantas mensagens e quanto tempo", () => {
    const [f] = itensDeAtalho([], funis as never);
    expect(f).toMatchObject({ tipo: "funil", id: "f1", atalho: "funil-valores", resumo: "3 mensagens · ~1 min 24 s" });
  });

  it("campos novos ausentes (API antiga) não quebram: favorito false, sem palavras-chave", () => {
    const [, , t3] = itensDeAtalho(modelos, []);
    expect(t3).toMatchObject({ favorito: false, palavrasChave: [] });
  });
});
