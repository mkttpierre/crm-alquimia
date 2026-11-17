import { describe, expect, it } from "vitest";

import { conferirEnderecoProprio } from "@/lib/ai/provedores/endereco-proprio";
import {
  classificarIp,
  conferirEnderecoOllama,
  normalizarEnderecoOllama,
  type ResolvedorDeEnderecos,
} from "@/lib/ai/provedores/endereco-ollama";

/**
 * A POLÍTICA DE REDE DO OLLAMA, E A PROVA DE QUE ELA NÃO AFROUXOU A DOS OUTROS.
 *
 * Endereço local/privado é aceito SÓ no ollama e SÓ por admin. Para os demais
 * provedores a regra de `endereco-proprio.ts` (https, público, resolvendo para IP
 * público — porque lá a chave viaja nele) segue valendo; o segundo bloco prende
 * isso com os MESMOS endereços que o primeiro aceita.
 */

const ADMIN = { porAdmin: true } as const;
const NAO_ADMIN = { porAdmin: false } as const;
const resolvendo =
  (...ips: string[]): ResolvedorDeEnderecos =>
  async () =>
    ips;
const naoResolve: ResolvedorDeEnderecos = async () => {
  throw new Error("ENOTFOUND");
};

const LOCAIS_E_PRIVADOS = [
  "http://localhost:11434",
  "http://127.0.0.1:11434",
  "http://127.1.2.3:11434",
  "http://[::1]:11434",
  "http://host.docker.internal:11434",
  "http://10.0.0.5:11434",
  "http://172.16.4.2:11434",
  "http://172.31.255.1:11434",
  "http://192.168.1.20:11434",
  "http://100.100.1.1:11434", // CGNAT: onde mora o Tailscale
  "http://[fd12:3456::1]:11434", // ULA
];

describe("ollama: endereço local/privado só com admin", () => {
  it.each(LOCAIS_E_PRIVADOS)("%s é aceito para admin", async (url) => {
    const r = await conferirEnderecoOllama(url, ADMIN);
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });

  it.each(LOCAIS_E_PRIVADOS)("%s é recusado para quem não é admin", async (url) => {
    const r = await conferirEnderecoOllama(url, NAO_ADMIN);
    expect(r).toMatchObject({ ok: false, codigo: "endereco_local_so_admin" });
  });

  it("normaliza: tira a barra final e devolve só protocolo e host", async () => {
    const r = await conferirEnderecoOllama("  http://LocalHost:11434/  ", ADMIN);
    expect(r).toEqual({ ok: true, url: "http://localhost:11434", local: true });
  });

  it("nome interno só vale se TODOS os endereços forem internos", async () => {
    expect((await conferirEnderecoOllama("http://ollama:11434", { ...ADMIN, resolver: resolvendo("172.18.0.3") })).ok).toBe(true);
    expect(
      await conferirEnderecoOllama("http://ollama:11434", { ...NAO_ADMIN, resolver: resolvendo("172.18.0.3") }),
    ).toMatchObject({ ok: false, codigo: "endereco_local_so_admin" });
  });

  it("nome que mistura público e interno é recusado (assinatura de rebinding)", async () => {
    const r = await conferirEnderecoOllama("https://x.exemplo.com", {
      ...ADMIN,
      resolver: resolvendo("93.184.216.34", "10.0.0.9"),
    });
    expect(r).toMatchObject({ ok: false, codigo: "endereco_inseguro" });
  });

  it("nome que não resolve é recusado", async () => {
    expect(await conferirEnderecoOllama("http://sumiu.exemplo:11434", { ...ADMIN, resolver: naoResolve })).toMatchObject({
      ok: false,
      codigo: "endereco_inseguro",
    });
  });
});

