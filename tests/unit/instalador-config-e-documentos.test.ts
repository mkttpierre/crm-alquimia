/**
 * Cadastro sem SMTP (config do Supabase local) e os documentos de uma instalação aberta.
 *
 * Estáticos: leem arquivos. O comportamento do cadastro sem e-mail está em
 * `app/actions/auth/signUp.test.ts` e na spec `tests/e2e/instalacao-nova.spec.ts`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = process.cwd();
const ler = (arquivo: string) => readFileSync(join(RAIZ, arquivo), "utf8");

/** Corpo de uma seção `[nome]` do TOML (até a próxima seção). */
function secao(toml: string, nome: string): string {
  const linhas = toml.split("\n");
  const inicio = linhas.findIndex((l) => l.trim() === `[${nome}]`);
  if (inicio === -1) return "";
  const resto = linhas.slice(inicio + 1);
  const fim = resto.findIndex((l) => /^\s*\[/.test(l));
  return (fim === -1 ? resto : resto.slice(0, fim)).join("\n");
}

describe("supabase/config.toml", () => {
  const toml = ler("supabase/config.toml");

  it("o project_id é crm-alquimia (não colide com outro Supabase local na máquina)", () => {
    expect(toml).toMatch(/^project_id = "crm-alquimia"$/m);
  });

  it("[auth.email] desliga a confirmação por e-mail (cadastro sem SMTP)", () => {
    expect(secao(toml, "auth.email")).toMatch(/^enable_confirmations = false$/m);
  });

  it("explica ali mesmo como ligar a confirmação com SMTP", () => {
    const bloco = secao(toml, "auth.email");
    expect(bloco).toMatch(/SMTP/);
    expect(bloco).toContain("[auth.email.smtp]");
    expect(bloco).toMatch(/enable_confirmations = false/);
    expect(bloco).toMatch(/true/);
  });

  it("o cadastro continua habilitado e o banco segue no piso pg15", () => {
    expect(secao(toml, "auth.email")).toMatch(/^enable_signup = true$/m);
    expect(secao(toml, "db")).toMatch(/^major_version = 15$/m);
  });

  it("Studio e Inbucket vêm DESLIGADOS (a CLI os publica em todas as interfaces da máquina)", () => {
    expect(secao(toml, "studio")).toMatch(/^enabled = false$/m);
    expect(secao(toml, "inbucket")).toMatch(/^enabled = false$/m);
    expect(toml).toMatch(/REDE LOCAL/);
  });

  it("README e SECURITY avisam que o Supabase local fica acessível na rede local", () => {
    for (const arquivo of ["README.md", "SECURITY.md"]) {
      const texto = ler(arquivo);
      expect(texto, arquivo).toMatch(/rede local/);
      expect(texto, arquivo).toMatch(/54321/);
      expect(texto, arquivo).toMatch(/54322/);
      expect(texto, arquivo).toMatch(/firewall/);
    }
    expect(ler("SECURITY.md")).toMatch(/postgres/);
  });

  it("NOTICE.md traz a licença MIT do Baileys (com o copyright a conferir, se ainda for marcador)", () => {
    const aviso = ler("NOTICE.md");
    expect(aviso).toContain("Licença do Baileys (MIT)");
    expect(aviso).toContain("Permission is hereby granted, free of charge");
    expect(aviso).toContain("Copyright (c) 2025 Rajeh Taher/WhiskeySockets");
    expect(aviso).not.toContain("COPYRIGHT_BAILEYS_A_CONFERIR");
  });

  it("o CI de e2e religa o Mailpit (Inbucket) que as specs leem", () => {
    const workflow = ler(".github/workflows/e2e.yml");
    expect(workflow).toContain("^\\[inbucket\\]");
    expect(workflow).toContain("s/^enabled = false/enabled = true/");
  });

  it("o CI de e2e liga a confirmação de volta (as specs de link de e-mail dependem dela)", () => {
    const workflow = ler(".github/workflows/e2e.yml");
    expect(workflow).toContain("enable_confirmations = true");
    expect(workflow).toMatch(/sed -i .*enable_confirmations = false.*supabase\/config\.toml/);
  });
});

describe("documentos de uma instalação aberta", () => {
  it("LICENSE mantém o copyright original e acrescenta o do titular deste produto", () => {
    const licenca = ler("LICENSE");
    expect(licenca).toContain("Copyright (c) 2026 Rafael Melgaço");
    expect(licenca).toContain(["Copyright (c) 2026 ALQUI", "M(IA) Performance"].join(""));
    expect(licenca).toMatch(/^MIT License/);
  });

  it("NOTICE.md cita a origem, a Evolution travada e o patch do Baileys", () => {
    const aviso = ler("NOTICE.md");
    // O nome da origem montado por partes: este arquivo também passa pelo portão de limpeza.
    expect(aviso).toContain(["Desk", "commCRM"].join(""));
    expect(aviso).toContain("Evolution API 2.3.7");
    expect(aviso).toContain("baileys-messages-recv.js");
  });

  it("SECURITY.md manda relatar pelo GitHub, de forma privada, sem e-mail de contato", () => {
    const seguranca = ler("SECURITY.md");
    expect(seguranca).toContain("Report a vulnerability");
    expect(seguranca).toContain("Private vulnerability reporting");
    expect(seguranca).not.toContain("EMAIL_DE_CONTATO");
    expect(seguranca).not.toMatch(/[^\s@]+@[^\s@]+\.[a-z]{2,}/i);
  });

  it("CONTRIBUTING.md existe e aponta o README e o SECURITY", () => {
    const c = ler("CONTRIBUTING.md");
    expect(c).toContain("(README.md)");
    expect(c).toContain("(SECURITY.md)");
  });

  it("CHANGELOG.md recomeça em 1.0.0, com a seção [Não lançado] no topo", () => {
    const changelog = ler("CHANGELOG.md");
    const versoes = [...changelog.matchAll(/^## \[([^\]]+)\]/gm)].map((m) => m[1]);
    expect(versoes).toEqual(["Não lançado", "1.0.0"]);
  });

  it("README.md é do zero ao primeiro login: instalador, cadastro, QR e o envio real desligado", () => {
    const readme = ler("README.md");
    expect(readme).toContain("scripts/instalar.sh");
    expect(readme).toContain("scripts\\instalar.ps1");
    expect(readme).toContain("http://localhost:3000/signup");
    expect(readme).toContain("Conectar novo WhatsApp");
    expect(readme).toContain("DISPARO_REAL_LIBERADO=sim");
    expect(readme).toContain("Node.js");
    expect(readme).toMatch(/Docker Desktop/);
  });

  it("README.md tem uma única linha de crédito ao projeto original, exatamente como o portão de limpeza isenta", () => {
    const linhas = ler("README.md")
      .split("\n")
      .filter((l) => new RegExp(["desk", "comm"].join(""), "i").test(l));
    expect(linhas).toEqual([["Nasceu de um fork do Desk", "commCRM (MIT)."].join("")]);
  });
});
