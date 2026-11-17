import { iconeDaMarca } from "@/lib/branding/icone-imagem";
import { marcaDaSaida } from "@/lib/branding/saida";

/**
 * O ícone de "adicionar à tela de início" do iOS (apple-touch), 180 px.
 *
 * Nada configurado → o sol BRANCO sobre `#111111`, como pede o brandkit para o
 * ícone do app; marca configurada → o ladrilho da cor dela com a inicial. O
 * desenho é o do ícone da aba (`lib/branding/icone-imagem.tsx`), e valem aqui as
 * duas razões de `app/icon.tsx`: gerado em runtime (`force-dynamic`, porque a
 * imagem Docker é uma só para todas as marcas) e sem tocar a rede.
 *
 * Na RAIZ de `app/`, nunca dentro de route group (o Next acrescentaria um hash ao
 * caminho), e em `PUBLIC_PATHS` (`/apple-icon`): o iOS o pede antes de existir
 * sessão, e o matcher do `proxy.ts` só dispensa caminho com extensão.
 */

export const dynamic = "force-dynamic";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default async function AppleIcon() {
  const marca = await marcaDaSaida(null);
  return iconeDaMarca(marca, "app", size.width);
}
