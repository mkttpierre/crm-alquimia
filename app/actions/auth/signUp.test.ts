/**
 * O CADASTRO PRECISA DIZER QUANDO NÃO VAI EXISTIR E-MAIL PARA CLICAR.
 *
 * ─── O defeito, medido pela tela ────────────────────────────────────────────
 *
 * Provedor de auth com "Confirm email" DESLIGADO faz `signUp()` devolver uma
 * SESSÃO junto do usuário: a pessoa já entrou. Como a action devolvia só
 * `{ ok: true }`, a tela mostrava "Enviamos um link de confirmação para … abra
 * o e-mail e clique no link para ativar sua conta" — uma instrução impossível
 * de cumprir, porque e-mail nenhum foi enviado.
 *
 * Medido na `origin/main` @ `4d50f63f`, com `GOTRUE_MAILER_AUTOCONFIRM=true`,
 * dirigindo a tela: o texto acima aparecia, o cookie de sessão `sb-crm-alquimia-auth`
 * estava no browser, e `user_organizations` do usuário novo vinha `[]`. A pessoa
 * ficava esperando para sempre, autenticada e sem organização, sem motivo para
 * descobrir que a saída existe. Achado de @KIRAzinx566, com cliente real preso.
 *
 * ─── O que este arquivo guarda ──────────────────────────────────────────────
 *
 * Que `sessao_ativa` reflita a SESSÃO que o provedor devolveu — nos dois
 * sentidos. Guardar só o caso "com sessão" deixaria verde um `sessao_ativa: true`
 * constante, que mandaria para `/get-started` quem de fato precisa confirmar o
 * e-mail: pessoa sem sessão nenhuma, que cairia no `requireAuth()` e voltaria
 * para o login sem nunca ler que um e-mail a espera.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { ensureTenantForUser } from "@/lib/auth/provision";

vi.mock("@/lib/auth/provision", () => ({ ensureTenantForUser: vi.fn(async () => ({ provisioned: true })) }));
vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  audit: vi.fn(async () => undefined),
}));

const signUpDoProvedor = vi.fn();

/** Um e-mail novo por caso: o teto de `signup` é por IP e por janela. */
let n = 0;
const entrada = () => ({
  org_name: "Plata Iphones",
  email: `cadastro-${++n}-${Date.now()}@exemplo.test`,
  password: "SenhaForte!2026",
  password_confirm: "SenhaForte!2026",
});

describe("signUp — a tela precisa saber se a sessão já veio aberta", () => {
  beforeEach(() => {
    vi.resetModules();
    signUpDoProvedor.mockReset();
    vi.mocked(ensureTenantForUser).mockReset();
    vi.mocked(ensureTenantForUser).mockResolvedValue({ provisioned: true });
    vi.mocked(headers).mockResolvedValue({
      // IP diferente a cada caso, pelo mesmo motivo do e-mail.
      get: (k: string) => (k === "x-forwarded-for" ? `198.51.100.${n % 250}` : null),
    } as never);
    vi.mocked(createClient).mockResolvedValue({
      auth: { signUp: signUpDoProvedor },
    } as never);
  });

  it('"Confirm email" DESLIGADO: o provedor devolve sessão → sessao_ativa', async () => {
    // A forma exata que o GoTrue devolve com MAILER_AUTOCONFIRM=true.
    signUpDoProvedor.mockResolvedValue({
      data: { user: { id: "u-1" }, session: { access_token: "tok", refresh_token: "ref" } },
      error: null,
    });

    const { signUp } = await import("./signUp");
    const res = await signUp(entrada());

    expect(res).toEqual({ ok: true, sessao_ativa: true, organizacao_pronta: true });
    // Sem e-mail não há /auth/confirm: a organização nasce aqui.
    expect(ensureTenantForUser).toHaveBeenCalledTimes(1);
  });

  it("sessão aberta mas o provisionamento falha: o cadastro segue e a tela cai em /get-started", async () => {
    signUpDoProvedor.mockResolvedValue({
      data: { user: { id: "u-4" }, session: { access_token: "tok", refresh_token: "ref" } },
      error: null,
    });
    vi.mocked(ensureTenantForUser).mockRejectedValue(new Error("banco fora"));

    const { signUp } = await import("./signUp");
    const res = await signUp(entrada());

    expect(res).toEqual({ ok: true, sessao_ativa: true, organizacao_pronta: false });
  });

  it("sessão aberta COM convite: não abre organização própria", async () => {
    // O convite só vale com token assinado para o mesmo e-mail; aqui o token é inválido e a
    // action recusa ANTES de falar com o provedor — nenhum caminho provisiona.
    const { signUp } = await import("./signUp");
    const res = await signUp(
      { email: "convidado@exemplo.test", password: "SenhaForte!2026", password_confirm: "SenhaForte!2026" },
      "token-invalido",
    );
    expect(res.ok).toBe(false);
    expect(ensureTenantForUser).not.toHaveBeenCalled();
  });

  it("CONTROLE — confirmação LIGADA: sem sessão, a tela do e-mail continua certa", async () => {
    // Sem este caso, `sessao_ativa: true` fixo passaria — e mandaria para a
    // recuperação quem ainda nem tem sessão.
    signUpDoProvedor.mockResolvedValue({
      data: { user: { id: "u-2" }, session: null },
      error: null,
    });

    const { signUp } = await import("./signUp");
    const res = await signUp(entrada());

    expect(res).toEqual({ ok: true, sessao_ativa: false, organizacao_pronta: false });
    expect(ensureTenantForUser).not.toHaveBeenCalled();
  });

  it("CONTROLE — o provedor recusar continua sendo erro, não sessão", async () => {
    signUpDoProvedor.mockResolvedValue({
      data: { user: null, session: null },
      error: { message: "signup disabled", status: 422 },
    });

    const { signUp } = await import("./signUp");
    const res = await signUp(entrada());

    expect(res).toEqual({ ok: false, error: "signup_failed" });
  });
});
