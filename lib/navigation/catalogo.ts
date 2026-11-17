import type { Role } from "@/lib/auth/types";

/**
 * Registro de navegação — a ÚNICA lista de destinos do app do tenant.
 *
 * Antes disto, três listas descreviam o mesmo conjunto e divergiam: `NAV_ITEMS`
 * no Sidebar, `LINKS` no hub de Configurações e `TABS` na área de IA. Sete telas
 * só eram alcançáveis por dentro da própria seção e uma não tinha link nenhum.
 *
 * Sidebar, hubs e a paleta ⌘K são PROJEÇÕES puras deste array — nenhum deles
 * decide o que existe, só desenha o que sai daqui. Tela nova aparece nos três
 * sem editar três arquivos, e `tests/unit/navegacao-completude.test.ts` reprova
 * o CI se uma rota nascer fora daqui.
 *
 * Doutrina: docs/doctrine/sistema-vivo.md — "por qual porta se chega até mim?"
 */

export type NavGroupId = "atendimento" | "crm" | "ia" | "canais" | "analise" | "organizacao";

export interface NavGroup {
  id: NavGroupId;
  label: string;
  /**
   * Hub do grupo, quando ele tem telas demais para caber no sidebar.
   * O rótulo é declarado junto do href porque não é derivável: "Ver tudo em IA"
   * é útil, "Ver tudo em Organização" seria gratuito quando a tela já se chama
   * Configurações e o usuário a conhece por esse nome.
   */
  hub?: { href: string; label: string };
}

export interface NavMetadata {
  href: string;
  label: string;
  /** Aparece no card do hub e é texto buscável no ⌘K. Nunca vazio. */
  description: string;
  icon: string;
  group: NavGroupId;
  /** Obrigatória em grupo com hub — é o agrupamento por jornada dentro dele. */
  section?: string;
  /** Ausente = viewer. Ver a regra de escolha abaixo. */
  minRole?: Role;
  /** Ausente = só no hub. `true` = uso diário, sobe para o sidebar. */
  sidebar?: boolean;
  healthDot?: boolean;
}

/**
 * Grupos por OBJETIVO, na ordem de uso: o que se abre toda hora primeiro, o que
 * se ajusta uma vez por mês por último.
 *
 * "Análise" e não "Observabilidade": quem instala isto numa VPS é dono de PME,
 * não engenheiro. E configurar o sistema (grupo IA) é atividade diferente de
 * observar o sistema funcionando (grupo Análise) — por isso Evolução da IA mora
 * aqui, e não junto dos agentes.
 *
 * Hub só onde o grupo passa de 4 telas. Abaixo disso ele cabe inteiro no
 * sidebar, e um hub de 3 itens seria só um clique a mais para chegar onde já
 * dava para chegar.
 *
 * O CRM cruzou essa linha com a tela de Tarefas (PR #546), e o hub dele é a
 * cobrança de uma promessa escrita: o comentário de densidade do `Sidebar.tsx`
 * dizia, desde a vez em que Produtos estourou a dobra por uma linha, que
 * "quando o quinto destino de CRM aparecer, é hub que se cria, não mais 4px que
 * se raspa". Tarefas foi o quinto. Raspar de novo devolveria 13px e adiaria a
 * mesma conversa para a sexta tela.
 */
export const NAV_GROUPS: NavGroup[] = [
  { id: "atendimento", label: "Atendimento" },
  { id: "crm", label: "CRM", hub: { href: "/app/crm", label: "Ver tudo em CRM" } },
  { id: "ia", label: "Agente de IA", hub: { href: "/app/ai", label: "Ver tudo em IA" } },
  { id: "canais", label: "Canais" },
  { id: "analise", label: "Análise", hub: { href: "/app/analise", label: "Ver tudo em Análise" } },
  {
    id: "organizacao",
    label: "Organização",
    hub: { href: "/app/settings", label: "Configurações" },
  },
];

/**
 * Grupo cujo hub vive no RODAPÉ fixo do sidebar, fora da área que rola.
 *
 * Medido em tela (1280×768, o notebook comum): com todos os grupos na área
 * rolável, o conteúdo dava 1019px contra 663px visíveis — Configurações ficava
 * fora da dobra em TODAS as alturas testadas, inclusive 1080px. É o item que
 * mais se procura quando não se acha algo; deixá-lo dependendo de scroll
 * recriaria, em outra forma, o problema que esta reorganização veio resolver.
 */
export const GRUPO_NO_RODAPE: NavGroupId = "organizacao";

/**
 * Como `minRole` foi escolhido — medido tela a tela, não estimado:
 *
 *   1. A página redireciona por papel?  → usa esse papel. Assim a navegação
 *      nunca mostra um link que morre em /403.
 *   2. Não redireciona, mas a navegação antiga já filtrava? → mantém o filtro
 *      antigo, para esta mudança reorganizar sem alterar quem vê o quê.
 *   3. Nenhum dos dois → viewer.
 *
 * `ROLE_RANK` só distingue papel dentro do tenant; capacidade interna da tela
 * (`canShare` em Respostas rápidas, `canCompare` em Desempenho) NÃO é porta
 * fechada e por isso não vira `minRole`.
 */
