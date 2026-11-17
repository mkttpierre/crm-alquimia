import type { Lead } from "@/lib/types/leads";

export interface PipelineVocabulary {
  lead?: string;
  deal?: string;
  won?: string;
  lost?: string;
}

export interface Pipeline {
  id: string;
  organization_id: string;
  name: string;
  slug: string;
  description: string | null;
  is_default: boolean;
  is_archived: boolean;
  position: number;
  vocabulary: PipelineVocabulary;
  settings: Record<string, unknown>;
}

export interface Stage {
  id: string;
  organization_id: string;
  pipeline_id: string;
  name: string;
  slug: string;
  position: number;
  color: string | null;
  is_won: boolean;
  is_lost: boolean;
  is_archived: boolean;
  expected_duration_hours: number | null;
}

/**
 * O que o board sabe de cada etapa além dos cards que vieram.
 *
 * O board devolve só a primeira página de cada etapa (ver
 * `app/api/v1/pipelines/[id]/board/route.ts`); o contador da coluna e a soma
 * de valor não podem sair do `leads.length`, senão a Base de 1.485 leads
 * apareceria como "50".
 */
export interface StagePage {
  /** Leads da etapa que passam no filtro — contagem no banco. */
  total: number;
  /** Soma de `value_cents` da etapa inteira (com o filtro), não só da página. */
  value_cents: number;
  /**
   * `position_in_stage` do primeiro lead que NÃO veio (null = não há mais).
   * Soltar um card no fim de uma lista parcial usa este número como vizinho de
   * baixo; sem ele o card cairia no meio dos leads que a tela não carregou.
   */
  next_position: number | null;
}

export interface BoardData {
  pipeline: Pipeline;
  stages: Stage[];
  /** Os leads carregados (primeiras páginas + as que o usuário abriu). */
  leads: Lead[];
  /** Por etapa: total real, soma e onde a próxima página começa. */
  stage_pages?: Record<string, StagePage>;
  /** Tags em uso no funil inteiro (opções do filtro; a página não basta). */
  tags?: string[];
  /** O lead do deep link `?lead=`, quando ele não está em nenhuma página. */
  lead_em_foco?: Lead | null;
}

/** Resposta de `GET .../board?stage_id=&offset=` — a próxima página de UMA etapa. */
export interface StagePageData extends StagePage {
  stage_id: string;
  offset: number;
  leads: Lead[];
}
