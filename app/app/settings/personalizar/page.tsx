/**
 * Configurações → Personalizar. Três blocos, e o papel decide quais aparecem:
 *
 *  - "Sua barra" (todos): cada pessoa oculta, mostra e reordena os tópicos da
 *    PRÓPRIA barra lateral;
 *  - "Nomes dos tópicos" (admin): o nome de cada linha de topo da barra, para
 *    todos da organização;
 *  - "Marca da empresa" (admin): nome, cor e logo — o formulário que também
 *    mora em `Configurações › Marca`.
 *
 * O papel aqui só decide o que DESENHAR. Quem protege cada gravação é a Server
 * Action e, de novo, a função SQL (`fn_definir_minha_barra`,
 * `fn_definir_nomes_da_barra`, `fn_definir_marca_da_organizacao`, que re-resolve
 * o papel no banco e levanta 42501). Ocultar um tópico NÃO é permissão: a tela
 * ocultada segue abrindo pelo link e pelo ⌘K.
 *
 * A lista de linhas vem de `barraParaPersonalizar` — a MESMA projeção da barra —,
 * então a tela e a barra nunca discordam sobre o que existe, a ordem ou o nome.
 * Nada de ícone atravessa para o cliente (componente não é serializável): a
 * tela lista só texto e controles.
 */
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { carregarPersonalizacaoDaBarra } from "@/lib/navigation/personalizar-carregar";
import {
  lerPreferenciasDaBarra,
  preferenciasTemEscolha,
  type PersonalizacaoDaBarra,
  type PreferenciasDaBarra,
} from "@/lib/navigation/personalizar";
import { barraParaPersonalizar, chavesConhecidasDaBarra } from "@/lib/navigation/registry";

import { BlocoDaMarcaDaOrganizacao } from "../marca/_bloco";

import { NomesDosTopicos, type CampoDeNome } from "./_components/NomesDosTopicos";
import { SuaBarra, type BlocoEditavel } from "./_components/SuaBarra";

export const metadata = { title: "Personalizar" };
export const dynamic = "force-dynamic";

export default async function PersonalizarPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  const idioma = user.idioma;

  const plataforma = user.is_platform_admin && !user.support;
  const ehAdmin = plataforma || ROLE_RANK[activeOrg.role] >= ROLE_RANK.admin;

  // Os NOMES são da organização e se leem pelo id dela, também em suporte. A
  // preferência é da pessoa: em suporte não há vínculo próprio (`null`), e então o
  // bloco "Sua barra" não existe — salvar daria `nao_gravou`.
  const emSuporte = !!user.support;
  const personalizacao: PersonalizacaoDaBarra = await carregarPersonalizacaoDaBarra(
    emSuporte ? null : user.id,
    activeOrg.orgId,
  );
  const preferencias = lerPreferenciasDaBarra(personalizacao.preferencias);
  const nomesGravados = personalizacao.nomes ?? {};

  const secoes = barraParaPersonalizar(
    plataforma,
    activeOrg.role,
    activeOrg.interface_settings,
    personalizacao,
  );

  const blocos: BlocoEditavel[] = secoes.map(({ secao, itens }) => ({
    id: secao.id,
    titulo: secao.titulo,
    itens: itens.map((i) => ({
      chave: i.chave,
      label: i.label,
      nomeProprio: i.nomeProprio,
      oculto: i.oculto,
      fixo: i.fixo,
    })),
  }));

  const linhas = secoes.flatMap((s) => s.itens);
  const campos: CampoDeNome[] = linhas.map((i) => ({
    chave: i.chave,
    nomePadrao: i.nomePadrao,
    nome: i.nomeProprio ? i.label : "",
  }));
  const chavesListadas = new Set(linhas.map((i) => i.chave));
  const preservados = Object.fromEntries(
    Object.entries(nomesGravados).filter(([chave]) => !chavesListadas.has(chave)),
  );

  // O que está gravado e NÃO aparece agora (a interface do vínculo ou o papel tiraram
  // a linha) volta no envio de "Salvar", para um "Salvar" de hoje não apagar a escolha
  // de uma linha que o admin pode liberar amanhã. Chave que saiu do catálogo se perde.
  const conhecidas = chavesConhecidasDaBarra();
  const mantem = (chave: string) => conhecidas.has(chave) && !chavesListadas.has(chave);
  const preservadasDaBarra: PreferenciasDaBarra = {
    ocultos: preferencias.ocultos.filter(mantem),
    ordem: preferencias.ordem.filter(mantem),
  };

  // Muda quando o que está gravado muda: é o que faz os formulários remontarem
  // com o estado novo depois do `router.refresh()` de "Salvar" e "Restaurar".
  const versao = JSON.stringify([preferencias, nomesGravados]);

  return (
    <div className="flex h-full flex-col gap-8 overflow-y-auto p-4 sm:p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">
          {traduzir("Personalizar", idioma)}
        </h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {emSuporte
            ? traduzir("Escolha os nomes dos tópicos da barra e a marca da empresa.", idioma)
            : ehAdmin
              ? traduzir(
                  "Deixe a barra lateral do seu jeito e, como administrador, escolha os nomes dos tópicos e a marca da empresa.",
                  idioma,
                )
              : traduzir(
                  "Deixe a barra lateral do seu jeito: o que aparece e em que ordem.",
                  idioma,
                )}
        </p>
      </header>

      <div className="w-full max-w-3xl space-y-10">
        {!emSuporte && (
          <SuaBarra
            key={`barra-${versao}`}
            blocos={blocos}
            preservados={preservadasDaBarra}
            temEscolhaSalva={preferenciasTemEscolha(preferencias)}
          />
        )}

        {ehAdmin && (
          <NomesDosTopicos key={`nomes-${versao}`} campos={campos} preservados={preservados} />
        )}
      </div>

      {ehAdmin && (
        <section id="marca" aria-labelledby="marca-titulo" className="w-full max-w-5xl space-y-4">
          <header>
            <h2 id="marca-titulo" className="text-lg font-semibold tracking-tight">
              {traduzir("Marca da empresa", idioma)}
            </h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              {traduzir(
                "O nome e a cor que a sua empresa mostra para quem trabalha aqui dentro.",
                idioma,
              )}
            </p>
          </header>
          <BlocoDaMarcaDaOrganizacao orgId={activeOrg.orgId} />
        </section>
      )}
    </div>
  );
}