describe("ollama: o que nenhum papel alcança", () => {
  it.each([
    "http://169.254.169.254", // metadata de nuvem
    "http://169.254.1.1:11434",
    "http://0.0.0.0:11434",
    "http://224.0.0.1",
    "http://[fe80::1]:11434",
    "http://[::ffff:169.254.169.254]:11434", // IPv4 escondido em IPv6
    "http://[fd00:ec2::254]", // metadata IPv6 da AWS, dentro da faixa ULA
    "http://[fd00:ec2:0:0:0:0:0:254]:11434",
    "http://2852039166", // 169.254.169.254 em decimal (a URL normaliza)
  ])("%s é recusado até para admin", async (url) => {
    expect(await conferirEnderecoOllama(url, ADMIN)).toMatchObject({ ok: false, codigo: "endereco_inseguro" });
    expect(normalizarEnderecoOllama(url)).toMatchObject({ ok: false });
  });

  it("nome que resolve para link-local é recusado", async () => {
    expect(
      await conferirEnderecoOllama("http://metadata.exemplo", { ...ADMIN, resolver: resolvendo("169.254.169.254") }),
    ).toMatchObject({ ok: false, codigo: "endereco_inseguro" });
  });

  it.each([
    ["ftp://localhost:11434", "protocolo"],
    ["http://user:senha@localhost:11434", "usuário e senha"],
    ["http://localhost:11434/api/tags", "caminho"],
    ["http://localhost:11434/?k=1", "query"],
    ["http://localhost:11434/#x", "âncora"],
    ["isto não é url", "formato"],
  ])("%s (%s) é inválido", async (url) => {
    expect(await conferirEnderecoOllama(url, ADMIN)).toMatchObject({ ok: false, codigo: "endereco_invalido" });
  });
});

describe("ollama: endereço público", () => {
  it("só com https", async () => {
    const resolver = resolvendo("93.184.216.34");
    expect((await conferirEnderecoOllama("https://ollama.exemplo.com", { ...NAO_ADMIN, resolver })).ok).toBe(true);
    expect(await conferirEnderecoOllama("http://ollama.exemplo.com", { ...ADMIN, resolver })).toMatchObject({
      ok: false,
      codigo: "endereco_inseguro",
    });
  });

  it("IPv4 público literal também exige https", async () => {
    expect((await conferirEnderecoOllama("https://93.184.216.34:11434", NAO_ADMIN)).ok).toBe(true);
    expect((await conferirEnderecoOllama("http://93.184.216.34:11434", ADMIN)).ok).toBe(false);
  });
});

describe("classificarIp", () => {
  it("separa local, privado, público e proibido", () => {
    expect(classificarIp("127.0.0.1")).toBe("local");
    expect(classificarIp("::1")).toBe("local");
    expect(classificarIp("192.168.0.9")).toBe("privado");
    expect(classificarIp("172.15.0.1")).toBe("publico"); // fora do 172.16/12
    expect(classificarIp("8.8.8.8")).toBe("publico");
    expect(classificarIp("169.254.169.254")).toBe("proibido");
    expect(classificarIp("fd00:ec2::254")).toBe("proibido");
    expect(classificarIp("fd12:3456::1")).toBe("privado"); // controle: o resto da ULA segue aceito
    expect(classificarIp("0.0.0.0")).toBe("proibido");
  });
});

describe("os OUTROS provedores continuam recusando o que o ollama aceita", () => {
  // O resolver injetado simula o que um nome interno faria no DNS: se o guard
  // dos outros provedores o deixasse passar, o `resolver` seria o único freio.
  const resolverInterno = async (host: string): Promise<void> => {
    if (host === "host.docker.internal" || host === "ollama") throw new Error("unsafe_url:private_ip");
  };

  it.each(LOCAIS_E_PRIVADOS.map((u) => u.replace("http://", "https://")))(
    "%s é recusado por conferirEnderecoProprio (anthropic/openai/google/openrouter)",
    async (url) => {
      const r = await conferirEnderecoProprio(url, resolverInterno);
      expect(r.ok, url).toBe(false);
    },
  );

  it("http:// também, mesmo apontando para público", async () => {
    expect((await conferirEnderecoProprio("http://api.exemplo.com/v1", async () => undefined)).ok).toBe(false);
  });

  it("controle positivo: https público segue aceito", async () => {
    expect((await conferirEnderecoProprio("https://api.exemplo.com/v1", async () => undefined)).ok).toBe(true);
  });
});