export const NAV_CATALOG = [
  // ---- Atendimento — onde o operador passa o dia ----
  {
    // A tela de entrada: o dia num olhar — conversas, leads, motor,
    // funis e o que a equipe fez. Viewer vê: são números da organização que ele
    // já enxerga tela a tela, juntos num lugar só.
    href: "/app/inicio",
    label: "Início",
    description: "O dia num olhar: conversas abertas, leads novos, o motor, os funis e o que a equipe fez.",
    icon: "House",
    group: "atendimento",
    sidebar: true,
  },
  {
    href: "/app/inbox",
    label: "Inbox",
    description: "As conversas de WhatsApp, com você e a IA atendendo lado a lado.",
    icon: "Inbox",
    group: "atendimento",
    sidebar: true,
  },
  {
    href: "/app/radar",
    label: "Radar",
    description: "Quem esfriou e ainda está aberto — o que corre risco de morrer sem resposta.",
    icon: "ClockCountdown",
    group: "atendimento",
    sidebar: true,
  },
  {
    // Entra em "atendimento", e não em "organizacao", porque a Agenda é onde o
    // dia acontece e não onde ele se configura: quem atende abre isto de manhã
    // junto com o Inbox. Os TIPOS de agendamento — que são configuração de
    // verdade — foram para Configurações, como este comentário previa: ver
    // `/app/settings/tenant/agenda` no grupo "organizacao".
    //
    // ⚠️ ESTA FRASE ESTAVA VENCIDA: dizia "a disponibilidade ainda não tem tela",
    // e tem — é a aba "Atendimento" de `/app/team`, com editor de fuso e janelas
    // (`app/app/team/_components/AttendantsClient.tsx`). Ela chegou a custar uma
    // investigação inteira: quem leu isto aqui concluiu que faltava construir a
    // tela, quando o que faltava era o CAMINHO até ela. O aviso da Agenda agora
    // aponta para `/app/team?aba=atendimento`.
    href: "/app/agenda",
    label: "Agenda",
    description: "O que está marcado, com quem, e quem atende — seu e da equipe.",
    icon: "CalendarBlank",
    group: "atendimento",
    sidebar: true,
  },
  {
    // Renomeado de "Templates": estes são scripts do atendente, consumidos pelo
    // Composer do inbox. O nome "Templates" fica livre para os da Meta (HSM),
    // onde é o termo técnico correto.
    href: "/app/templates",
    // "Atalhos" (06/11/2026): mensagens, áudios, mídias, documentos e funis que a barra do chat acha pela palavra.
    label: "Atalhos",
    description: "Mensagens prontas, áudios, mídias e funis que você manda pela barra do chat.",
    icon: "FileText",
    group: "atendimento",
    sidebar: true,
  },

  // ---- CRM — o funil ----
  {
    // ⚠️ ERA "Kanban", e a URL continua sendo. O nome saiu da interface porque o
    // produto tinha CINCO vocabulários para a mesma coisa — "Kanban" no menu,
    // "Pipelines" no título desta tela, "Funis" no menu ao lado, "funil" em todo
    // o corpo dela e "quadro" no onboarding inteiro. Três deles no mesmo
    // viewport: o <h1> dizia "Pipelines", o estado vazio dizia "Sem pipelines
    // configurados" e o botão embaixo dizia "Criar meu primeiro funil".
    //
    // Ficou "Funis" porque é o que esta tela É: a lista dos funis, de onde se
    // abre o quadro de cada um. "Pipeline" é palavra de quem construiu o
    // sistema; "funil de vendas" é palavra de quem vende.
    href: "/app/kanban",
    label: "Funis",
    description: "Seus funis de venda — clique em um para abrir o quadro de clientes.",
    icon: "Kanban",
    group: "crm",
    section: "O dia a dia da venda",
    sidebar: true,
  },
  {
    href: "/app/contacts",
    label: "Contatos",
    description: "As pessoas do outro lado da conversa e seu histórico.",
    icon: "Users",
    group: "crm",
    section: "O dia a dia da venda",
    sidebar: true,
  },
  {
    // Tabela de clientes com compras, ciclo e última compra (Fase B, visual DataCrazy). Sem `sidebar`: o
    // sidebar do CRM já está no limite de altura medido pelo e2e; chega-se pelo hub do CRM e pelo ⌘K.
    href: "/app/leads",
    label: "Leads",
    description: "Todos os clientes numa tabela: total comprado, número de compras, ciclo e última compra.",
    icon: "Users",
    group: "crm",
    section: "O dia a dia da venda",
  },
  {
    // Extraída do PR #418 (@clinicacentrodosorrisosc-code). Fica no CRM e no
    // sidebar porque é tela de USO DIÁRIO — quem atende abre para ver o que
    // vence hoje, do mesmo jeito que abre o Inbox. Sem `minRole`: `viewer` VÊ
    // o que o time combinou (é informação de operação), e a criação é cobrada
    // pela rota, com `requireRole("agent")`.
    href: "/app/tasks",
    label: "Tarefas",
    description: "O que ficou combinado, com prazo — e o que já venceu sem ninguém fazer.",
    icon: "ListChecks",
    group: "crm",
    section: "O dia a dia da venda",
    sidebar: true,
  },
  {
    // ⚠️ Esta tela nasceu porque a FERRAMENTA já existia sem ela. O agente de IA
    // vinha com "procurar produto na loja" ligada por padrão, lendo uma tabela
    // que ninguém nunca preencheu — e o efeito não era silêncio: era o agente
    // respondendo "não tenho nada com esse nome" para uma loja de estoque cheio.
    //
    // Fica no grupo do CRM, e não em Configurações, porque o catálogo é insumo
    // de VENDA: ele existe para o agente responder preço na conversa.
    //
    // ⚠️ ESTA FRASE DIZIA "consultar preço é trabalho de quem ATENDE, todo dia",
    // e era o argumento para o `sidebar: true`. Ela se contradizia com a própria
    // descrição do destino, uma linha abaixo: quem responde o preço é o
    // atendente de IA, dentro do Inbox. O humano não abre esta tela para
    // vender — abre para cadastrar o que vende.
    href: "/app/products",
    label: "Produtos",
    description: "O catálogo da loja, com o preço que o atendente de IA responde.",
    icon: "Storefront",
    group: "crm",
    section: "Preparar a venda",
    // SEM `sidebar`: mora atrás de "Ver tudo em CRM".
    //
    // O critério é QUEM CONSOME a tela, e a descrição acima já o entrega: o
    // preço quem responde é o atendente de IA, dentro da conversa. Esta tela é
    // onde o catálogo se CADASTRA — trabalho de quando entra produto novo ou
    // muda preço, não de toda manhã. Quem atende não a abre para vender; abre o
    // Inbox e o funil, que continuam no menu.
  },
  {
    // A promessa que o comentário da Agenda fazia desde que ela nasceu. Aqui se
    // decide O QUE se pode marcar, quanto dura e quem atende — e é isto que a
    // tela de marcar e o agente de IA oferecem ao cliente.
    //
    // Nasceu porque a `calendar_event_types` tinha dez categorias no CHECK,
    // duração, buffers e antecedência mínima, e NÃO havia como criar ou editar
    // um tipo por lugar nenhum: a organização recebia três semeados e ficava com
    // eles para sempre.
    href: "/app/settings/tenant/agenda",
    label: "Tipos de agendamento",
    description: "O que se pode marcar, quanto dura, onde acontece e quem atende.",
    icon: "CalendarBlank",
    group: "organizacao",
    // "Sua empresa", junto de Atendimento e Empresa: é configuração do NEGÓCIO,
    // não da conta de quem está logado. O gate `navegacao-registry` cobra a
    // seção em todo grupo que tem hub, e sem ela o destino não aparece no hub.
    section: "Sua empresa",
    // SEM `sidebar`, como as outras DEZ entradas de "organizacao": este grupo
    // tem hub, e se chega às telas dele por "Configurações". Eu tinha posto
    // `sidebar: true` e a cerca reprovou dizendo "a tela existe e não tem porta
    // na navegação" — a porta existia, era outra.
  },
  {
    // Estava enterrado em Configurações e ninguém sabia que existia — o achado
    // que originou esta reorganização. A URL não muda; só o lugar na navegação.
    //
    // ⚠️ ERA "Funis", nome que ele DISPUTAVA com o destino acima: os dois
    // listavam as mesmas linhas de `crm_pipelines`, lado a lado no mesmo grupo,
    // com nomes que não diziam qual servia para quê. A diferença real é o VERBO,
    // e é ela que o nome carrega agora: lá se ABRE o funil, aqui se CONFIGURA o
    // que ele significa.
    href: "/app/settings/tenant/pipelines",
    label: "Etapas do funil",
    description: "As colunas de cada funil, o vocabulário do negócio e os motivos de perda.",
    icon: "Funnel",
    group: "crm",
    section: "Preparar a venda",
    minRole: "manager",
    // SEM `sidebar`: mora atrás de "Ver tudo em CRM".
    //
    // ⚠️ O ACHADO ORIGINAL NÃO FOI DESFEITO. Ele era "esta tela está enterrada
    // em CONFIGURAÇÕES e ninguém sabe que existe" — o problema era o GRUPO
    // errado, não a profundidade. Ela continua sendo CRM: aparece no hub do
    // CRM, no ⌘K, e o caminho é "CRM › Ver tudo em CRM", nunca mais
    // "Configurações". O que muda é a frequência: desenhar as colunas do funil
    // e escrever os motivos de perda é trabalho de montagem, feito uma vez e
    // revisitado por `manager` de vez em quando — enquanto Funis, Contatos e
    // Tarefas se abrem todo dia. É esse o corte que decide quem fica no menu.
  },

  // ---- Agente de IA — montar, ensinar, acompanhar ----
  {
    href: "/app/ai/agents",
    label: "Agentes",
    description: "Quem atende por você: instruções, modelo, ferramentas e publicação.",
    icon: "Robot",
    group: "ia",
    section: "Montar o agente",
    minRole: "manager",
    sidebar: true,
  },
  {
    href: "/app/ai/followups",
    label: "Follow-ups",
    description: "Como o agente retoma uma conversa que esfriou, para nenhuma morrer no silêncio.",
    icon: "FlowArrow",
    group: "ia",
    section: "Montar o agente",
    minRole: "manager",
    sidebar: true,
  },
  {
    href: "/app/ai/routers",
    label: "Roteadores",
    description: "Qual agente pega qual conversa, e quando o humano assume.",
    icon: "Signpost",
    group: "ia",
    section: "Montar o agente",
    minRole: "manager",
    sidebar: true,
  },
  {
    href: "/app/ai/credentials",
    label: "Credenciais",
    description: "A chave do provedor de IA que os agentes usam para pensar.",
    icon: "Key",
    group: "ia",
    section: "Montar o agente",
    minRole: "manager",
  },
  {
    // O sistema chama modelo em 23 lugares e, até esta tela, a escolha vivia
    // espalhada por três pilhas de código e sete variáveis de ambiente — não
    // havia onde responder "quem usa IA aqui, e com qual chave?".
    href: "/app/ai/providers",
    label: "Provedores",
    description: "Qual inteligência atende cada parte do sistema — e o que acontece se ela falhar.",
    icon: "Plugs",
    group: "ia",
    section: "Montar o agente",
    minRole: "manager",
    // SEM `sidebar: true`, como as outras nove telas deste grupo. Adicionar as
    // duas telas novas à sidebar estourou a dobra em 900px — medido pelo e2e
    // `navegacao.spec.ts`, que existe justamente porque agrupar o menu o faz
    // crescer. Configurar provedor é tarefa de poucas vezes; o caminho é o hub
    // "Ver tudo em IA", igual a Credenciais, Conhecimento, Memória e Skills.
  },
  {
    href: "/app/ai/knowledge/sources",
    label: "Conhecimento",
    description: "Os materiais que o agente consulta antes de responder sobre o seu negócio.",
    icon: "BookOpen",
    group: "ia",
    section: "Ensinar o agente",
    minRole: "manager",
  },
  {
    href: "/app/ai/memory",
    label: "Memória",
    description: "O que o agente já aprendeu sobre a sua operação e reaproveita.",
    icon: "Brain",
    group: "ia",
    section: "Ensinar o agente",
    minRole: "manager",
  },
  {
    href: "/app/ai/skills",
    label: "Skills",
    description: "As ações que o agente pode executar sozinho durante o atendimento.",
    icon: "PuzzlePiece",
    group: "ia",
    section: "Ensinar o agente",
    minRole: "manager",
  },
  {
    href: "/app/ai/cases",
    label: "Casos",
    description: "Os atendimentos que o agente conduziu, do início ao desfecho.",
    icon: "ClipboardText",
    group: "ia",
    section: "Acompanhar o agente",
    minRole: "agent",
  },
  {
    href: "/app/ai/inbox",
    label: "Alertas",
    description: "O que a IA encontrou e precisa de uma decisão sua.",
    icon: "Flag",
    group: "ia",
    section: "Acompanhar o agente",
  },
  {
    // Órfã: nenhum lugar do app linkava para cá. O flywheel gerava propostas de
    // melhoria do agente e a fila só era vista por quem soubesse a URL.
    href: "/app/ai/proposals",
    label: "Propostas",
    description: "Melhorias que a IA sugere para si mesma, esperando sua decisão.",
    icon: "Lightbulb",
    group: "ia",
    section: "Acompanhar o agente",
  },
  {
    // A tela de Uso responde "quanto gastei". Esta responde a pergunta que não
    // tinha lugar nenhum: "o agente parou de responder, o que aconteceu?".
    // Antes da migration 0128 ela seria impossível de construir com honestidade
    // — llm_calls só registrava sucesso.
    href: "/app/ai/runs",
    label: "Execuções",
    description: "O que a IA fez — e, quando falhou, o que aconteceu e o que fazer.",
    icon: "ListChecks",
    group: "ia",
    section: "Acompanhar o agente",
    minRole: "manager",
    // Idem: fora da sidebar para o menu não passar da dobra. Quem vem para cá
    // está diagnosticando, e chega pelo hub ou pelo link do aviso na Central.
  },
  {
    href: "/app/ai/usage",
    label: "Uso e orçamento",
    description: "Quanto a IA consumiu e qual é o teto de gasto do mês.",
    icon: "Gauge",
    group: "ia",
    section: "Acompanhar o agente",
    minRole: "manager",
  },

  // ---- Canais — por onde as mensagens entram e saem ----
  {
    href: "/app/connections",
    label: "Conexões",
    // Cobre os DOIS caminhos desde o PR #105: número por QR e canal oficial da
    // Meta (com os templates dele), cada um numa aba. A descrição cita "oficial"
    // e "Meta" de propósito — é por esses nomes que se procura no ⌘K, e a busca
    // varre a descrição além do rótulo.
    description:
      "Seus números de WhatsApp: por QR ou canal oficial da Meta, com saúde, reconexão e templates.",
    icon: "PlugsConnected",
    group: "canais",
    minRole: "admin",
    sidebar: true,
    healthDot: true,
  },
  {
    // O motor de disparo (Fase 5) tinha cron, banco e auditoria, e nenhuma tela: a fila só se
    // via por SQL. Fica em "Canais" porque é o que decide QUANDO e POR QUAL número a casa fala
    // primeiro com o lead — vizinho de Conexões, que cuida de QUAIS números existem.
    // `manager`: ritmo, chips e fila de prospecção são decisão de gestão, como o resto de "Canais"
    // (todo manager+/admin). A página redireciona abaixo disso e as cinco rotas cobram de novo.
    href: "/app/disparo",
    label: "Disparo",
    description: "A fila de mensagens, o ritmo e os chips do motor de disparo, e as conversas de quem respondeu.",
    icon: "PaperPlaneTilt",
    group: "canais",
    minRole: "manager",
    sidebar: true,
  },
  {
    // Não tinha link nenhum no app inteiro: só se chegava digitando a URL.
    href: "/app/integrations/nuvemshop",
    label: "Nuvemshop",
    description: "Conecte a loja para trazer pedidos e clientes para dentro do CRM.",
    icon: "Storefront",
    group: "canais",
    // A página não filtra por papel, mas as Server Actions de conectar e
    // desconectar exigem admin — mostrar a um viewer seria oferecer botão morto.
    minRole: "admin",
    // SEM `sidebar`: fora do menu lateral por decisão do dono do produto — a
    // integração não é usada nesta instalação e ocupava uma linha de "Canais"
    // toda vez que alguém abria o app.
    //
    // Continua sendo DESTINO, e é por isso que a linha some em vez do bloco
    // inteiro: `searchable()` (abaixo) filtra só por papel, então a tela segue
    // no ⌘K; a rota, a página e as Server Actions ficam intactas; e
    // `tests/unit/navegacao-completude.test.ts` continua vendo uma porta para
    // `/app/integrations/nuvemshop` — apagar a entrada exigiria justificá-la na
    // allowlist de "rota sem porta", que é coisa de rota morta, e esta não está.
    //
    // ⚠️ O grupo "canais" não tem hub, então o ⌘K passa a ser a ÚNICA porta
    // navegável. Para voltar a mostrá-la, basta devolver `sidebar: true`.
  },
  {
    href: "/app/webhooks",
    label: "Webhooks",
    description: "Avise outros sistemas quando algo acontecer aqui dentro.",
    icon: "WebhooksLogo",
    group: "canais",
    minRole: "manager",
    sidebar: true,
  },

  // ---- Análise — olhar o sistema funcionando ----
  //
  // ── QUEM FICA NO MENU, E POR QUÊ ─────────────────────────────────────────
  //
  // A régua é a FREQUÊNCIA de quem opera vendas por WhatsApp, não a importância
  // da tela. As três de cima entram na rotina — o dono abre Desempenho para
  // saber como vai o mês, Meta Ads para saber quanto custou trazer quem chegou,
  // e Atividades para saber se a equipe (e a IA) trabalhou no período. São
  // perguntas que se refazem toda semana, e um menu é para o que se refaz.
  //
  // As duas de baixo são visita DELIBERADA: "Evolução da IA" é revisão do
  // agente, coisa de quando se senta para ensiná-lo — e quem senta para isso já
  // vai ao grupo de IA; "Audit Log" é forense, aberto quando algo deu errado e
  // se precisa saber quem mexeu. Nenhuma das duas se abre de passagem, e é
  // justamente disso que o hub é feito: quem vai lá vai de propósito.
  //
  // Sair do menu não é sair do produto — o hub `/app/analise` é INVENTÁRIO e
  // lista as cinco (`hubSections`), então as duas continuam a um clique, com a
  // frase que explica para que servem. O ⌘K também as acha por nome.
  {
    href: "/app/metrics",
    label: "Desempenho",
    description: "Funil e performance por atendente nos últimos 30 dias.",
    icon: "ChartBar",
    group: "analise",
    section: "Os números do período",
    sidebar: true,
  },
  {
    // Logo abaixo de Desempenho porque responde a metade da MESMA pergunta: lá
    // está o que aconteceu depois que a pessoa chegou; aqui, quanto custou
    // trazê-la. Ler as duas juntas é o que fecha a conta do custo por cliente.
    href: "/app/ads/meta",
    label: "Meta Ads",
    description: "Quanto custou cada resultado das campanhas que trazem gente para cá.",
    icon: "Megaphone",
    group: "analise",
    section: "Os números do período",
    // `manager`, e não o `viewer` de Desempenho: aqui não há recorte por
    // pessoa — orçamento e criativo são da empresa inteira. Mesmo grau dos
    // outros dois vizinhos do grupo.
    minRole: "manager",
    // SAIU DO MENU (continua no hub `/app/analise` e no ⌘K) para dar o lugar a Faturamento, que virou o painel de vendas
    // do operador. Troca de um por um, entre telas do mesmo papel (`manager`): o menu de um gerente tem o MESMO número de
    // linhas de antes, então a folga medida pelo e2e de navegação (1280×900, sem rolar) não muda. Ninguém perde destino:
    // o hub lista as cinco telas do grupo com a frase que explica cada uma.
  },
  {
    // Irmã de "Desempenho", não a mesma coisa: lá é DESFECHO (funil agora,
    // ganho/perdido por atendente); aqui é o TRABALHO que aconteceu no
    // período, com quem fez cada coisa. Um mês inteiro atendido pela IA e um
    // mês inteiro atendido pela equipe têm o mesmo desfecho e histórias
    // opostas — só esta tela distingue as duas.
    href: "/app/activities",
    label: "Atividades",
    description:
      "Relatório do que a equipe e os agentes fizeram no período: quanto, quem e de que tipo.",
    icon: "ClockCounterClockwise",
    group: "analise",
    section: "Os números do período",
    sidebar: true,
  },
  {
    // O painel de vendas: quanto entrou, quantas vendas, ticket médio contra o período anterior, gráfico, produtos mais
    // vendidos, atendentes e a lista das vendas. É o que o operador abre todo dia depois de registrar uma venda, por isso
    // está no menu (`sidebar: true`). O menu de Análise já estava no limite de altura medido pelo e2e de navegação
    // (19px de folga, e cada linha custa 32px), então a vaga veio de Meta Ads, que desceu para o hub: mesmo papel
    // (`manager`), mesmo número de linhas, nenhum destino a menos.
    // `manager` pelo mesmo motivo de Meta Ads: faturamento é número da empresa inteira, sem recorte por atendente.
    href: "/app/faturamento",
    label: "Faturamento",
    description: "Quanto entrou no período: por dia, por produto e por funil, com o ticket médio.",
    icon: "Receipt",
    group: "analise",
    section: "Os números do período",
    minRole: "manager",
    sidebar: true,
  },
  {
    // Observabilidade, não configuração: por isso não fica junto dos agentes.
    href: "/app/ai/evolution",
    label: "Evolução da IA",
    description: "Se o agente está melhorando, onde ele erra e o que falta ensinar.",
    icon: "ChartLineUp",
    group: "analise",
    section: "O histórico que se consulta",
    minRole: "manager",
  },
  {
    href: "/app/audit",
    label: "Audit Log",
    description: "Quem fez o quê, quando — o histórico que não se apaga.",
    icon: "ClockCounterClockwise",
    group: "analise",
    section: "O histórico que se consulta",
    minRole: "manager",
  },

  // ---- Organização — conta, empresa, acesso ----
  {
    href: "/app/settings/profile",
    label: "Perfil",
    description: "Seu nome, idioma, fuso horário e avatar.",
    icon: "UserCircle",
    group: "organizacao",
    section: "Sua conta",
  },
  {
    href: "/app/settings/security",
    label: "Segurança",
    description: "Verificação em duas etapas, códigos de recuperação e sessões.",
    icon: "ShieldCheck",
    group: "organizacao",
    section: "Sua conta",
  },
  {
    href: "/app/settings/notifications",
    label: "Notificações",
    description: "Por onde e sobre o quê você quer ser avisado.",
    icon: "Bell",
    group: "organizacao",
    section: "Sua conta",
  },
  {
    // Configurações › Personalizar (migration 0261): a pessoa oculta e reordena os tópicos da PRÓPRIA barra; o admin
    // renomeia os tópicos e troca a marca da empresa (e isso vale para todos). Qualquer membro entra — o que cada bloco
    // da tela oferece é decidido por papel dentro dela e, de novo, no banco.
    //
    // Ocultar NÃO é permissão: a tela ocultada segue abrindo pelo link e pelo ⌘K. Fica em "Sua conta" porque o bloco
    // principal é pessoal. SEM `sidebar`, como as outras entradas de "organizacao": se chega por Configurações.
    href: "/app/settings/personalizar",
    label: "Personalizar",
    description: "Os tópicos da sua barra lateral e, para o admin, os nomes deles e a marca da empresa.",
    icon: "SlidersHorizontal",
    group: "organizacao",
    section: "Sua conta",
  },
  {
    href: "/app/team",
    label: "Equipe",
    description: "Quem trabalha aqui, com qual papel e quanta conversa cada um aguenta.",
    icon: "UsersThree",
    group: "organizacao",
    section: "Sua empresa",
  },
  {
    // OpenBot, Claude Code e Codex entram na equipe pelo MCP. Vizinha
    // de Equipe porque é equipe — o agente aparece na barra "Equipe agora" ao
    // lado das pessoas. `admin` pelo critério de API Tokens: criar um agente cria
    // uma chave de acesso ao CRM inteiro.
    href: "/app/team/agentes",
    label: "Agentes externos",
    description: "Agentes de IA de fora (OpenBot, Claude Code, Codex) trabalhando no CRM como membros da equipe.",
    icon: "Robot",
    group: "organizacao",
    section: "Sua empresa",
    minRole: "admin",
  },
  {
    // A porta que faltava (issue #144): rodízio de atendimento e restrição de
    // visibilidade existiam inteiros no backend e não tinham NENHUMA tela — só
    // dava para ligar com UPDATE à mão no banco.
    href: "/app/settings/atendimento",
    label: "Distribuição de atendimento",
    description: "Quem recebe cada cliente novo, e o que cada atendente enxerga.",
    icon: "UsersThree",
    group: "organizacao",
    section: "Sua empresa",
    minRole: "manager",
  },
  {
    href: "/app/settings/tenant",
    label: "Organização",
    description: "Dados da empresa, retenção de dados e encarregado de LGPD.",
    icon: "Buildings",
    group: "organizacao",
    section: "Sua empresa",
    minRole: "admin",
  },
  {
    // Mora em Organização e não em Canais de propósito: o que se configura aqui
    // é a CONTA DE ANÚNCIOS da empresa — dinheiro e identidade comercial, ao lado
    // de billing e API tokens. Canais é por onde se FALA com o cliente, e os dois
    // eixos são independentes (dá para receber lead de anúncio num número servido
    // por qualquer transporte). Ver `lib/plataformas-de-anuncio/types.ts`.
    href: "/app/settings/conversoes",
    label: "Conversões",
    description:
      "Devolver ao anúncio as vendas que ele trouxe, para ele aprender a procurar mais clientes parecidos.",
    icon: "ChartLineUp",
    group: "organizacao",
    section: "Sua empresa",
    // `admin` pelo mesmo critério das vizinhas: o token grava na conta de
    // anúncios da empresa, e quem o troca decide para onde vai o dinheiro de
    // mídia. Um `manager` ficaria acima de billing na mesma prancheta.
    minRole: "admin",
  },
  {
    // Vizinha de Conversões, e SEPARADA dela de propósito. As duas conectam "a
    // Meta" e a tentação de fundi-las é real — mas são credenciais de escopos
    // diferentes, em tabelas diferentes (0214), com consequências opostas
    // quando vencem: o token de leitura vencido deixa uma tela vazia, o de
    // conversões vencido faz a empresa parar de reportar vendas sem sintoma.
    // Uma tela só, com dois campos de token parecidos, é como se cola o token
    // errado no campo errado e se perde uma semana achando que quebrou.
    href: "/app/settings/meta-ads",
    label: "Meta Ads",
    description: "Conectar a conta de anúncios para ler o desempenho das campanhas.",
    icon: "Megaphone",
    group: "organizacao",
    section: "Sua empresa",
    // `admin` pelo mesmo critério da vizinha, mesmo o token sendo só de
    // leitura: ele expõe orçamento e performance da conta inteira, e quem
    // apenas LÊ a tela (`manager`) não precisa poder trocar a credencial.
    minRole: "admin",
  },
  {
    href: "/app/settings/marca",
    label: "Marca",
    description: "O nome e a cor que sua empresa mostra dentro do sistema.",
    icon: "Palette",
    group: "organizacao",
    section: "Sua empresa",
    // `admin` pelo mesmo motivo da linha de cima: o que se edita ali é
    // identidade da empresa, e dá-lo a `manager` o colocaria abaixo de billing e
    // de API tokens na mesma prancheta.
    minRole: "admin",
    // SEM `sidebar`: fica só no hub. Trocar a marca é tarefa de uma vez, e
    // agrupar o menu já o fez crescer — duas telas a mais estouraram a dobra em
    // 900px, medido pelo e2e `navegacao.spec.ts`.
  },
  {
    href: "/app/settings/billing",
    label: "Billing",
    description: "Plano e cobrança.",
    icon: "Receipt",
    group: "organizacao",
    section: "Sua empresa",
    minRole: "admin",
  },
  {
    href: "/app/lgpd/requests",
    label: "LGPD",
    description: "Pedidos de exportação e exclusão de dados feitos por clientes.",
    icon: "ScalesSimple",
    group: "organizacao",
    section: "Dados e acesso",
    minRole: "admin",
  },
  {
    href: "/app/settings/api-tokens",
    label: "API Tokens",
    description: "Chaves para outro sistema conversar com o seu CRM.",
    icon: "Lock",
    group: "organizacao",
    section: "Dados e acesso",
    minRole: "admin",
  },
] as const satisfies readonly NavMetadata[];

