"use client";

import { useEffect, useState } from "react";

import { useAuth } from "@/hooks/auth/AuthProvider";
import { useMarcaDaInstalacao } from "@/lib/branding/contexto";
import { clarearEscritaEscura } from "@/lib/branding/logo-no-escuro";

import { EscritaDoProduto, SolDoProduto } from "./ArteDoProduto";

/**
 * A marca no topo da barra lateral.
 *
 * QUEM MANDA É O SISTEMA DE MARCA PRÓPRIA (`lib/branding`), na mesma ordem de
 * antes desta tela:
 *
 *  1. logo próprio (da organização, senão da instalação) → a imagem dele;
 *  2. nome próprio configurado (organização, banco da instalação ou `.env`) →
 *     o nome em texto — é o único lugar da casca onde o nome da organização
 *     aparece, e sem ele `settings.branding.app_name` voltaria a ser campo
 *     decorativo;
 *  3. nada configurado → o padrão do produto: o sol e a escrita do brandkit,
 *     com "CRM" pequeno embaixo (protótipo A).
 *
 * Os valores chegam por PROP do servidor (`useMarcaDaInstalacao`, `activeOrg`),
 * nunca por `branding()`: SSR e hidratação leem o mesmo objeto, então o tipo do
 * elemento (img, texto ou arte) não troca entre os dois — ver
 * `lib/branding/contexto.tsx`.
 */
export function MarcaDoProduto({
  marcaPropria,
}: {
  /**
   * Resolvido NO SERVIDOR (`app/app/layout.tsx`, pelas `origens` de
   * `resolverMarcaDaOrganizacao`): nome ou logo vieram de alguma camada
   * configurada (organização, banco da instalação ou `.env`), e não do padrão do
   * produto. Comparar o nome com a constante padrão aqui no cliente confundiria
   * "não configurou" com "configurou o mesmo texto".
   */
  marcaPropria: boolean;
}) {
  const { activeOrg } = useAuth();
  const instalacao = useMarcaDaInstalacao();
  const nome = activeOrg?.marca?.nome ?? instalacao.name;
  // `||` e não `??`: logo vazio é AUSÊNCIA de logo e desce para a camada de baixo.
  const logo = activeOrg?.marca?.logoUrl || instalacao.logoUrl;
  const logoNoEscuro = useLogoNoEscuro(logo || null);

  if (logo) {
    return (
      <div className="flex items-center px-2 pt-1 pb-[14px]" data-marca="logo">
        {/* <img> e não next/image: a URL é de quem hospeda e next/image exige a
            allowlist de domínios fechada no build da imagem pré-buildada.
            A barra é preta: a escrita escura do logo vira branca aqui
            (lib/branding/logo-no-escuro.ts); até a versão clara ficar pronta,
            ou se ela falhar, aparece o logo original. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={logoNoEscuro ?? logo}
          alt={nome}
          data-logo-no-escuro={logoNoEscuro ? "" : undefined}
          data-logo-original={logo}
          className="h-[34px] w-auto max-w-[200px] object-contain"
        />
      </div>
    );
  }

  if (marcaPropria) {
    return (
      <div className="flex items-center px-2 pt-1 pb-[14px]" data-marca="nome">
        <span className="truncate text-[15px] font-semibold tracking-tight text-lateral-texto">
          {nome}
        </span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2.5 px-2 pt-1 pb-[14px]" data-marca="produto">
      <SolDoProduto className="h-[34px] w-[34px] shrink-0" />
      <div>
        <EscritaDoProduto nome={nome} className="block h-5 w-[66px] text-lateral-texto" />
        <small className="mt-[3px] block font-mono text-[10px] leading-none tracking-[0.14em] text-lateral-suave">
          CRM
        </small>
      </div>
    </div>
  );
}

/**
 * Versão do logo para a barra preta: a escrita escura trocada por branco, como
 * `data:` URL. `null` enquanto processa, quando o logo já serve no escuro (nada
 * a trocar) ou quando o navegador não deixa ler os pixels (servidor sem CORS):
 * nesses casos a barra mostra o logo original.
 */
const ALTURA_MAXIMA_PROCESSADA = 136;

function useLogoNoEscuro(url: string | null): string | null {
  const [resultado, setResultado] = useState<{ url: string; claro: string | null } | null>(null);

  useEffect(() => {
    if (!url) return;
    let vivo = true;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      let claro: string | null = null;
      try {
        // A barra mostra o logo com 34px de altura: 4× isso basta para tela
        // retina e evita ler milhões de pixels de um logo enviado em 4000px.
        const escala = Math.min(1, ALTURA_MAXIMA_PROCESSADA / Math.max(1, img.naturalHeight));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.naturalWidth * escala);
        canvas.height = Math.round(img.naturalHeight * escala);
        const ctx = canvas.getContext("2d");
        if (ctx && canvas.width > 0 && canvas.height > 0) {
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          const dados = ctx.getImageData(0, 0, canvas.width, canvas.height);
          if (clarearEscritaEscura(dados.data) > 0) {
            ctx.putImageData(dados, 0, 0);
            claro = canvas.toDataURL("image/png");
          }
        }
      } catch {
        claro = null; // canvas "sujo" (sem CORS): fica o original
      }
      if (vivo) setResultado({ url, claro });
    };
    img.onerror = () => {
      if (vivo) setResultado({ url, claro: null });
    };
    img.src = url;
    return () => {
      vivo = false;
    };
  }, [url]);

  return resultado && resultado.url === url ? resultado.claro : null;
}
