/**
 * A promoção do primeiro dono a platform admin não pode virar
 * escalada de privilégio. Sem Postgres aqui (o `test:db` exercita o baseline),
 * este arquivo prende o texto da regra na migration 0258 e no apêndice do
 * baseline, que é o que o instalador aplica:
 *   - só quando `platform_admins` não tem NENHUMA linha (nem revogada);
 *   - só quando não existe outra organização (o segundo usuário não vira);
 *   - só para admin ativo da organização;
 *   - trava consultiva (dois primeiros cadastros ao mesmo tempo: um vence);
 *   - EXECUTE só para service_role.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const DIR = join(process.cwd(), "supabase", "migrations");
const ARQ = readdirSync(DIR).find((f) => f.endsWith("_0258_primeiro_dono_da_instalacao.sql"));

function corpoDaFuncao(sql: string): string {
  const i = sql.indexOf("create or replace function public.fn_promover_primeiro_dono_da_instalacao");
  expect(i).toBeGreaterThanOrEqual(0);
  const fim = sql.indexOf("notify pgrst", i);
  return sql.slice(i, fim).replace(/\r\n/g, "\n");
}

describe("0258: primeiro dono da instalação", () => {
  const migration = corpoDaFuncao(readFileSync(join(DIR, ARQ ?? "inexistente"), "utf8"));

  it("existe a migration", () => {
    expect(ARQ).toBeTruthy();
  });

  it("só promove quando não há platform admin nenhum, nem revogado", () => {
    expect(migration).toMatch(/if exists \(select 1 from public\.platform_admins\) then\s+return false;/);
    expect(migration).not.toMatch(/platform_admins\s+where/);
  });

  it("segundo usuário não vira: recusa se existe outra organização", () => {
    expect(migration).toMatch(
      /if exists \(select 1 from public\.organizations where id <> p_org\) then\s+return false;/,
    );
  });

  it("só para admin ativo da organização dele", () => {
    expect(migration).toMatch(/user_id = p_user and role = 'admin' and revoked_at is null/);
  });

  it("serializa por trava consultiva antes de conferir", () => {
    const trava = migration.indexOf("pg_advisory_xact_lock");
    expect(trava).toBeGreaterThan(0);
    expect(trava).toBeLessThan(migration.indexOf("from public.platform_admins"));
  });

  it("security definer com EXECUTE só para service_role", () => {
    expect(migration).toMatch(/security definer\s+set search_path = public, pg_temp/);
    expect(migration).toMatch(
      /revoke all on function public\.fn_promover_primeiro_dono_da_instalacao\(uuid, uuid\) from public, anon, authenticated;/,
    );
    const grants = migration.match(/grant execute on function public\.fn_promover_primeiro_dono_da_instalacao[^;]*;/g);
    expect(grants).toEqual([
      "grant execute on function public.fn_promover_primeiro_dono_da_instalacao(uuid, uuid) to service_role;",
    ]);
  });

  it("o baseline traz o mesmo corpo, antes da VARREDURA anon", () => {
    const baseline = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");
    expect(corpoDaFuncao(baseline)).toBe(migration);
    expect(baseline.indexOf("fn_promover_primeiro_dono_da_instalacao")).toBeLessThan(
      baseline.indexOf("-- ---- VARREDURA anon"),
    );
  });
});
