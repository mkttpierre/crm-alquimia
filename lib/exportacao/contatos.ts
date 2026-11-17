/**
 * Exportação de contatos em CSV: o que sai, em que ordem e com que filtros.
 *
 * ─── Decisões fixas ────────────────────────────────────────────
 *
 *  · Colunas: nome exibido, nome, telefone, e-mail, etiquetas (separadas por `|`), origem, criado em, e UMA coluna por
 *    chave de campo personalizado. Nada além disso: CPF, nascimento, consentimento e identificadores técnicos do canal
 *    NÃO são pedidos ao banco (o que não é lido não vaza).
 *  · Escopo: sempre `organization_id` explícito (além da RLS da sessão) e sem a lápide de fusão (`is_merged_into`), a
 *    mesma régua da listagem.
 *  · Anonimização (LGPD): contato anonimizado sai anonimizado. O nome é o que o banco guardou ("Cliente Anonimizado #7"),
 *    e telefone, e-mail, etiquetas e campos personalizados saem vazios mesmo que sobre algum resíduo na linha.
 *  · Filtros: os mesmos da listagem (`search`, `tag`, `source`).
 *  · Duas passadas, ambas paginadas: a primeira só descobre as chaves dos campos personalizados (o cabeçalho precisa ser
 *    conhecido antes do primeiro byte), a segunda entrega as linhas. A base nunca está inteira na memória.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { phoneLookupVariants } from "@/lib/channels/phone-variants";
import { hashCpf } from "@/lib/contacts/cpf";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";

import { textoDoCampo } from "./csv";
import { colunasDosCampos, lerEmPaginas, type ExportacaoPreparada } from "./paginar";

export interface FiltrosDeContatos {
  search?: string;
  tag?: string;
  source?: string;
}

interface ContatoLido {
  display_name: string | null;
  name: string | null;
  phone_number: string | null;
  email: string | null;
  tags: string[] | null;
  source: string | null;
  created_at: string | null;
  custom_fields: Record<string, unknown> | null;
  is_anonymized: boolean | null;
}

const COLUNAS_DA_LINHA = "id,display_name,name,phone_number,email,tags,source,created_at,custom_fields,is_anonymized";
const COLUNAS_DA_DESCOBERTA = "id,custom_fields,is_anonymized";

/**
 * A busca da listagem de contatos (`app/api/v1/contacts/_handler.ts`) como filtro do `.or()`: nome, nome exibido, e-mail,
 * telefone (com as variantes do nono dígito) e CPF por hash. Com `*` no lugar de `%`, que é o curinga que o PostgREST
 * aceita dentro do `or=(...)`.
 */
export function filtroDeBuscaDeContatos(bruta: string): string | null {
  const termo = bruta.trim().replace(/[%_]/g, (m) => `\\${m}`).replace(/[,()]/g, " ");
  if (!termo) return null;
  const digitos = bruta.replace(/\D/g, "");
  const partes = [
    `name.ilike.*${termo}*`,
    `display_name.ilike.*${termo}*`,
    `email.ilike.*${termo}*`,
    `phone_number.ilike.*${termo}*`,
  ];
  if (digitos.length >= 8) {
    // 10/11 dígitos sem DDI é DDD+local no Brasil: sem o 55 não nasce a variante com o nono dígito.
    const base = !digitos.startsWith("55") && (digitos.length === 10 || digitos.length === 11) ? `55${digitos}` : digitos;
    for (const variante of phoneLookupVariants(base)) {
      const d = variante.replace(/\D/g, "");
      if (d && d !== digitos) partes.push(`phone_number.ilike.*${d}*`);
    }
  }
  if (digitos.length === 11) partes.push(`cpf_hash.eq.${hashCpf(digitos)}`);
  return partes.join(",");
}

// O construtor do PostgREST muda de tipo a cada filtro; aqui só se encadeia.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Consulta = any;

function consultaDeContatos(db: SupabaseClient, orgId: string, filtros: FiltrosDeContatos, colunas: string): Consulta {
  let q: Consulta = db.from("contacts").select(colunas).eq("organization_id", orgId).is("is_merged_into", null);
  const busca = filtros.search ? filtroDeBuscaDeContatos(filtros.search) : null;
  if (busca) q = q.or(busca);
  if (filtros.tag) q = q.contains("tags", [filtros.tag]);
  if (filtros.source) q = q.eq("source", filtros.source);
  // `id` por último: chave total, sem ela a paginação repete ou pula linhas entre datas iguais.
  return q.order("created_at", { ascending: false }).order("id", { ascending: true });
}

export async function prepararExportacaoDeContatos(
  db: SupabaseClient,
  orgId: string,
  filtros: FiltrosDeContatos,
  t: (texto: string) => string,
): Promise<ExportacaoPreparada> {
  // Passada 1: as chaves dos campos personalizados. Contato anonimizado não conta: a coluna não nasce por causa dele.
  const chaves = new Set<string>();
  const descoberta = lerEmPaginas<Pick<ContatoLido, "custom_fields" | "is_anonymized">>((de, ate) =>
    consultaDeContatos(db, orgId, filtros, COLUNAS_DA_DESCOBERTA).range(de, ate),
  );
  for await (const pagina of descoberta) {
    for (const c of pagina) {
      if (c.is_anonymized !== false) continue;
      for (const chave of Object.keys(c.custom_fields ?? {})) chaves.add(chave);
    }
  }

  const fixas = ["Nome exibido", "Nome", "Telefone", "E-mail", "Etiquetas", "Origem", "Criado em"].map(t);
  const campos = colunasDosCampos(fixas, chaves);
  const cabecalho = [...fixas, ...campos.map((c) => c.coluna)];

  function linha(c: ContatoLido): string[] {
    // FALHA FECHADO: sem a marca explícita de "não anonimizado", a linha é tratada como anonimizada.
    const anonimo = c.is_anonymized !== false;
    const fixa = anonimo
      ? [rotuloDoContato({ display_name: c.display_name, name: c.name, phone_number: null }, t), c.name ?? "", "", "", "", c.source ?? "", c.created_at ?? ""]
      : [
          rotuloDoContato(c, t),
          c.name ?? "",
          c.phone_number ?? "",
          c.email ?? "",
          (c.tags ?? []).join("|"),
          c.source ?? "",
          c.created_at ?? "",
        ];
    const personalizados = campos.map(({ chave }) => (anonimo ? "" : textoDoCampo((c.custom_fields ?? {})[chave])));
    return [...fixa, ...personalizados];
  }

  async function* paginas(): AsyncGenerator<string[][]> {
    for await (const pagina of lerEmPaginas<ContatoLido>((de, ate) =>
      consultaDeContatos(db, orgId, filtros, COLUNAS_DA_LINHA).range(de, ate),
    )) {
      yield pagina.map(linha);
    }
  }

  return { cabecalho, paginas };
}
