/**
 * Perfis de ritmo: três pontos de partida para quem não quer ajustar campo por campo. Um perfil define SÓ o ritmo de
 * aberturas (rampa, intervalos, pausa longa e máximos por hora); o resto do ritmo (janela, feriados, saúde,
 * quarentena...) é da organização e um perfil nunca o toca.
 *
 * `recomendado` é o padrão do motor (`RITMO_PADRAO`), então uma organização nova já nasce nele. Aplicar um perfil é
 * mesclar estes campos no ritmo gravado e validar o conjunto (`aplicarPerfil`); qualquer ajuste depois disso faz o
 * ritmo virar `personalizado` (`perfilDoRitmo`).
 */
import { RITMO_PADRAO, type Ritmo, ritmoSchema } from "./config";

export const PERFIS = ["conservador", "recomendado", "acelerado"] as const;
export type PerfilDeRitmo = (typeof PERFIS)[number];

/** Os campos que um perfil define. `perfilDoRitmo` compara só estes. */
const CAMPOS_DO_PERFIL = [
  "rampa",
  "intervaloNova",
  "intervaloNovaMaduro",
  "intervaloNovaPisoMin",
  "pausa",
  "pausaACada",
  "maxAberturasHora",
  "maxEnviosHora",
] as const satisfies readonly (keyof Ritmo)[];
type CampoDoPerfil = (typeof CAMPOS_DO_PERFIL)[number];

const doPadrao = Object.fromEntries(CAMPOS_DO_PERFIL.map((c) => [c, RITMO_PADRAO[c]])) as Pick<Ritmo, CampoDoPerfil>;

export const PERFIS_DE_RITMO: Record<PerfilDeRitmo, Partial<Ritmo>> = {
  conservador: {
    rampa: [6, 8, 10, 12, 14, 16, 18, 20, 22, 24],
    intervaloNova: { min: 15, max: 25 },
    intervaloNovaMaduro: { min: 12, max: 20 },
    intervaloNovaPisoMin: 15,
    pausa: { min: 25, max: 45 },
    pausaACada: { min: 4, max: 6 },
    maxAberturasHora: 4,
    maxEnviosHora: 8,
  },
  recomendado: doPadrao,
  acelerado: {
    rampa: [14, 17, 20, 24, 28, 32, 36, 40],
    intervaloNova: { min: 8, max: 12 },
    intervaloNovaMaduro: { min: 8, max: 10 },
    intervaloNovaPisoMin: 8,
    pausa: { min: 15, max: 30 },
    pausaACada: { min: 7, max: 12 },
    maxAberturasHora: 8,
    maxEnviosHora: 16,
  },
};

/** Comparação que não depende da ordem das chaves (o jsonb do Postgres reordena `{ min, max }`). */
const ordenado = (_chave: string, v: unknown) =>
  v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v;
const mesmo = (a: unknown, b: unknown) => JSON.stringify(a, ordenado) === JSON.stringify(b, ordenado);

/** Qual perfil o ritmo segue, comparando só os campos que os perfis definem. Qualquer diferença: `personalizado`. */
export function perfilDoRitmo(ritmo: Ritmo): PerfilDeRitmo | "personalizado" {
  return PERFIS.find((p) => CAMPOS_DO_PERFIL.every((c) => mesmo(ritmo[c], PERFIS_DE_RITMO[p][c]))) ?? "personalizado";
}

/**
 * Mescla os campos do perfil no ritmo GRAVADO (o jsonb, não o normalizado) e valida o conjunto com `ritmoSchema`.
 * Devolve `null` se o resultado não for um ritmo válido (ex.: o gravado já estava quebrado em outro campo).
 */
export function aplicarPerfil(gravado: unknown, perfil: PerfilDeRitmo): Record<string, unknown> | null {
  const base = gravado && typeof gravado === "object" && !Array.isArray(gravado) ? (gravado as Record<string, unknown>) : {};
  const novo = { ...base, ...PERFIS_DE_RITMO[perfil] };
  return ritmoSchema.safeParse(novo).success ? novo : null;
}
