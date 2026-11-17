import { beforeAll, describe, expect, it } from "vitest";

import { GOV_MANAGER, GOV_ORG, seedGov, sql } from "./gov-helpers";

/**
 * A CREDENCIAL DO OLLAMA NÃO TEM CHAVE — E SÓ ELA (migration 0260).
 *
 * O modelo local não usa chave, então as quatro colunas do segredo passaram a
 * aceitar NULL. Afrouxar a coluna sem um guarda por provedor abriria o banco para
 * uma credencial da Anthropic sem chave, que só falharia na primeira chamada; por
 * isso os dois lados do CHECK são medidos aqui:
 *
 *  - ollama: aceita sem chave, com endereço; recusa chave e recusa sem endereço;
 *  - todo outro provedor: recusa sem chave e recusa `base_url`.
 *
 * E a coluna nova segue a regra da 0150: o manager LÊ o endereço pela view segura
 * (não é segredo), e continua sem alcançar o ciphertext.
 *
 * Arquivo NOVO e não caso em invariante existente: os congelados não se editam.
 * Roda no `test:db` (o lead roda fora da janela de envio).
 */

const ID_OLLAMA = "eeeeeeee-4444-4000-8000-000000000001";
const ID_ANTHROPIC = "eeeeeeee-4444-4000-8000-000000000002";

/** Roda o script; devolve o erro do psql (stderr) ou null se passou. */
function tentar(script: string): string | null {
  try {
    sql(script);
    return null;
  } catch (err) {
    return String((err as { stderr?: string }).stderr ?? err);
  }
}

const COM_CHAVE = "'\\x01'::bytea, '\\x02'::bytea, '\\x03'::bytea, '4242'";

function inserir(id: string, provider: string, label: string, chave: boolean, baseUrl: string | null): string | null {
  const colunas = chave ? COM_CHAVE : "null, null, null, null";
  return tentar(`
    insert into public.ai_provider_credentials
      (id, organization_id, provider, label, api_key_encrypted, api_key_iv, api_key_tag, api_key_last4, base_url)
      values ('${id}', '${GOV_ORG}', '${provider}', '${label}', ${colunas},
              ${baseUrl === null ? "null" : `'${baseUrl}'`});
  `);
}

beforeAll(() => {
  seedGov();
  sql(`delete from public.ai_provider_credentials where label like 'ollama-0260%';`);
});

describe("0260 — ollama grava sem chave, com endereço", () => {
  it("⭐ aceita as quatro colunas do segredo NULL e o endereço", () => {
    expect(inserir(ID_OLLAMA, "ollama", "ollama-0260-ok", false, "http://localhost:11434")).toBeNull();
    expect(
      sql(`select base_url from public.ai_provider_credentials where id = '${ID_OLLAMA}';`),
    ).toBe("http://localhost:11434");
  });

  it("recusa ollama SEM endereço", () => {
    const erro = inserir("eeeeeeee-4444-4000-8000-000000000010", "ollama", "ollama-0260-sem-end", false, null);
    expect(erro, "ollama sem base_url passou: não há para onde ir").toContain("ai_provider_credentials_endereco_so_ollama");
  });

  it("recusa ollama COM chave: segredo que nunca seria lido não é guardado", () => {
    const erro = inserir(
      "eeeeeeee-4444-4000-8000-000000000011",
      "ollama",
      "ollama-0260-com-chave",
      true,
      "http://localhost:11434",
    );
    expect(erro).toContain("ai_provider_credentials_chave_por_provedor");
  });
});

describe("0260 — os outros provedores seguem exigindo chave e não têm endereço", () => {
  it("⭐ anthropic SEM chave é recusado pelo CHECK (afrouxar a coluna não abriu o banco)", () => {
    const erro = inserir(ID_ANTHROPIC, "anthropic", "ollama-0260-anthropic-sem-chave", false, null);
    expect(
      erro,
      "uma credencial da Anthropic sem chave foi aceita — o CHECK por provedor da 0260 não está valendo",
    ).toContain("ai_provider_credentials_chave_por_provedor");
  });

  it("chave pela metade (só o ciphertext) também é recusada", () => {
    const erro = tentar(`
      insert into public.ai_provider_credentials
        (id, organization_id, provider, label, api_key_encrypted, api_key_iv, api_key_tag, api_key_last4)
        values ('eeeeeeee-4444-4000-8000-000000000012', '${GOV_ORG}', 'openai', 'ollama-0260-meia',
                '\\x01'::bytea, null, null, null);
    `);
    expect(erro).toContain("ai_provider_credentials_chave_por_provedor");
  });

  it("base_url em provedor com chave é recusado", () => {
    const erro = inserir(
      "eeeeeeee-4444-4000-8000-000000000013",
      "openai",
      "ollama-0260-openai-com-endereco",
      true,
      "http://localhost:11434",
    );
    expect(erro).toContain("ai_provider_credentials_endereco_so_ollama");
  });

  it("CONTROLE POSITIVO: provedor com chave e sem endereço segue entrando", () => {
    expect(inserir("eeeeeeee-4444-4000-8000-000000000014", "openai", "ollama-0260-openai-ok", true, null)).toBeNull();
  });
});

describe("0260 — a coluna nova respeita o grant por coluna da 0150", () => {
  function leComo(userId: string, select: string): string | null {
    try {
      return sql(`
        set role authenticated;
        select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
        ${select}
      `);
    } catch {
      return null;
    }
  }

  it("⭐ manager lê o endereço pela view segura", () => {
    const saida = leComo(
      GOV_MANAGER,
      `select base_url from public.ai_provider_credentials_safe where id = '${ID_OLLAMA}';`,
    );
    expect(saida, "o manager foi barrado: faltou o grant select (base_url) ou a coluna na view").not.toBeNull();
    expect(String(saida)).toContain("http://localhost:11434");
  });

  it("manager continua SEM alcançar o ciphertext", () => {
    expect(
      leComo(GOV_MANAGER, `select api_key_encrypted from public.ai_provider_credentials where id = '${ID_OLLAMA}';`),
    ).toBeNull();
  });
});
