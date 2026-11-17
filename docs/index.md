---
type: index
project: CRM ALQUIM(IA)
status: draft
last_updated: 2026-07-29
generated_by: auditoria documental (Claude Code)
confidence: alta (inventário de arquivos é CONFIRMADO; agrupamento temático é INFERIDO)
audited_against: origin/main @ 789dfa6 (v1.0.0, 2026-07-27)
---

# Índice da documentação — CRM ALQUIM(IA)

Mapa dos **154** arquivos `.md` de `docs/`, espalhados por **20** subpastas — medido em
2026-08-14, com as réguas ao lado: `git ls-files 'docs/**/*.md' | wc -l` e
`git ls-files 'docs/**/*.md' | sed 's|^docs/||;s|/.*||' | sort -u | wc -l`. Os dois números
estavam errados (149 e 24) e a segunda régua nem existia — é a mesma classe que
a auditoria de afirmações de estado de 14/08/2026 (removida do repositório)
cataloga. Existe porque a documentação cresceu sem ponto
de entrada: sem este índice, humano e agente não acham o que já foi decidido e
reescrevem por cima.

**Regra de precedência quando dois docs discordam:**
`CLAUDE.md` (doutrina) > `docs/specs/` (contrato técnico) > `docs/prd/` (intenção) >
`HANDOFF-*.md` (estado de sessão) > README. Se achou divergência, corrija a fonte
de menor precedência e registre.

---

## 1. Comece por aqui

| Doc | Para quê |
|---|---|
| [`README.md`](../README.md) | O que é, quickstart de 5 min, stack, roadmap. Também em [EN](../README.en.md) / [ES](../README.es.md) |
| [`VISION.md`](../VISION.md) | Posicionamento, por que self-host, para quem |
| [`ARCHITECTURE.md`](../ARCHITECTURE.md) | Arquitetura em 1 página |
| [`AGENTS.md`](../AGENTS.md) | Contrato para agentes de código (qualquer ferramenta) |
| [`CLAUDE.md`](../CLAUDE.md) | **Doutrina não-negociável.** Convenções, anti-patterns, Definition of Done |
| [`CONTRIBUTING.md`](../CONTRIBUTING.md) | Como contribuir |
| [`CHANGELOG.md`](../CHANGELOG.md) | Mudanças por versão (SemVer). **Quem instalou lê antes de atualizar (`git pull` e o instalador)** — mudança que exige ação manual aparece sob "⚠️ Requer atenção" |
| [`docs/current-state.md`](current-state.md) | **O que está pronto, incompleto e quebrado hoje** |

## 2. Produto e intenção

| Doc | Conteúdo |
|---|---|
| [`prd/00-prd-master.md`](prd/00-prd-master.md) | PRD mestre — visão, escopo MVP, KPIs, restrições |
| [`prd/01-prd-platform-base.md`](prd/01-prd-platform-base.md) | Auth, tenancy, RBAC, framework LGPD |
| [`prd/02-prd-customer-360.md`](prd/02-prd-customer-360.md) | Customer 360 + identity resolution determinística |
| [`prd/03-prd-whatsapp-waha.md`](prd/03-prd-whatsapp-waha.md) | Canal WhatsApp, anti-banimento, janela 24h |
| [`prd/04-prd-pipeline-attendance.md`](prd/04-prd-pipeline-attendance.md) | Kanban, atendimento, tickets, handoff |
| [`prd/05-prd-ai-rag-handoff.md`](prd/05-prd-ai-rag-handoff.md) | IA conversacional, RAG por tenant, sentiment |
| [`prd/06-prd-nuvemshop-lgpd.md`](prd/06-prd-nuvemshop-lgpd.md) | Integração Nuvemshop + webhooks LGPD |
| [`business-rules/00-business-rules-catalog.md`](business-rules/00-business-rules-catalog.md) | **Catálogo de regras de negócio** — fonte da verdade fora do código |

## 3. Contrato técnico (specs)

Detalham schema SQL e payloads exatos. **Consulte antes de modelar qualquer coisa.**

