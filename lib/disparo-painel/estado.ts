/**
 * Funções puras da tela do motor: montar o "estado" a partir da linha de
 * `disparo_config` e mesclar uma edição no jsonb `ritmo`.
 *
 * Quem lê o jsonb é `lerRitmo` (lib/disparo/config.ts) — este módulo não anda
 * pelo path do jsonb direto (anti-pattern nº 6). Nada aqui lê relógio nem
 * ambiente: `agora` e `ambiente` entram por parâmetro, para o teste fixar o
 * dia e provar a trava dos dois lados.
 */
import { lerRitmo, ritmoSchema } from "@/lib/disparo/config";
import { blocosDoDia, dentroDaJanela, relogio } from "@/lib/disparo/ritmo";
import { VARIAVEL_DA_TRAVA, envioRealLiberado, listaPermitida, motivoDoSimulado } from "@/lib/disparo/trava";

import type { EdicaoDaConfig, EstadoDoMotor } from "./esquemas";

export type LinhaDaConfig = {
  ligado: boolean;
  modo: string;
  teto_diario: number | null;
  cadencia: string;
  ritmo: unknown;
  atendimento: unknown;
};

const objeto = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? { ...(v as Record<string, unknown>) } : {};

/** A organização ainda não tem linha em `disparo_config`: o motor nunca foi configurado. */
export function estadoSemConfig(agora: Date): Pick<EstadoDoMotor, "existe" | "agora"> {
  return { existe: false, agora: agora.toISOString() };
}

export function montarEstado(
  config: LinhaDaConfig,
  agora: Date,
  ambiente: Record<string, string | undefined>,
): Omit<EstadoDoMotor, "proximo_envio" | "contagens" | "chips"> {
  const ritmo = lerRitmo(config.ritmo);
  const modo = config.modo === "real" ? "real" : "simulado";
  const liberado = envioRealLiberado({ modo }, ambiente);
  const r = relogio(agora, ritmo.fusoMinutos);
  const blocosHoje = blocosDoDia(agora, ritmo);
  const atendimento = objeto(config.atendimento);
  return {
    existe: true,
    ligado: config.ligado,
    modo,
    modo_efetivo: liberado ? "real" : "simulado",
    chave_da_organizacao: modo === "real",
    chave_do_servidor: ambiente[VARIAVEL_DA_TRAVA] === "sim",
    destinos_permitidos: listaPermitida(ambiente)?.size ?? null,
    motivo_simulado: motivoDoSimulado({ modo }, ambiente),
    teto_diario: config.teto_diario,
    cadencia: config.cadencia,
    atendimento_ligado: Object.keys(atendimento).length > 0,
    agora: agora.toISOString(),
    fuso_minutos: ritmo.fusoMinutos,
    hoje: {
      data: r.data,
      feriado: ritmo.feriados.includes(r.data),
      janela: blocosHoje,
      dentro_da_janela: dentroDaJanela(agora, ritmo),
    },
    janela: ritmo.janela,
    ritmo: {
      intervalo_nova: ritmo.intervaloNova,
      intervalo_piso_min: ritmo.intervaloNovaPisoMin,
      pausa: ritmo.pausa,
      pausa_a_cada: ritmo.pausaACada,
      max_aberturas_hora: ritmo.maxAberturasHora,
      max_envios_hora: ritmo.maxEnviosHora,
    },
  };
}

/**
 * Campos do ritmo que são SEÇÕES (objetos de campos nomeados): a edição de uma seção mescla dentro dela, em
 * profundidade (`mesclaProfunda`). Os outros campos (números, faixas, listas e os mapas livres `limitePorClasseDia` e
 * `rampasPorChip`) são substituídos inteiros — num mapa livre, mesclar impediria tirar uma chave.
 */
const SECOES_DO_RITMO = new Set(["janela", "filtroAbertura", "saude", "quarentena", "validade", "lembretes", "naoEntregue", "chipMudo"]);

