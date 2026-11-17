/**
 * GET /api/v1/disparo/simulacao[?perfil=conservador|recomendado|acelerado] — o dia de HOJE (no fuso do ritmo) dos
 * chips do motor da organização, simulado com as mesmas regras do motor (`lib/disparo-painel/simular-dia.ts`): a que
 * horas sairiam as aberturas, onde caem as pausas longas, quantas cabem.
 *
 * SÓ LEITURA, e nada é enviado. `perfil` pré-visualiza o ritmo com aquele perfil aplicado, SEM salvar (salvar é o
 * `PATCH /api/v1/disparo/config { perfil }`). Entram todos os chips da organização: o pausado, o desligado, o vermelho e o
 * que está em pausa de saúde aparecem parados, com o motivo. O chip que ainda não abriu o dia é desenhado com o degrau que
 * o motor vai usar hoje (sobe se está em rampa, verde e mandou algo nos últimos 4 dias, como `repo.mandouDesde`).
 * A semente do sorteio é o dia: a mesma tela no mesmo dia mostra o mesmo desenho.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { lerRitmo } from "@/lib/disparo/config";
import { aplicarPerfil, PERFIS, perfilDoRitmo } from "@/lib/disparo/perfis";
import type { EstadoChip, SaudeChip } from "@/lib/disparo/fila";
import { blocosDoDia, inicioDoDia, MIN, relogio } from "@/lib/disparo/ritmo";
import { simularDia } from "@/lib/disparo-painel/simular-dia";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** Teto de linhas lidas para "mandou nos últimos 4 dias": cobre 4 dias de qualquer chip com folga. */
const LIMITE_DE_SAIDAS = 5000;

const consultaSchema = z.object({ perfil: z.enum(PERFIS).optional() });

/** Semente do dia (AAAA-MM-DD → número): estável ao longo do dia, muda no seguinte. */
const sementeDoDia = (data: string) => Number(data.replaceAll("-", ""));

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "disparo_config" });
  if (!authz.ok) return authz.response;
  const { org, user } = authz;
  const t = (texto: string) => traduzir(texto, user.idioma);

  const consulta = consultaSchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!consulta.success) return fail("validation_failed", t("Perfil desconhecido."), 422, { requestId });
  const { perfil } = consulta.data;

  const supabase = await createClient();
  const { data: config, error } = await supabase.from("disparo_config").select("ritmo, teto_diario").eq("organization_id", org.orgId).maybeSingle();
  if (error) return fail("internal_error", t("Não foi possível simular o dia."), 500, { requestId });

  const gravado = config?.ritmo ?? {};
  const atual = lerRitmo(gravado);
  let ritmo = atual;
  if (perfil) {
    const comPerfil = aplicarPerfil(gravado, perfil);
    if (!comPerfil) return fail("validation_failed", t("O ritmo gravado não aceita este perfil."), 422, { requestId });
    ritmo = lerRitmo(comPerfil);
  }

  const agora = new Date();
  const hoje = inicioDoDia(agora, ritmo.fusoMinutos);
  const [{ data: chips, error: erroChips }, { data: saidas, error: erroSaidas }] = await Promise.all([
    supabase
      .from("disparo_chips")
      .select("id, nome, estado, saude, dia_rampa, pausado_ate, proximo_envio_em")
      .eq("organization_id", org.orgId)
      .order("nome", { ascending: true }),
    // A mesma pergunta do motor ao abrir o dia (`repo.mandouDesde`): algo saiu do chip nos últimos 4 dias?
    supabase
      .from("disparo_envios")
      .select("chip_id")
      .eq("organization_id", org.orgId)
      .in("estado", ["enviado", "simulado"])
      .gte("enviado_em", new Date(hoje.getTime() - 4 * 24 * 60 * MIN).toISOString())
      .lt("enviado_em", hoje.toISOString())
      .limit(LIMITE_DE_SAIDAS),
  ]);
  if (erroChips || erroSaidas) return fail("internal_error", t("Não foi possível simular o dia."), 500, { requestId });
  const mandaram = new Set((saidas ?? []).map((s) => s.chip_id).filter((id): id is string => !!id));

  const data = relogio(agora, ritmo.fusoMinutos).data;
  const s = simularDia(
    ritmo,
    (chips ?? []).map((c) => ({
      nome: c.nome,
      diaRampa: c.dia_rampa,
      estado: c.estado as EstadoChip,
      saude: c.saude as SaudeChip,
      pausadoAte: c.pausado_ate ? new Date(c.pausado_ate) : null,
      proximoEnvioEm: c.proximo_envio_em ? new Date(c.proximo_envio_em) : null,
      mandouRecente: mandaram.has(c.id),
    })),
    agora,
    sementeDoDia(data),
    config?.teto_diario ?? null,
  );
  return ok(
    {
      perfil: perfil ?? perfilDoRitmo(atual),
      perfil_atual: perfilDoRitmo(atual),
      dia: data,
      // A janela de hoje (minutos locais) e o fuso: a tela desenha a linha do dia com eles.
      janela: blocosDoDia(agora, ritmo),
      fuso_minutos: ritmo.fusoMinutos,
      ...s,
    },
    { requestId },
  );
}