| Spec | Domínio |
|---|---|
| [`specs/01`](specs/01-spec-platform-base.md) | Plataforma base — tenancy, RLS, RBAC, API, audit |
| [`specs/02`](specs/02-spec-customer-360.md) | Customer 360 |
| [`specs/03`](specs/03-spec-whatsapp-waha.md) | WAHA — fila outbound, warm-up, spinning, crons |
| [`specs/04`](specs/04-spec-pipeline-attendance.md) | Pipeline e atendimento |
| [`specs/05`](specs/05-spec-ai-rag-handoff.md) | IA, RAG, gatilhos de handoff |
| [`specs/06`](specs/06-spec-nuvemshop-lgpd.md) | Nuvemshop + LGPD |
| [`specs/07`](specs/07-spec-events-workers.md) | **`event_log`, workers, claim atômico, backoff/DLQ** |
| [`specs/08`](specs/08-spec-deploy-observability.md) | Deploy e observabilidade |
| [`specs/09`](specs/09-spec-frontend-backend-integration.md) | Integração front/back |
| [`specs/10`](specs/10-spec-ai-agents-runtime.md) | Runtime dos AI Agents |
| [`specs/11`](specs/11-spec-mcp-server-internal.md) | MCP server interno + catálogo de tools |
| [`specs/12`](specs/12-spec-ai-agents-ui.md) | UI dos AI Agents |
| [`specs/13`](specs/13-spec-governanca-atendimento.md) | Governança de atendimento (épico G1–G6) |
| [`specs/14`](specs/14-contrato-governanca-agentes-externos.md) | Contrato para agentes de IA externos |
| [`specs/15`](specs/15-spec-casos-humanos.md) | Casos humanos (IA delega a humano) |
| [`specs/16`](specs/16-spec-tres-papeis-do-agente.md) | **Três papéis do agente** — Conversador / Operador / Segurança |
| [`specs/17`](specs/17-spec-conversa-vira-lead.md) | **A conversa vira lead** — o elo entre atendimento e CRM |
| [`specs/17`](specs/17-spec-indice-de-atrito.md) | **Índice de Atrito** — medir o propósito (menor atrito p/ os dois lados), não a atividade |
| [`specs/RECONCILIATION-LOG.md`](specs/RECONCILIATION-LOG.md) | Log de reconciliação entre specs |

## 4. Doutrina e arquitetura

| Doc | Conteúdo |
|---|---|
| [`doctrine/sistema-vivo.md`](doctrine/sistema-vivo.md) | **Doutrina do Sistema Vivo — a LEI.** 7 invariantes + regra do tempo + Living System Checklist (item 13 do DoD) |
| [`doctrine/sistema-vivo/`](doctrine/sistema-vivo/README.md) | **Manual do Sistema Vivo** — 8 capítulos plugáveis (princípio universal + aplicação de referência). O *porquê* de cada invariante, e como adotar a doutrina em outro sistema |
| [`doctrine/restricao-de-canal.md`](doctrine/restricao-de-canal.md) | Auto-restrição × hetero-restrição de canais externos; contrato de parâmetros derivado |
| [`doctrine/separacao-fala-e-operacao.md`](doctrine/separacao-fala-e-operacao.md) | Vocabulário interno nunca vaza para o cliente |
| [`architecture/agent-turn.html`](architecture/agent-turn.html) | Diagrama do turno do agente (inbound → guardrails → outbound) |
| [`specs/pre-go-live-whatsapp.md`](specs/pre-go-live-whatsapp.md) | Modo de teste do WhatsApp por canal: lista de telefones, abertura ao público e compatibilidade com autorização por origem |
| [`architecture/pre-go-live-whatsapp.architecture.json`](architecture/pre-go-live-whatsapp.architecture.json) | Mapa do pré-go-live, configuração administrativa e gate compartilhado |
| [`architecture/teto-de-orcamento.architecture.json`](architecture/teto-de-orcamento.architecture.json) | **Mapa vivo do teto de gasto com IA** — quem alimenta o gate, o que a parada NÃO desfaz sozinha, e o laço de retorno (invariante 7) |
| [`release/teto-de-orcamento.md`](release/teto-de-orcamento.md) | **Nota de release para quem opera uma VPS** — o que muda, o que fazer (nada), a troca de rótulo de R$ para US$ e como ligar a proteção |
| [`research/architecture-diagrams.md`](research/architecture-diagrams.md) | Diagramas de arquitetura |
| [`research/reference-synthesis.md`](research/reference-synthesis.md) | Arquitetura herdada da referência WAHA |
| [`research/followup-reference-mining.md`](research/followup-reference-mining.md) | Pesquisa do motor de follow-up |
| [`threat-model.md`](threat-model.md) | **Superfície de ataque real do self-host** |
| [`alertas-de-seguranca-triados.md`](alertas-de-seguranca-triados.md) | Razão de cada alerta **descartado** no painel do GitHub, e o que a varredura por classe achou que o scanner não vê |

