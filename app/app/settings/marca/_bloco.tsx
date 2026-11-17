/**
 * O bloco da marca da organização: lê o que está gravado e as duas camadas de
 * baixo e desenha o formulário. Mora num arquivo próprio porque DUAS telas o
 * mostram — `Configurações › Marca` e o bloco "Marca da empresa" de
 * `Configurações › Personalizar` — e duas cópias do carregamento divergiriam.
 *
 * Quem chama decide o PAPEL (admin): isto não confere nada. A proteção do dado é
 * `fn_definir_marca_da_organizacao`, que re-resolve o papel no banco (42501).
 */
import { marcaDaInstalacao } from "@/lib/branding/instalacao";
import { marcaDaOrganizacaoDeSettings } from "@/lib/branding/organizacao";
import { env } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";

import { FormularioDaMarcaDaOrganizacao } from "./_form";

export async function BlocoDaMarcaDaOrganizacao({ orgId }: { orgId: string }) {
  // Client de SESSÃO para LER, igual às telas irmãs: a leitura de `organizations`
  // é permitida a membro pela RLS, e usar o admin client aqui seria contornar a
  // política para buscar o que a política já entrega. Quem precisa de privilégio
  // é a ESCRITA — e ela mora na função SQL, não nesta tela.
  const supabase = await createClient();
  const { data } = await supabase
    .from("organizations")
    .select("settings")
    .eq("id", orgId)
    .maybeSingle();

  const gravada = marcaDaOrganizacaoDeSettings(data?.settings ?? null);
  const linha = await marcaDaInstalacao();

  return (
    <FormularioDaMarcaDaOrganizacao
      gravada={{
        app_name: gravada?.app_name ?? null,
        accent_hex: gravada?.accent_hex ?? null,
        // O CAMINHO no bucket, não a URL: quem converte é `logoDaCamada`, do
        // lado do navegador, com a base do Storage injetada em runtime. Mandar
        // a URL pronta do servidor faria a tela ter uma segunda regra de
        // montagem, e a que divergisse seria a que ninguém abre.
        logo_path: gravada?.logo_path ?? null,
      }}
      // As DUAS camadas de baixo descem para o formulário, e não uma resolução
      // já pronta: a prévia ao vivo remonta a pilha inteira a cada tecla, pelo
      // mesmo caminho do servidor. Sem elas, a tela não saberia responder "e se
      // eu apagar o nome, o que aparece?" — que é a pergunta que o placeholder
      // e o bloco de origens existem para responder.
      instalacao={{
        app_name: linha?.app_name ?? null,
        logo_url: linha?.logo_url ?? null,
        logo_path: linha?.logo_path ?? null,
        accent_hex: linha?.accent_hex ?? null,
      }}
      // Só os três campos de marca do ambiente, nunca o objeto `env` inteiro:
      // isto atravessa a fronteira para o navegador, e o que atravessa é o que
      // já está visível na interface de qualquer forma.
      ambiente={{
        APP_NAME: env.APP_NAME,
        APP_LOGO_URL: env.APP_LOGO_URL,
        APP_ACCENT_HEX: env.APP_ACCENT_HEX,
      }}
    />
  );
}
