/**
 * GET    /api/v1/leads/[id]/items            — linhas de produto do negócio + total (viewer+; a RLS filtra o negócio).
 * POST   /api/v1/leads/[id]/items            — adiciona uma linha: produto do catálogo (`product_id`) ou avulsa.
 * PATCH  /api/v1/leads/[id]/items            — corpo `{ item_id, ...campos }`: quantidade, preço, desconto, acréscimo, cupom.
 * DELETE /api/v1/leads/[id]/items?item_id=…  — remove a linha.
 *
 * Escrita é agent+. A organização vem da sessão (nunca do corpo) e a moeda é a do negócio. Nome, sku e preço do
 * catálogo são COPIADOS na criação (snapshot): mudar o preço do catálogo depois não reescreve o que já foi vendido.
 * `crm_leads.value_cents` acompanha a soma dos itens por trigger do banco (migration 0249) — esta rota só o relê.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, noContent, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { repositorioItensSupabase } from "@/lib/negocio/repositorio-itens";
import { erroDoItem, paraRespostaLista } from "@/lib/negocio/resposta-itens";
import { marcarGanhoPorProduto, reabrirSeSemItens } from "@/lib/negocio/ganho-por-itens";
import { acrescentarTagsDeCompra } from "@/lib/negocio/tag-de-compra";
import { itemAtualizarSchema, itemCriarSchema, itemIdQuerySchema } from "@/lib/negocio/schema-item";
import { totalDoItem } from "@/lib/negocio/totais";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

const MOEDA_PADRAO = "BRL";
const uuid = z.string().uuid();

async function lista(repo: ReturnType<typeof repositorioItensSupabase>, org: string, leadId: string) {
  const negocio = await repo.buscarNegocio(org, leadId);
  if (!negocio) return null;
  const moeda = negocio.currency ?? MOEDA_PADRAO;
  const itens = await repo.listar(org, leadId);
  return paraRespostaLista(itens, moeda, negocio.value_cents);
}

export async function GET(_req: NextRequest, { params }: RouteParams): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "crm_lead_items" });
  if (!authz.ok) return authz.response;
  const { id } = await params;
  if (!uuid.safeParse(id).success) return fail("validation_failed", "Id do negócio inválido.", 422, { requestId });
  try {
    const corpo = await lista(repositorioItensSupabase(await createClient()), authz.org.orgId, id);
    if (!corpo) return fail("not_found", "Negócio não encontrado.", 404, { requestId });
    return ok(corpo, { requestId });
  } catch {
    return fail("internal_error", "Erro ao listar os itens do negócio.", 500, { requestId });
  }
}

export async function POST(req: NextRequest, { params }: RouteParams): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "crm_lead_items" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;
  const { id } = await params;
  if (!uuid.safeParse(id).success) return fail("validation_failed", "Id do negócio inválido.", 422, { requestId });

  const parsed = itemCriarSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Dados do item inválidos.", 422, { requestId, details: parsed.error.flatten().fieldErrors as Record<string, unknown> });
  }
  const dados = parsed.data;

  try {
    const repo = repositorioItensSupabase(await createClient());
    const negocio = await repo.buscarNegocio(org.orgId, id);
    if (!negocio) return fail("not_found", "Negócio não encontrado.", 404, { requestId });
    const moeda = negocio.currency ?? MOEDA_PADRAO;

    let nome = dados.nome;
    let sku = dados.sku ?? null;
    let preco = dados.preco_unit_cents;
    if (dados.product_id) {
      const produto = await repo.buscarProduto(org.orgId, dados.product_id);
      if (!produto) return fail("not_found", "Produto não encontrado no catálogo.", 404, { requestId });
      if (!produto.ativo) return fail("validation_failed", "Este produto está inativo no catálogo.", 422, { requestId });
      if (produto.moeda !== moeda) {
        return fail("currency_mismatch", `O produto é em ${produto.moeda} e o negócio é em ${moeda}.`, 422, { requestId });
      }
      nome = dados.nome ?? produto.nome;
      sku = dados.sku === undefined ? produto.codigo : dados.sku;
      preco = dados.preco_unit_cents ?? produto.preco_cents;
    }

    const linha = {
      product_id: dados.product_id ?? null,
      nome: nome as string,
      sku,
      quantidade: dados.quantidade,
      preco_unit_cents: preco as number,
      desconto_cents: dados.desconto_cents,
      acrescimo_cents: dados.acrescimo_cents,
      cupom: dados.cupom ?? null,
      currency: moeda,
    };
    try {
      totalDoItem(linha);
    } catch {
      return fail("validation_failed", "O desconto não pode passar do valor da linha.", 422, { requestId, details: { desconto_cents: ["maior que o valor da linha"] } });
    }

    const criado = await repo.criar(org.orgId, user.id, id, linha);
    void audit({
      action: "lead_item.created",
      actorUserId: user.id,
      organizationId: org.orgId,
      resourceType: "crm_lead_item",
      resourceId: criado.id,
      requestId,
      metadata: { lead_id: id, product_id: criado.product_id, quantidade: criado.quantidade, total_cents: criado.total_cents, currency: criado.currency },
    });
    // Produto adicionado = etiqueta `COMPROU <P>` no negócio (melhor esforço, nunca lança, nunca remove tag).
    const sessao = await createClient();
    const comoVenda = new URL(req.url).searchParams.get("venda") === "1";
    await acrescentarTagsDeCompra(sessao, { organization_id: org.orgId }, id, [{ product_id: criado.product_id, nome: criado.nome }]);
    // Produto lançado como venda: o negócio vai para Ganho e entra no faturamento do Início (ver lib/negocio/ganho-por-itens.ts).
    // Só quando quem chama pede (`?venda=1`, o card da conversa): no dossiê do Kanban produto em negócio aberto pode ser previsão.
    const ganho = comoVenda ? await marcarGanhoPorProduto(sessao, { organization_id: org.orgId, actor: { type: "user", id: user.id }, requestId, idioma: user.idioma }, id) : null;
    const depois = await lista(repo, org.orgId, id);
    return ok({ item: criado, ganho, ...(depois ?? {}) }, { status: 201, requestId });
  } catch (e) {
    return erroDoItem(e, requestId);
  }
}

export async function PATCH(req: NextRequest, { params }: RouteParams): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "crm_lead_items" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;
  const { id } = await params;
  if (!uuid.safeParse(id).success) return fail("validation_failed", "Id do negócio inválido.", 422, { requestId });

  const parsed = itemAtualizarSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Dados do item inválidos.", 422, { requestId, details: parsed.error.flatten().fieldErrors as Record<string, unknown> });
  }
  const { item_id: itemId, ...parcial } = parsed.data;

  try {
    const repo = repositorioItensSupabase(await createClient());
    // Confere o total FINAL com o que já está gravado: PATCH só de desconto não pode estourar a linha sem o banco gritar 500.
    const atuais = (await repo.listar(org.orgId, id)).find((i) => i.id === itemId);
    if (!atuais) return fail("not_found", "Item não encontrado.", 404, { requestId });
    try {
      totalDoItem({
        quantidade: parcial.quantidade ?? atuais.quantidade,
        preco_unit_cents: parcial.preco_unit_cents ?? atuais.preco_unit_cents,
        desconto_cents: parcial.desconto_cents ?? atuais.desconto_cents,
        acrescimo_cents: parcial.acrescimo_cents ?? atuais.acrescimo_cents,
      });
    } catch {
      return fail("validation_failed", "O desconto não pode passar do valor da linha.", 422, { requestId, details: { desconto_cents: ["maior que o valor da linha"] } });
    }

    const salvo = await repo.atualizar(org.orgId, id, itemId, parcial);
    if (!salvo) return fail("not_found", "Item não encontrado.", 404, { requestId });
    void audit({
      action: "lead_item.updated",
      actorUserId: user.id,
      organizationId: org.orgId,
      resourceType: "crm_lead_item",
      resourceId: itemId,
      requestId,
      metadata: { lead_id: id, campos: Object.keys(parcial), total_cents: salvo.total_cents },
    });
    const depois = await lista(repo, org.orgId, id);
    return ok({ item: salvo, ...(depois ?? {}) }, { requestId });
  } catch (e) {
    return erroDoItem(e, requestId);
  }
}

export async function DELETE(req: NextRequest, { params }: RouteParams): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "crm_lead_items" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;
  const { id } = await params;
  if (!uuid.safeParse(id).success) return fail("validation_failed", "Id do negócio inválido.", 422, { requestId });

  const parsed = itemIdQuerySchema.safeParse({ item_id: new URL(req.url).searchParams.get("item_id") });
  if (!parsed.success) return fail("validation_failed", "Informe item_id.", 422, { requestId });

  try {
    const repo = repositorioItensSupabase(await createClient());
    const apagou = await repo.apagar(org.orgId, id, parsed.data.item_id);
    if (!apagou) return fail("not_found", "Item não encontrado.", 404, { requestId });
    void audit({
      action: "lead_item.deleted",
      actorUserId: user.id,
      organizationId: org.orgId,
      resourceType: "crm_lead_item",
      resourceId: parsed.data.item_id,
      requestId,
      metadata: { lead_id: id },
    });
    // Sem nenhum produto o negócio deixa de ser venda: reabre (só se estava ganho).
    if (new URL(req.url).searchParams.get("venda") === "1") await reabrirSeSemItens(await createClient(), { organization_id: org.orgId, actor: { type: "user", id: user.id }, requestId, idioma: user.idioma }, id);
    return noContent(requestId);
  } catch (e) {
    return erroDoItem(e, requestId);
  }
}