## 5. Design system

[`design-system/README.md`](design-system/README.md) é o ponto de entrada (v1.0, 5 escolhas
visuais lockadas: paleta Sage, Atkinson Hyperlegible, densidade aerada, Phosphor duotone,
IBM Plex Mono). Numerados `00`–`09`: overview, tokens, paleta, tipografia, densidade,
iconografia, componentes, motion, voice & tone, **anti-patterns**.
Fluxo de tela em `design-system/screen-flow/` (jornadas, clickflows, máquinas de estado,
acessibilidade).

## 6. Operar e instalar

| Doc | Conteúdo |
|---|---|
| [`SETUP.md`](SETUP.md) | Ponteiro para a instalação do README e o `.env.example` |
| [`runbooks/custo-e-cota-do-supabase.md`](runbooks/custo-e-cota-do-supabase.md) | **“Meu Supabase estourou a cota”** — como medir a origem do consumo, os dois intervalos da fila e as duas tabelas que só crescem |
| [`runbooks/ai-credentials-rotation.md`](runbooks/ai-credentials-rotation.md) | Rotação de credenciais de IA |
| [`../SECURITY.md`](../SECURITY.md) | Política de reporte de vulnerabilidade |

## 7. Testes e QA

| Doc | Conteúdo |
|---|---|
| [`testing/user-journey-map.md`](testing/user-journey-map.md) | **Mapa de jornadas vivo** — casos, prioridade `[P0]`, achados. Atualizar sempre |
| [`harness-audit.md`](harness-audit.md) | **Auditoria do harness** — 20 itens + nível de maturidade |
| a auditoria de afirmações de estado de 14/08/2026 (removida do repositório) | **393 afirmações de estado medidas contra a fonte**, cada uma com o comando que a responde. É o retrato datado que sustenta as correções de doutrina desta data — releia a data antes de citar qualquer número dele |
| a auditoria de afirmações de estado de 14/08/2026 (removida do repositório) | O que a tag `v1.3.0` — que é o kit que roda na VPS, e não a `main` — de fato contém |
| [`../tests/e2e/README.md`](../tests/e2e/README.md) | Como rodar os E2E |

## 8. Execução — planos, épicos, handoffs

Documentação de *processo*. Alta rotatividade; trate como estado, não como contrato.

Os handoffs, planos e relatórios de sessão do desenvolvimento original não fazem parte desta distribuição.
- [`stories/`](stories/) — épicos e stories (`epics/MASTER.md` = plano por epic/wave)
- [`white-label.md`](white-label.md) — instalação com marca própria, também em [en](white-label.en.md) e [es](white-label.es.md) (traduções seladas pelo hash do original; ver `scripts/selar-traducao.ts`)

## 9. Grafo de conhecimento

`graphify-out/` — grafo do repositório (7310 nós, 17705 arestas, 538 comunidades na última
geração). Consulte via skill `graphify` antes de varrer código bruto. `GRAPH_REPORT.md` traz
god nodes, hyperedges e comunidades. **Gerado — não editar.** ⚠️ Foi gerado contra uma árvore
anterior à v1.0.0; regenere (`/graphify .`) antes de confiar em detalhe fino.

---

## Lacunas conhecidas deste índice

- os planos de fusão e de deploy do agente externo (removidos do repositório) referem-se a uma
  integração ("agente externo") cujo status é **A CONFIRMAR** — o README **não a lista mais** em
  "Próximo", apesar de o gatilho (`loop/checkpoints/G6.approved`) existir.
- `docs/diagrams/` não tem `.md` e não foi inventariado. `docs/evidence/` é evidência visual
  (18 PNGs), não documentação de leitura.
- `docs/architecture/` reúne mapas JSON e seus renders disponíveis. Consulte o
  [catálogo de mapas](architecture/README.md) e os arquivos do diretório; a contagem
  muda com as entregas. A doutrina exige representar peças novas e suas relações,
  e `tests/unit/mapas-de-arquitetura.test.ts` verifica a forma e os kinds do runtime.
  Esse gate não comprova, sozinho, que toda funcionalidade tem um mapa.

- [Acompanhamento administrativo por sessão](support-sessions.md) — autoridade, somente leitura, saída e contratos OAuth.
