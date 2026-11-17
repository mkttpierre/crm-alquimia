/**
 * `.env.example` é REFERÊNCIA, não receita: o instalador gera o `.env.local`. Por isso nenhuma
 * linha pode carregar valor real (chave, token, senha, e-mail ou telefone de alguém), e as variáveis
 * que o instalador preenche precisam estar documentadas ali.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = process.cwd();
const exemplo = readFileSync(join(RAIZ, ".env.example"), "utf8");

/** `CHAVE=valor`, inclusive nas linhas comentadas do tipo `# CHAVE=valor`. */
const atribuicoes = exemplo
  .split("\n")
  .map((linha, i) => ({ n: i + 1, m: /^#?\s*([A-Z][A-Z0-9_]{3,})=(.*)$/.exec(linha) }))
  .filter((x) => x.m !== null)
  .map((x) => ({ n: x.n, chave: x.m![1]!, valor: (x.m![2] ?? "").replace(/\s+#.*$/, "").trim() }));

describe(".env.example sem valor real", () => {
  it("há atribuições para conferir", () => {
    expect(atribuicoes.length).toBeGreaterThan(40);
  });

  it("nenhum valor parece segredo (chave longa, JWT, sk-, e-mail ou telefone)", () => {
    const suspeitos = atribuicoes.filter(({ valor }) => {
      if (valor === "") return false;
      if (/^eyJ/.test(valor)) return true; // JWT (chaves do Supabase)
      if (/^(sk|pk|re|rk|xoxb)[-_][A-Za-z0-9]{8,}/.test(valor)) return true;
      if (/^[A-Za-z0-9+/_=-]{24,}$/.test(valor)) return true; // hex ou base64 longo
      if (/[^\s@]+@[^\s@]+\.[a-z]{2,}/i.test(valor)) return true;
      if (/\d{10,}/.test(valor.replace(/[\s-]/g, "")) && !/^\d+$/.test(valor)) return true;
      return false;
    });
    expect(suspeitos.map((s) => `${s.n}: ${s.chave}`)).toEqual([]);
  });

  it("as chaves que o instalador gera vêm VAZIAS no exemplo", () => {
    const vazias = [
      "NEXT_PUBLIC_SUPABASE_ANON_KEY",
      "SUPABASE_SERVICE_ROLE_KEY",
      "INTERNAL_SECRET",
      "CPF_ENCRYPTION_KEY",
      "WAHA_BYO_ENCRYPTION_KEY",
      "AI_CRED_AES_KEY",
      "EVOLUTION_API_KEY",
      "EVOLUTION_WEBHOOK_TOKEN",
      "EVOLUTION_DB_PASSWORD",
      "SRH_TOKEN",
      "UPSTASH_REDIS_REST_TOKEN",
      "IMPERSONATE_COOKIE_SECRET",
      "LGPD_SIGNING_KEY",
      "DISPARO_REAL_LIBERADO",
    ];
    for (const chave of vazias) {
      const linha = atribuicoes.find((a) => a.chave === chave);
      expect(linha, `${chave} não está no .env.example`).toBeDefined();
      expect(linha?.valor, chave).toBe("");
    }
  });

  it("o envio real aparece explicado e desligado", () => {
    expect(exemplo).toMatch(/^DISPARO_REAL_LIBERADO=\s*$/m);
    expect(exemplo).toContain('"sim"');
  });

  it("documenta as variáveis de porta do instalador", () => {
    for (const v of ["CRM_ALQUIMIA_PORTA_APP", "CRM_ALQUIMIA_PORTA_WORKER", "CRM_ALQUIMIA_PORTA_EVOLUTION"]) {
      expect(exemplo).toContain(v);
    }
  });

  it("documenta o webhook global e o token que o instalador gera", () => {
    expect(exemplo).toMatch(/^EVOLUTION_WEBHOOK_TOKEN=\s*$/m);
    expect(exemplo).toMatch(/^EVOLUTION_WEBHOOK_GLOBAL=\s*$/m);
  });

  it("toda variável tem um comentário logo acima (ou faz parte de um bloco que o tem)", () => {
    const linhas = exemplo.split("\n");
    const ehAtribuicao = (l: string) => /^[A-Z][A-Z0-9_]{3,}=/.test(l);
    const semComentario: string[] = [];
    linhas.forEach((linha, i) => {
      if (!ehAtribuicao(linha)) return;
      let j = i - 1;
      while (j >= 0 && ehAtribuicao(linhas[j] ?? "")) j--;
      if (!(linhas[j] ?? "").trim().startsWith("#")) semComentario.push(`${i + 1}: ${linha.split("=")[0]}`);
    });
    expect(semComentario).toEqual([]);
  });
});