/**
 * Mescla a edição no jsonb `ritmo` GRAVADO (não no normalizado): o que o seed
 * deixou fora continua herdando o padrão do motor. O conjunto é validado por
 * `ritmoSchema` — uma edição que o motor não aceitaria não chega ao banco.
 * Devolve `null` quando o resultado seria inválido.
 */
export function mesclarRitmo(
  gravado: unknown,
  edicao: NonNullable<EdicaoDaConfig["ritmo"]>,
): Record<string, unknown> | null {
  const base = objeto(gravado);
  const novo: Record<string, unknown> = { ...base };
  for (const [campo, valor] of Object.entries(edicao)) {
    novo[campo] = SECOES_DO_RITMO.has(campo) ? mesclaProfunda(base[campo], valor, campo) : valor;
  }
  return ritmoSchema.safeParse(novo).success ? novo : null;
}

/** Mapas livres dentro das seções: trocados inteiros, senão não daria para tirar uma chave. */
const MAPAS_LIVRES = new Set(["filtroAbertura.camposIguais", "lembretes.tetoDia"]);
const ehObjeto = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Mescla de seção em profundidade: mudar `saude.bloqueio.amarelo` não apaga `saude.bloqueio.vermelho` nem
 * `saude.horasSemEntrega`. Listas e mapas livres são trocados inteiros.
 */
function mesclaProfunda(gravado: unknown, edicao: unknown, caminho: string): unknown {
  if (!ehObjeto(edicao) || MAPAS_LIVRES.has(caminho)) return edicao;
  const base = ehObjeto(gravado) ? gravado : {};
  const novo: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(edicao)) novo[k] = mesclaProfunda(base[k], v, `${caminho}.${k}`);
  return novo;
}

/** Forma canônica para comparar: o jsonb do Postgres devolve as chaves em outra ordem que a do corpo. */
const canonico = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonico)
    : v && typeof v === "object"
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonico((v as Record<string, unknown>)[k])]))
      : (v ?? null);
const igual = (a: unknown, b: unknown) => JSON.stringify(canonico(a)) === JSON.stringify(canonico(b));

/** Campos de `disparo_config` cujo valor é um mapa: a auditoria desce uma chave neles. */
const CAMPOS_MAPA = new Set(["ritmo", "modelos"]);

/**
 * Antes e depois SÓ do que mudou, para a auditoria (`disparo.config_atualizada`). Nos mapas (`ritmo`, `modelos`)
 * desce uma chave: mudar a rampa não copia o ritmo inteiro para o log. Chave ausente de um lado vira `null`.
 */
export function diferencasDaConfig(
  antes: Record<string, unknown>,
  depois: Record<string, unknown>,
): { antes: Record<string, unknown>; depois: Record<string, unknown> } {
  const r = { antes: {} as Record<string, unknown>, depois: {} as Record<string, unknown> };
  for (const campo of Object.keys(depois)) {
    if (igual(antes[campo], depois[campo])) continue;
    if (!CAMPOS_MAPA.has(campo)) {
      r.antes[campo] = antes[campo] ?? null;
      r.depois[campo] = depois[campo] ?? null;
      continue;
    }
    const a = objeto(antes[campo]);
    const d = objeto(depois[campo]);
    const sub = { antes: {} as Record<string, unknown>, depois: {} as Record<string, unknown> };
    for (const chave of new Set([...Object.keys(a), ...Object.keys(d)])) {
      if (igual(a[chave], d[chave])) continue;
      sub.antes[chave] = a[chave] ?? null;
      sub.depois[chave] = d[chave] ?? null;
    }
    r.antes[campo] = sub.antes;
    r.depois[campo] = sub.depois;
  }
  return r;
}

/** "08:00" ↔ minutos desde a meia-noite (a tela edita em horário, o motor guarda minutos). */
export function minutosParaHora(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function horaParaMinutos(hora: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hora.trim());
  if (!m) return null;
  const min = Number(m[1]) * 60 + Number(m[2]);
  return Number(m[1]) <= 24 && Number(m[2]) < 60 && min <= 1440 ? min : null;
}
