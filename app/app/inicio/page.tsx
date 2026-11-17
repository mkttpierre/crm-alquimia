import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { supportWriteError } from "@/lib/impersonate/support";
import { traduzir } from "@/lib/i18n/dicionario";
import { nomeDoCookieDoPainel, painelEscolhido, podeDefinirMeta, podeVerPainelDeVendas } from "@/lib/inicio/painel";
import { carregarResumoDoInicio } from "@/lib/inicio/resumo";
import { logger } from "@/lib/logger";
import { canSee } from "@/lib/navigation/interface";
import { carregarPainelDeVendasDaSessao, type PainelCarregado } from "@/lib/negocio/carregar-painel-vendas";
import { lerPeriodo } from "@/lib/negocio/periodos-do-painel";
import { createClient } from "@/lib/supabase/server";
import { nomesDosAtendentes } from "@/lib/users/nome-do-atendente";

import { AtividadeRecente } from "./_components/AtividadeRecente";
import { Cartao, SemDado } from "./_components/Cartao";
import { CardDeFunis } from "./_components/CardDeFunis";
import { GraficoDeConversas } from "./_components/GraficoDeConversas";
import { NumerosDoDia } from "./_components/NumerosDoDia";
import { AnunciosDoPeriodo } from "./_components/vendas/AnunciosDoPeriodo";
import { PainelDeVendas } from "./_components/vendas/PainelDeVendas";
import { SeletorDePaineis } from "./_components/vendas/SeletorDePaineis";

export const dynamic = "force-dynamic";

/**
 * O erro que os repositórios lançam é o `error` do Supabase como veio: na postgrest-js sem `throwOnError` é um OBJETO simples
 * (`{ message, code, details, hint }`), não um `Error` — `String(erro)` daria "[object Object]". Vai ao log só `message` e
 * `code`; `details` fica de fora porque, num 23514, traz a linha com os valores.
 */
function descreverErro(erro: unknown): { message: string; code?: string } {
  if (erro instanceof Error) return { message: erro.message };
  if (typeof erro === "object" && erro !== null) {
    const { message, code } = erro as { message?: unknown; code?: unknown };
    return {
      message: typeof message === "string" && message !== "" ? message : "erro sem mensagem",
      ...(typeof code === "string" && code !== "" ? { code } : {}),
    };
  }
  return { message: String(erro) };
}

/**
 * Início — a tela de entrada do app (protótipo A aprovado).
 *
 * O título ("Olá, <primeiro nome>") mora no topo da casca (`components/app/
 * Topo.tsx`), como no protótipo; aqui fica só um `<h1>` para leitor de tela.
 *
 * Client do USUÁRIO, não o admin: os números respeitam a RLS de quem olha, e
 * `carregarResumoDoInicio` ainda filtra `organization_id` em toda consulta (a
 * policy de `crm_pipelines` sozinha não isola — ver `app/app/kanban/page.tsx`).
 * O admin client entra só para o NOME de quem fez cada atividade
 * (`nomesDosAtendentes`, que expõe apenas `full_name`).
 *
 * Dois painéis: "Atendimento e envios" (este, o de sempre) e "Vendas e faturamento",
 * só para `manager`+. Quem pode vê o seletor no topo; os demais papéis recebem o
 * Início de sempre, SEM seletor e sem ler cookie nenhum. A escolha de cada pessoa
 * mora num cookie lido AQUI, no servidor (ver `lib/inicio/painel.ts`): o HTML já
 * nasce com o painel certo, e SSR e hidratação enxergam a mesma árvore.
 */
export default async function InicioPage({ searchParams }: { searchParams: Promise<{ periodo?: string | string[] }> }) {
  const user = await requireAuth();
  const org = await resolveActiveOrg(user);
  if (!org) redirect("/app/settings/profile");
  const idioma = user.idioma;
  const t = (texto: string) => traduzir(texto, idioma);

  const agora = new Date();
  const db = await createClient();

  const podeVendas = podeVerPainelDeVendas({ role: org.role, isPlatformAdmin: user.is_platform_admin, emSuporte: Boolean(user.support) });
  const nomeDoCookie = podeVendas ? nomeDoCookieDoPainel(user.id) : null;
  const painel = painelEscolhido(nomeDoCookie ? (await cookies()).get(nomeDoCookie)?.value : undefined, podeVendas);

  if (painel === "vendas") {
    const { periodo } = await searchParams;
    let carregado: PainelCarregado | null = null;
    try {
      carregado = await carregarPainelDeVendasDaSessao(db, org.orgId, lerPeriodo(periodo), agora);
    } catch (erro) {
      // Sem rastro, um erro de RLS ou de coluna vira só "não consegui carregar" e ninguém diagnostica. Só a organização, a
      // mensagem e o código: nenhum valor de dinheiro entra no log.
      logger.error("[inicio] painel de vendas não carregou", { org_id: org.orgId, ...descreverErro(erro) });
      carregado = null;
    }
    return (
      <div className="mx-auto flex w-full max-w-[1240px] flex-col gap-5">
        <h1 className="sr-only">{t("Início")}</h1>
        <SeletorDePaineis painel={painel} idioma={idioma} />
        {carregado ? (
          <PainelDeVendas
            carregado={carregado}
            idioma={idioma}
            admin={podeDefinirMeta({ role: org.role, isPlatformAdmin: user.is_platform_admin, escritaBloqueadaPeloSuporte: supportWriteError(user.support) !== null })}
            anuncios={
              <Suspense fallback={null}>
                <AnunciosDoPeriodo
                  organizationId={org.orgId}
                  desde={carregado.painel.desde}
                  ate={carregado.painel.ate}
                  hoje={carregado.hoje}
                  moeda={carregado.painel.moeda}
                  serie={carregado.painel.serie}
                  idioma={idioma}
                />
              </Suspense>
            }
          />
        ) : (
          <Cartao titulo={t("Vendas e faturamento")}>
            <SemDado texto={t("Não consegui carregar o painel de vendas agora. Recarregue a página em instantes.")} />
          </Cartao>
        )}
      </div>
    );
  }

  // Os números do motor seguem a régua da tela Disparo (`manager+`, no catálogo):
  // quem não abre o motor não vê o que ele enviou nem a taxa dele.
  const incluirMotor = canSee(
    { href: "/app/disparo", minRole: "manager" },
    user.is_platform_admin && !user.support,
    org.role,
  );
  const resumo = await carregarResumoDoInicio(db, org.orgId, {
    agora,
    incluirMotor,
    nomesDeUsuarios: nomesDosAtendentes,
  });

  return (
    <div className="mx-auto flex w-full max-w-[1240px] flex-col gap-5">
      <h1 className="sr-only">{t("Início")}</h1>
      {podeVendas && <SeletorDePaineis painel={painel} idioma={idioma} />}
      <NumerosDoDia resumo={resumo} idioma={idioma} />
      <GraficoDeConversas semanas={resumo.semanas} idioma={idioma} />
      <div className="grid gap-5 min-[861px]:grid-cols-2">
        <CardDeFunis funis={resumo.funis} idioma={idioma} />
        <AtividadeRecente atividades={resumo.atividades} agora={agora} idioma={idioma} />
      </div>
    </div>
  );
}