export type NavDestinationId = (typeof NAV_CATALOG)[number]["href"];

// ---------------------------------------------------------------------------
// A BARRA LATERAL (protótipo A aprovado pelo dono em 13/11/2026)
// ---------------------------------------------------------------------------

/** Os ícones que a barra usa — os do protótipo, em Phosphor regular (`lib/ui/icons`). */
export type IconeDaBarra =
  | "House"
  | "Inbox"
  | "Kanban"
  | "UserPlus"
  | "Users"
  | "CheckSquare"
  | "CalendarBlank"
  | "PaperPlaneTilt"
  | "Plugs"
  | "Lightning"
  | "Robot"
  | "ChartBar"
  | "Package"
  | "SlidersHorizontal";

/**
 * Uma linha da barra. Duas formas:
 *
 * - `destino`: a linha É o link para `href`. Com `subpaginas` (e/ou `hubDoGrupo`),
 *   ganha uma seta ao lado que abre o submenu — o clique no nome continua levando
 *   direto à tela que se usa todo dia.
 * - `grupo`: a linha abre o submenu com TODAS as telas do grupo do catálogo
 *   (inventário, como o hub), começando pela visão geral do grupo (o hub).
 */
export type EntradaDaBarra =
  | {
      tipo: "destino";
      href: NavDestinationId;
      icone: IconeDaBarra;
      subpaginas?: readonly NavDestinationId[];
      /** O hub deste grupo entra no fim do submenu ("Ver tudo em …"). */
      hubDoGrupo?: NavGroupId;
    }
  | {
      tipo: "grupo";
      grupo: NavGroupId;
      rotulo: string;
      icone: IconeDaBarra;
    };

export interface SecaoDaBarra {
  id: "principal" | "prospeccao" | "gestao";
  /** `null` = bloco sem título (o primeiro, do dia a dia). */
  titulo: string | null;
  entradas: readonly EntradaDaBarra[];
}

/**
 * A ordem e os blocos da barra — os textos e a ordem são os do protótipo A.
 *
 * Os GRUPOS do catálogo (`NAV_GROUPS`) continuam sendo a organização por
 * objetivo que os hubs, o ⌘K e o editor de interface usam; a barra é uma
 * PROJEÇÃO deles com outra ordem. Nenhum destino sumiu: o que não tem linha
 * própria está num submenu, e a única exceção (`FORA_DA_BARRA`) é escrita com o
 * motivo. Vigiado por `components/app/BarraLateral.test.tsx`.
 */
export const BARRA_LATERAL: readonly SecaoDaBarra[] = [
  {
    id: "principal",
    titulo: null,
    entradas: [
      { tipo: "destino", href: "/app/inicio", icone: "House" },
      // Radar é o "quem esfriou e ainda está aberto": é do atendimento, e mora no submenu do Inbox.
      { tipo: "destino", href: "/app/inbox", icone: "Inbox", subpaginas: ["/app/radar"] },
      {
        tipo: "destino",
        href: "/app/kanban",
        icone: "Kanban",
        subpaginas: ["/app/settings/tenant/pipelines"],
        hubDoGrupo: "crm",
      },
      { tipo: "destino", href: "/app/leads", icone: "UserPlus" },
      { tipo: "destino", href: "/app/contacts", icone: "Users" },
      { tipo: "destino", href: "/app/tasks", icone: "CheckSquare" },
      { tipo: "destino", href: "/app/agenda", icone: "CalendarBlank" },
    ],
  },
  {
    id: "prospeccao",
    titulo: "Prospecção",
    entradas: [
      { tipo: "destino", href: "/app/disparo", icone: "PaperPlaneTilt" },
      { tipo: "destino", href: "/app/connections", icone: "Plugs", subpaginas: ["/app/webhooks"] },
      { tipo: "destino", href: "/app/templates", icone: "Lightning" },
    ],
  },
  {
    id: "gestao",
    titulo: "Gestão",
    entradas: [
      { tipo: "grupo", grupo: "ia", rotulo: "Agente de IA", icone: "Robot" },
      { tipo: "grupo", grupo: "analise", rotulo: "Análise", icone: "ChartBar" },
      { tipo: "destino", href: "/app/products", icone: "Package" },
      { tipo: "grupo", grupo: "organizacao", rotulo: "Configurações", icone: "SlidersHorizontal" },
    ],
  },
];

/**
 * Destinos que NÃO têm linha na barra, com o porquê. Continuam no ⌘K
 * (`searchable()` filtra só por papel e pela interface).
 *
 * É só isto: "sem linha". Tirar uma tela do submenu de um GRUPO é outra decisão,
 * com lista própria (`FORA_DO_SUBMENU`).
 */
export const FORA_DA_BARRA: Readonly<Partial<Record<NavDestinationId, string>>> = {
  "/app/settings/personalizar":
    "a porta é o botão Personalizar, na linha do usuário (modo personalização, 16/11/2026), e o 'Mais opções' dele; segue no hub de Configurações e no ⌘K",
  "/app/integrations/nuvemshop":
    "fora do menu por decisão do dono do produto (a integração não é usada); segue no ⌘K — ver o comentário da entrada no catálogo",
};

/**
 * Destinos que o submenu de um GRUPO da barra não lista (`barraParaPersonalizar`),
 * com o porquê. O hub do grupo (ex.: Configurações) e o ⌘K seguem listando todos.
 *
 * Lista PRÓPRIA, separada de `FORA_DA_BARRA`, de propósito: aquela diz "esta tela não
 * tem linha na barra"; esta diz "esta tela sai do submenu do grupo dela". Misturar as
 * duas fazia a próxima entrada de `FORA_DA_BARRA` sumir de um submenu sem ninguém querer
 * (achado 12 da revisão de 16/11/2026). Toda entrada daqui também consta em
 * `FORA_DA_BARRA` (não tem porta própria na barra) — vigiado em
 * `components/app/BarraLateral.test.tsx`.
 */
export const FORA_DO_SUBMENU: Readonly<Partial<Record<NavDestinationId, string>>> = {
  "/app/settings/personalizar":
    "a porta é o botão Personalizar, na linha do usuário (modo personalização, 16/11/2026), e o 'Mais opções' dele; segue no hub de Configurações e no ⌘K",
};
