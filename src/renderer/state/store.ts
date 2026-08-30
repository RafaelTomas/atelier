/**
 * Store mínima com useSyncExternalStore.
 *
 * Guarda só o que muda POR EVENTO (nós, conexões, seleção). Pan, zoom e a
 * posição durante o arrasto NÃO passam por aqui — ver canvas/viewport.ts.
 * Essa separação é a regra 5 de docs/migracao-electron.md: se o estado de
 * pan/zoom entrar no React, a árvore re-renderiza a cada mousemove e os
 * terminais entram em tempestade de refresh.
 */
import { useSyncExternalStore } from 'react'
import type {
  AgentRole,
  AgentStatus,
  AgentUsage,
  ButtonConfig,
  CanvasNode,
  ClaudeAccountInfo,
  CodexAccountUsage,
  Connection,
  DiscoveredProject,
  Drawing,
  NodeGroup,
  Placement as PillPlacement,
  Preferences,
  Project,
  Rect,
  StoredAccountUsage,
  TerminalDraft,
  UUID,
  WorkspaceEntry,
  WorkspacePayload
} from '@shared/types'
import type { RemovedNodeSnapshot } from '@shared/node-undo'
import { UNDO_WINDOW_MS, captureRemoval } from '@shared/node-undo'
import {
  DEFAULT_CLAUDE_ACCOUNT_ID,
  DOCK_PLACEMENT_DEFAULT,
  MONITOR_PLACEMENT_DEFAULT,
  RAIL_PLACEMENT_DEFAULT,
  formatPlacement,
  parsePlacement,
  readButtonConfig,
  writeButtonConfig
} from '@shared/types'
import { normalizeURL } from '@shared/portal-url'
import { viewport } from '../canvas/viewport'
import { boundsForNodes, groupOf } from '../canvas/group-geometry'
import { DESCRIBE_PROJECTS_ENABLED } from '../feature-flags'
import { quoteForShell } from '../paths'
import { PDF_NODE_SIZE, isPdf } from '../pdf-viewer'
import { applyTheme, isThemeMode, type ThemeMode } from '../theme'
import type { PillId } from '../floating/use-pill'

/**
 * Qual chave de `preferences.json` guarda cada pílula.
 *
 * Um mapa, e não o ternário que servia a duas: com três pílulas um ternário
 * aninhado deixa de ser legível, e — pior — o compilador para de reclamar
 * quando um `PillId` novo não tem chave, porque o ramo final vira o pega-tudo.
 * O `Record` obriga a decidir.
 *
 * A importação de `PillId` é SÓ DE TIPO: em runtime o hook importa a store, e
 * um import de valor fecharia o ciclo.
 */
const PILL_PREF_KEY: Record<PillId, 'dockPlacement' | 'railPlacement' | 'monitorPlacement'> = {
  dock: 'dockPlacement',
  rail: 'railPlacement',
  monitor: 'monitorPlacement'
}

/**
 * Ferramenta ativa do canvas. 'select' é o comportamento de sempre (arrastar
 * nó, marquee, pan); as outras capturam o arrasto para desenhar/apagar.
 *
 * 'pan' é a mão travada: o mesmo que segurar espaço, mas sem segurar nada. O
 * botão da dock alterna entre ele e 'select', e o arrasto em área vazia move o
 * quadro em vez de abrir o marquee.
 *
 * 'draw' é o MODO desenho da dock: não desenha sozinho — o clique no canvas
 * abre o menu que escolhe o que fazer naquele ponto (ver DrawMenu). É esse
 * passo intermediário que separa 'draw' de 'pen'/'highlighter'/'eraser', que
 * já são a ferramenta concreta e agem direto no arrasto.
 */
export type Tool = 'select' | 'pan' | 'draw' | 'pen' | 'highlighter' | 'eraser'

/**
 * Item aberto na rail esquerda. Workspaces não está aqui: ele subiu para o
 * chip do canto superior esquerdo (ver workspace-chip.tsx).
 */
export type RailTab = 'projetos' | 'arquivos' | 'git'

/**
 * Pedido de "abra a cascata em tal item".
 *
 * A rail é dona da própria navegação — qual item está aberto é `useState` dela,
 * não estado global. Mas OUTRAS partes precisam mandá-la abrir: o menu de
 * contexto de um projeto tem "Ver arquivos", e o vazio do painel de arquivos
 * manda de volta para Projetos. Isso é uma INTENÇÃO, não um estado: chega,
 * é consumida e some. Daí o campo efêmero, que a rail zera ao atender.
 *
 * `nonce` existe porque pedir duas vezes o MESMO item é um pedido legítimo (a
 * cascata pode ter sido fechada no meio) e um objeto igual não dispararia o
 * efeito de novo.
 */
export interface RailRequest {
  tab: RailTab
  /** Projeto a selecionar junto. null = mantém o que já estava. */
  projectId: UUID | null
  nonce: number
}

/** Ferramentas que o menu de desenho oferece — subconjunto acionável de Tool. */
export type DrawTool = Extract<Tool, 'pen' | 'highlighter' | 'eraser'>

export interface PenSettings {
  color: string
  lineWidth: number
}

/**
 * Intenção de criar um componente, pendurada até o usuário desenhar a área.
 *
 * O `finish` vem de quem pediu (a dock): assim o canvas só cuida do gesto, e
 * cada item continua dono da própria receita de criação — inclusive as que
 * abrem diálogo depois da área, como Terminal e Documento PDF.
 */
export interface Placement {
  /** Aparece na dica: "arraste para definir a área do terminal". */
  label: string
  /** Tamanho usado quando o gesto é um clique, sem arrasto. */
  defaultSize: [number, number]
  /** Piso do tipo: área menor que isto é elevada antes de virar nó. */
  minSize: [number, number]
  finish: (frame: Rect) => void
}

export interface AppSnapshot {
  entries: WorkspaceEntry[]
  activeId: UUID | null
  workspace: WorkspacePayload | null
  selection: UUID[]
  /**
   * Moldura de grupo selecionada. Fora de `selection`, e não dentro dela: um
   * array com ids de dois tipos obrigaria toda leitura ("o que está
   * selecionado?") a desambiguar antes de responder. Os dois são exclusivos —
   * escolher um limpa o outro.
   */
  selectedGroupId: UUID | null
  /**
   * Traço de desenho selecionado — exclusivo com `selection` e
   * `selectedGroupId` pelo mesmo motivo: um nó/grupo/traço por vez.
   */
  selectedDrawingId: UUID | null
  /**
   * Grupo em foco: ele fica opaco e o resto do canvas apaga. Só em memória, não
   * vai para o disco — é modo de leitura, não propriedade do grupo. `Esc` sai.
   */
  isolatedGroupId: UUID | null
  /** Nó de origem enquanto o usuário arrasta uma conexão nova. */
  connectingFrom: UUID | null
  /** Componente esperando o usuário desenhar a área onde vai nascer. */
  placing: Placement | null
  /** Pedido pendente de abrir a cascata da rail. A rail consome e zera. */
  railRequest: RailRequest | null
  /** Tema escolhido — espelha preferences.theme. */
  theme: ThemeMode
  /** Ferramenta ativa (caneta, marca-texto, borracha ou seleção). */
  tool: Tool
  pen: PenSettings
  /** Responsabilidades disponíveis (globais + as deste workspace). */
  roles: AgentRole[]
  /** Contas do Claude, com a padrão (~/.claude) sempre na primeira posição. */
  claudeAccounts: ClaudeAccountInfo[]
  /**
   * A última leitura de limite (5h/7d) de cada conta, vinda do disco.
   *
   * É o FUNDO do bloco de perfis, não a leitura corrente: quando há terminal
   * aberto naquela conta, quem vale é o `terminalUsage` dele, que é de agora
   * (ver `groupByAccount`). Isto responde pelas contas que estão paradas — sem
   * ele, a conta sem terminal aberto apareceria vazia, que é justamente a conta
   * sobre a qual o usuário está decidindo.
   *
   * Só é relido no boot e no botão de recarregar do painel: o ledger em disco
   * muda quando um agente publica, e nesse instante a leitura viva dele já está
   * na store por outro caminho.
   */
  claudeAccountUsage: StoredAccountUsage[]
  codexAccountUsage: CodexAccountUsage
  /** Diálogo "Novo Terminal" aberto — a dock dispara, o App renderiza. */
  newTerminalOpen: boolean
  /** Área desenhada antes do diálogo abrir — o terminal nasce nela. */
  newTerminalFrame: Rect | null
  /** Terminal aberto no diálogo em modo edição. null = ninguém editando. */
  editTerminalId: UUID | null
  /**
   * Diálogo de botão aberto. `nodeId` null = criando um novo, e aí `frame` é a
   * área desenhada no canvas. Mesmo compasso do diálogo de terminal: nada é
   * criado enquanto o usuário não confirma.
   */
  buttonDialog: { nodeId: UUID | null; frame: Rect | null } | null
  /**
   * Como cada botão foi na última vez que o usuário clicou nele.
   *
   * FORA do `view` do widget, de propósito: `view` é snapshot persistido, e
   * gravar isto ali sujaria o autosave a cada clique com dado descartável.
   * Descreve a ENTREGA da ação (o comando chegou ao terminal), não o resultado
   * dele — quem mostra saída, erro e código de saída é o PTY, que é a única
   * superfície honesta para isso.
   */
  buttonRuns: Record<UUID, 'running' | 'failed'>
  /**
   * Geração de cada terminal. Recarregar incrementa: o TerminalNode tem isso
   * nas deps do efeito, então o xterm é derrubado e o PTY sobe de novo.
   */
  terminalEpoch: Record<UUID, number>
  /** Linha de status lida da tela de cada agente — o que o rodapé do nó mostra. */
  terminalStatus: Record<UUID, AgentStatus>
  /**
   * A leitura que o próprio agente PUBLICA (statusLine do Claude Code): modelo,
   * contexto com o tamanho da janela, custo em dólares e os limites com hora de
   * reset. Separado do `terminalStatus` de propósito — são fontes distintas, e
   * o painel mostra de qual delas o número veio (ver shared/agent-usage.ts).
   *
   * Como o status raspado, é estado de SESSÃO: nunca vai para o workspace.
   */
  terminalUsage: Record<UUID, AgentUsage>
  /**
   * Diretório com que o próximo "Novo Terminal" nasce. É assim que um projeto
   * passa o cwd para o agente: no momento da criação, não por cabo — o formato
   * em disco não tem array de conexão para o par projeto↔terminal.
   */
  newTerminalCwd: string | null
  /** Índice de projetos (global, não pertence ao workspace). */
  projects: Project[]
  projectQuery: string
  /**
   * Projeto escolhido no painel — é dele que a coluna Arquivos mostra a árvore.
   * FONTE ÚNICA de "em que projeto estou": a cascata da rail, o menu do Git e
   * os widgets não fixados leem daqui, e nenhum deles mantém cópia própria.
   * Guarda o id, não o objeto: assim um re-scan que atualize o projeto não
   * deixa a coluna olhando para uma cópia velha.
   */
  selectedProjectId: UUID | null
  /**
   * Há varredura em andamento. O PROGRESSO não entra aqui: a ~7Hz ele
   * re-renderizaria o canvas inteiro a cada evento. O painel assina
   * onScanProgress localmente.
   */
  scanning: boolean
  scanDialogOpen: boolean
  /** Projetos que a varredura do boot achou e que aguardam resposta do usuário. */
  candidates: DiscoveredProject[]
  /**
   * Ao fim da varredura, sobe o agente que descreve os projetos. Hoje sempre
   * false — ver DESCRIBE_PROJECTS_ENABLED em renderer/feature-flags.ts.
   */
  autoDescribe: boolean
  /** Espelho de preferences.json — hoje lido para os temas de terminal. */
  prefs: Preferences | null
  /** Aviso passageiro na barra — some sozinho. */
  notice: Notice | null
  /**
   * Integridade do arquivo do workspace aberto. `safeMode` significa que o
   * decoder descartou nós que não entendeu: o autosave está desligado e salvar
   * apagaria esses nós. null = ainda não consultado.
   */
  integrity: { safeMode: boolean; droppedNodes: number; fileSchemaVersion: number } | null
  /** Nó de editor com alteração pendente, esperando resposta antes de fechar. */
  closingEditor: UUID | null
  /**
   * Onde ficam a dock e a rail. DERIVADO de `prefs`, e guardado aqui já
   * parseado porque as duas pílulas o leem a cada render — reparsear a string
   * em cada um seria trabalho repetido por um valor que muda uma vez por gesto.
   *
   * Um valor inválido no disco (um save do app nativo, que não conhece estas
   * chaves, as apaga) cai no padrão dentro de `parsePlacement`: nenhum estado
   * gravado pode esconder a dock.
   */
  dockPlacement: PillPlacement
  railPlacement: PillPlacement
  monitorPlacement: PillPlacement
  /**
   * A tira do monitor está na borda? DERIVADO de `prefs`, como as posições.
   *
   * Ela é a única pílula que se desliga, porque é a única que custa: assina o
   * amostrador enquanto existe. O padrão é `true` em todos os caminhos —
   * ausente, apagada pelo app nativo ou com lixo dentro —, senão um estado
   * gravado esconderia a peça sem deixar como trazê-la de volta.
   */
  monitorDockVisible: boolean
  /**
   * Plataforma, vinda do bootInfo. O renderer não tem `process`, e quem cola um
   * caminho no terminal precisa saber com que aspas o shell de lá se entende.
   */
  platform: string
  loading: boolean
  bootError: string | null
}

/**
 * O aviso da barra, com uma ação OPCIONAL.
 *
 * O aviso nasceu só com texto, para dar destino a uma falha de IPC que o
 * renderer engoliria. A ação entrou com o desfazer: "apaguei sem querer" é um
 * arrependimento de um segundo, e mandar a pessoa caçar um atalho enquanto o
 * aviso do que ela fez está na tela é perder o único momento em que a correção
 * é óbvia. O botão é o mesmo gesto do ⌘Z, no lugar em que o olho já está.
 */
export interface Notice {
  text: string
  action?: { label: string; run: () => void }
}

/** "1 nó apagado" / "4 nós apagados" — o aviso diz o tamanho do estrago. */
function noticeForRemoval(snapshots: RemovedNodeSnapshot[]): string {
  return snapshots.length === 1 ? 'nó apagado' : `${snapshots.length} nós apagados`
}

const initial: AppSnapshot = {
  entries: [],
  activeId: null,
  workspace: null,
  selection: [],
  selectedGroupId: null,
  selectedDrawingId: null,
  isolatedGroupId: null,
  connectingFrom: null,
  placing: null,
  railRequest: null,
  theme: 'system',
  tool: 'select',
  pen: { color: '#e0245e', lineWidth: 3 },
  roles: [],
  claudeAccounts: [],
  claudeAccountUsage: [],
  codexAccountUsage: {
    authMode: null,
    planType: null,
    limits: [],
    credits: null,
    individualLimit: null,
    spendControlReached: null,
    rateLimitReachedType: null,
    resetCreditsAvailable: null,
    tokenUsage: null,
    at: '',
    source: 'none'
  },
  newTerminalOpen: false,
  newTerminalFrame: null,
  editTerminalId: null,
  buttonDialog: null,
  buttonRuns: {},
  terminalEpoch: {},
  terminalStatus: {},
  terminalUsage: {},
  newTerminalCwd: null,
  projects: [],
  projectQuery: '',
  selectedProjectId: null,
  scanning: false,
  scanDialogOpen: false,
  candidates: [],
  autoDescribe: DESCRIBE_PROJECTS_ENABLED,
  prefs: null,
  notice: null,
  integrity: null,
  closingEditor: null,
  dockPlacement: DOCK_PLACEMENT_DEFAULT,
  railPlacement: RAIL_PLACEMENT_DEFAULT,
  monitorPlacement: MONITOR_PLACEMENT_DEFAULT,
  monitorDockVisible: true,
  platform: 'linux',
  loading: true,
  bootError: null
}

/** O que o undo/redo grava e restaura — o resto do payload (nome, viewport,
 * datas) não é "conteúdo editável" e fica de fora de propósito. */
type HistorySnapshot = Pick<WorkspacePayload, 'nodes' | 'connections' | 'groups' | 'drawings'>

/**
 * O que morreu num delete, e quando.
 *
 * Um retrato do grafo bastaria para redesenhar a tela, mas não para devolver o
 * NÓ: os arquivos que vivem por nodeId (scrollback, `.session.json`, o `.md` da
 * nota, os bytes da imagem) são do processo principal, e só ele sabe cancelar a
 * exclusão que já estava marcada. Por isso a entrada de um delete carrega, além
 * do retrato, o que `node:restore` precisa receber.
 */
interface RemovalMark {
  snapshots: RemovedNodeSnapshot[]
  /** Quando o delete aconteceu — a janela de `UNDO_WINDOW_MS` conta daqui. */
  at: number
}

/**
 * Um passo do histórico: o grafo ANTES da edição e, se a edição foi um delete,
 * o que ele levou junto.
 *
 * Uma pilha só, e não duas. Antes havia o Ctrl+Z genérico (retratos do grafo) e
 * um desfazer só do delete (snapshots + restore pelo main) vivendo lado a lado,
 * e o preço era alto: o mesmo Ctrl+Z disparava os dois, o genérico ressuscitava
 * um nó de imagem sem avisar o main (que apagava os bytes assim que a janela
 * fechava, deixando a moldura vazia), e nenhum dos dois sabia da existência do
 * outro para se manter em ordem. `removal` é o que faltava para o histórico
 * único conseguir tratar o delete sem deixar de ser um histórico só.
 */
interface HistoryEntry {
  snapshot: HistorySnapshot
  removal: RemovalMark | null
}

/** Além disso o app não guarda mais passos — histórico não é o arquivo. */
const MAX_HISTORY = 100

class Store {
  private state: AppSnapshot = initial
  private listeners = new Set<() => void>()
  private noticeTimer: ReturnType<typeof setTimeout> | null = null
  /** Esta varredura pediu descrição automática? Ver startScan/finishScan. */
  private armedAutoDescribe = false

  /**
   * Pilhas do Ctrl+Z/Ctrl+Shift+Z — uma por workspace aberto, zeradas ao trocar.
   *
   * Em MEMÓRIA, fora do snapshot do React e fora do `workspace.json`: nada na
   * tela depende delas a não ser o aviso, que já é estado, e um histórico
   * persistido seria um campo que o app nativo Swift descartaria no primeiro
   * save — além de ressuscitar, na sessão seguinte, um nó que ⌘Z não prometeu.
   */
  private past: HistoryEntry[] = []
  private future: HistoryEntry[] = []

  getSnapshot = (): AppSnapshot => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private set(patch: Partial<AppSnapshot>): void {
    this.state = { ...this.state, ...patch }
    for (const l of this.listeners) l()
  }

  // ─── Boot ───────────────────────────────────────────────────────────────────

  async load(): Promise<void> {
    try {
      const [{ entries, activeId }, prefs, roles, claudeAccounts, claudeAccountUsage, projects] =
        await Promise.all([
          window.atelier.workspace.list(),
          window.atelier.prefs.get(),
          window.atelier.role.list(),
          // As contas entram no boot pelo mesmo motivo das responsabilidades: o
          // nó de terminal mostra em qual conta está antes de qualquer diálogo
          // abrir, e o seletor da barra de ações não pode piscar vazio.
          window.atelier.claudeAccount.list(),
          // E o quanto cada uma já consumiu na janela corrente. Vem do disco: a
          // leitura é da conta, não da sessão, e sobrevive ao app fechado até a
          // hora do reset dela.
          window.atelier.claudeAccount.usage(),
          // O índice entra no BOOT, e não só quando o painel de projetos monta.
          // Um widget de git fixado num projeto precisa resolver esse id para
          // saber de que repositório ele é — e ele pode estar na tela sem que a
          // cascata da rail tenha sido aberta uma única vez. Enquanto o índice
          // dependia da montagem do painel, o widget reabria dizendo "nenhum
          // projeto selecionado" para um projeto que estava lá.
          window.atelier.project.list()
        ])
      const id = activeId ?? entries[0]?.id ?? null
      const workspace = id ? await window.atelier.workspace.open(id) : null
      const integrity = id ? await window.atelier.workspace.integrity(id) : null
      const theme = isThemeMode(prefs.theme) ? prefs.theme : 'system'
      applyTheme(theme)
      this.resetHistory()
      this.set({
        entries,
        activeId: id,
        workspace,
        integrity,
        roles,
        claudeAccounts,
        claudeAccountUsage,
        prefs,
        projects,
        theme,
        // A posição das pílulas é derivada de `prefs`, e sai da string uma vez
        // aqui em vez de a cada render das duas peças.
        dockPlacement: parsePlacement(prefs.dockPlacement, DOCK_PLACEMENT_DEFAULT),
        railPlacement: parsePlacement(prefs.railPlacement, RAIL_PLACEMENT_DEFAULT),
        monitorPlacement: parsePlacement(prefs.monitorPlacement, MONITOR_PLACEMENT_DEFAULT),
        // `!== false` e não `Boolean(...)`: a chave ausente (versão anterior,
        // ou save do app nativo) tem de deixar a tira VISÍVEL.
        monitorDockVisible: prefs.monitorDockVisible !== false,
        loading: false
      })
    } catch (err) {
      this.set({ loading: false, bootError: (err as Error).message })
    }
  }

  async openWorkspace(id: UUID): Promise<void> {
    const workspace = await window.atelier.workspace.open(id)
    const integrity = await window.atelier.workspace.integrity(id)
    this.resetHistory()
    this.set({
      workspace,
      integrity,
      activeId: id,
      selection: [],
      selectedGroupId: null,
      selectedDrawingId: null,
      isolatedGroupId: null
    })
  }

  /**
   * O botão Salvar da barra. É a ÚNICA porta que grava um workspace em modo
   * seguro — por isso ele reconsulta a integridade depois: uma vez gravado, o
   * arquivo já não tem o que não era entendido, e a faixa some.
   */
  async saveNow(): Promise<void> {
    await window.atelier.workspace.saveNow()
    const id = this.state.activeId
    if (id) this.set({ integrity: await window.atelier.workspace.integrity(id) })
  }

  async createWorkspace(name: string): Promise<void> {
    const { entries, workspace } = await window.atelier.workspace.create(name, '')
    this.resetHistory()
    this.set({ entries, workspace, activeId: workspace.id, selection: [] })
  }

  async renameWorkspace(id: UUID, name: string): Promise<void> {
    const trimmed = name.trim()
    if (!trimmed) return
    const entries = await window.atelier.workspace.rename(id, trimmed)
    // O payload aberto também guarda o nome — é ele que alimenta o chip do canvas.
    const ws = this.state.workspace
    this.set({
      entries,
      workspace: ws && ws.id === id ? { ...ws, name: trimmed } : ws
    })
  }

  /**
   * Apaga o workspace E O DIRETÓRIO DELE em disco — notas `.md` e anexos
   * junto. Sem lixeira, sem desfazer: quem chama já confirmou com o usuário.
   *
   * Excluir o ATIVO deixa o app sem workspace aberto, e não abre outro no
   * lugar. O main escolhe um de reserva para o próximo boot, mas herdar essa
   * escolha aqui abriria, sem pedir, um workspace que o usuário não pediu — e
   * a diferença entre "fechou" e "trocou sozinho" só apareceria depois de uma
   * edição no canvas errado.
   */
  async deleteWorkspace(id: UUID): Promise<void> {
    const entries = await window.atelier.workspace.remove(id)
    if (id === this.state.activeId) {
      this.resetHistory()
      this.set({
        entries,
        workspace: null,
        activeId: null,
        selection: [],
        selectedGroupId: null,
        selectedDrawingId: null,
        isolatedGroupId: null,
        integrity: null
      })
      return
    }
    this.set({ entries })
  }

  // ─── Nós ────────────────────────────────────────────────────────────────────

  get workspaceId(): UUID | null {
    return this.state.workspace?.id ?? null
  }

  /**
   * `history: true` marca uma edição de verdade (o usuário escolheria desfazer
   * isto) — empilha o retrato de ANTES no undo. As demais (status de conexão
   * piscando, z-index de "trouxe pra frente") deixam o padrão `false`: entram
   * no Ctrl+Z e o usuário nunca pediu para desfazer aquilo.
   *
   * `removal` só vem do delete, e é o que distingue aquele passo dos outros na
   * hora de desfazer — ver `HistoryEntry`.
   */
  private mutateWorkspace(
    fn: (ws: WorkspacePayload) => void,
    opts: { history?: boolean; removal?: RemovalMark } = {}
  ): void {
    const ws = this.state.workspace
    if (!ws) return
    if (opts.history) this.pushHistory(ws, opts.removal ?? null)
    const next = {
      ...ws,
      nodes: [...ws.nodes],
      connections: [...ws.connections],
      drawings: [...ws.drawings],
      groups: [...ws.groups]
    }
    fn(next)
    this.set({ workspace: next })
  }

  /** Retrato independente (não por referência) do que o Ctrl+Z restaura. */
  private snapshotOf(ws: WorkspacePayload): HistorySnapshot {
    return structuredClone({
      nodes: ws.nodes,
      connections: ws.connections,
      groups: ws.groups,
      drawings: ws.drawings
    })
  }

  private pushSnapshot(entry: HistoryEntry): void {
    this.past.push(entry)
    if (this.past.length > MAX_HISTORY) this.past.shift()
    this.future = []
  }

  private pushHistory(ws: WorkspacePayload, removal: RemovalMark | null = null): void {
    this.pushSnapshot({ snapshot: this.snapshotOf(ws), removal })
  }

  /**
   * O delete de uma imagem tem prazo — os outros não.
   *
   * Passada a janela, o main já apagou os bytes (ver
   * core/persistence/pending-image-delete.ts) e o nó que voltasse voltaria
   * vazio: a moldura certa, no lugar certo, sem imagem. Nó de texto, terminal,
   * nota ou tabela não tem esse prazo — os arquivos deles ficam no disco, e
   * desfazer meia hora depois devolve o nó inteiro.
   */
  private expired(removal: RemovalMark): boolean {
    if (Date.now() - removal.at <= UNDO_WINDOW_MS) return false
    return removal.snapshots.some((s) => s.node.content.type === 'image')
  }

  private resetHistory(): void {
    this.past = []
    this.future = []
  }

  get canUndo(): boolean {
    return this.past.length > 0
  }

  get canRedo(): boolean {
    const top = this.future[this.future.length - 1]
    return top !== undefined && top.removal === null
  }

  /**
   * Desfaz o último passo — inclusive quando esse passo foi um delete.
   *
   * O delete não volta só pelo retrato. Ele passa ANTES por `node:restore`,
   * que é quem cancela a exclusão dos bytes da imagem e recoloca o nó com o
   * MESMO id, para os arquivos por nodeId não ficarem órfãos ao lado de um nó
   * vazio. O retrato vem depois e alinha o resto do grafo (desenhos, e o que
   * mais tenha mudado no mesmo passo) — as duas chamadas descrevem o mesmo
   * estado final, então a ordem entre elas é a única coisa que importa.
   */
  async undo(): Promise<void> {
    const ws = this.state.workspace
    const entry = this.past[this.past.length - 1]
    if (!ws || !entry) return

    // Fora da janela, o retrato ANTERIOR a este também aponta para bytes que já
    // saíram do disco — desfazer mais fundo devolveria outra moldura vazia. O
    // histórico inteiro cai junto, e dizer isso é melhor que restaurar um nó
    // que mente sobre o próprio conteúdo.
    if (entry.removal && this.expired(entry.removal)) {
      this.past = []
      this.future = []
      this.showNotice('a imagem apagada já saiu do disco — não dá para desfazer')
      return
    }

    this.past.pop()
    this.future.push({ snapshot: this.snapshotOf(ws), removal: entry.removal })
    if (entry.removal) await window.atelier.node.restore(ws.id, entry.removal.snapshots)
    await window.atelier.workspace.restore(ws.id, entry.snapshot)
    this.set({ workspace: { ...ws, ...entry.snapshot } })
    // Selecionar o que voltou responde "onde ele foi parar" sem procurar. O
    // terminal volta PARADO: o `.session.json` sobreviveu à remoção, então quem
    // quiser a conversa de volta liga o nó e o boot retoma pelo id gravado.
    if (entry.removal) {
      this.set({ selection: entry.removal.snapshots.map((s) => s.node.id) })
      this.dismissNotice()
    }
  }

  /**
   * Refaz — mas PARA no delete, em vez de atravessá-lo.
   *
   * Refazer uma remoção é apagar de novo, e um gesto destrutivo atrás do
   * atalho que a pessoa usa justamente para corrigir engano é caro demais. O
   * passo fica onde está: quem quiser mesmo apagar aperta Delete, que é
   * explícito e deixa o próprio desfazer para trás.
   */
  async redo(): Promise<void> {
    const ws = this.state.workspace
    const entry = this.future[this.future.length - 1]
    if (!ws || !entry) return
    if (entry.removal) {
      this.showNotice('refazer não apaga de novo')
      return
    }
    this.future.pop()
    this.past.push({ snapshot: this.snapshotOf(ws), removal: null })
    await window.atelier.workspace.restore(ws.id, entry.snapshot)
    this.set({ workspace: { ...ws, ...entry.snapshot } })
  }

  async addNode(
    kind:
      | 'terminal'
      | 'note'
      | 'text'
      | 'portal'
      | 'fileTree'
      | 'codeEditor'
      | 'dataTable'
      | 'image'
      | 'widget'
      | 'secretVault',
    position: { x: number; y: number },
    opts: Record<string, unknown> = {},
    size?: { width: number; height: number }
  ): Promise<CanvasNode | null> {
    const id = this.workspaceId
    if (!id) return null
    const created = await window.atelier.node.add(id, kind, position, opts, size)
    if (!created) return null

    // O renderer é quem manda no tamanho: ele já aplicou o piso do tipo antes
    // de pedir. Se o nó voltou com outra medida, a ponte não entendeu o pedido
    // (é o que acontece com um preload velho, em dev sem reiniciar) — corrige
    // em vez de deixar o usuário com um nó do tamanho errado.
    let node = created
    if (size && (created.frame.width !== size.width || created.frame.height !== size.height)) {
      const frame = { ...created.frame, width: size.width, height: size.height }
      await window.atelier.node.setFrame(id, created.id, frame)
      node = { ...created, frame }
    }

    this.mutateWorkspace((ws) => ws.nodes.push(node), { history: true })
    this.set({ selection: [node.id] })
    return node
  }

  removeNode(nodeId: UUID, opts?: { force?: boolean }): Promise<void> {
    return this.removeNodes([nodeId], opts)
  }

  /**
   * Apaga N nós COMO UM GESTO SÓ — é o que a tecla Delete faz com uma seleção.
   *
   * O laço de fora (um `removeNode` por id) foi para dentro por causa do undo:
   * apagar cinco nós e ter de desfazer cinco vezes não é desfazer o que se fez,
   * é desfazer cinco coisas que aconteceram juntas. Um retrato, um ⌘Z.
   */
  async removeNodes(nodeIds: UUID[], opts?: { force?: boolean }): Promise<void> {
    const id = this.workspaceId
    const ws = this.state.workspace
    if (!id || !ws) return

    const existing = nodeIds.filter((n) => ws.nodes.some((node) => node.id === n))
    // Editor com alteração pendente não fecha calado: pergunta primeiro — e um
    // por vez, na fila, porque a resposta é sobre ESTE arquivo. Os outros nós da
    // seleção não esperam pela pergunta: eles não têm nada a perder.
    const asking = opts?.force ? [] : existing.filter((n) => this.dirtyEditors.has(n))
    const targets = existing.filter((n) => !asking.includes(n))
    if (asking.length > 0) {
      this.closingQueue = asking.slice(1)
      this.set({ closingEditor: asking[0] })
    }
    if (targets.length === 0) return

    // O retrato vem ANTES da poda: depois dela os cabos e a moldura já não
    // sabem que o nó existiu.
    const snapshots = captureRemoval(ws, targets)
    await Promise.all(targets.map((nodeId) => window.atelier.node.remove(id, nodeId)))
    const dead = new Set(targets)
    // UM passo no histórico para o gesto inteiro: apagar cinco nós e ter de
    // desfazer cinco vezes não é desfazer o que se fez.
    this.mutateWorkspace(
      (w) => {
        w.nodes = w.nodes.filter((n) => !dead.has(n.id))
        w.connections = w.connections.filter((c) => !dead.has(c.nodeIdA) && !dead.has(c.nodeIdB))
        // A moldura fica, só perde o membro — espelha o WorkspaceManager. Sem
        // isto o contador da faixa continuaria contando um nó que já não existe.
        w.groups = w.groups.map((g) =>
          g.nodeIds.some((n) => dead.has(n))
            ? { ...g, nodeIds: g.nodeIds.filter((n) => !dead.has(n)) }
            : g
        )
      },
      { history: true, removal: { snapshots, at: Date.now() } }
    )
    this.set({ selection: this.state.selection.filter((sel) => !dead.has(sel)) })
    // O botão do aviso e o ⌘Z são o MESMO gesto agora — os dois desfazem o
    // topo do histórico, que acabou de ser este delete.
    this.showNotice(noticeForRemoval(snapshots), {
      label: 'Desfazer',
      run: () => void this.undo()
    })
  }

  // ─── Editor de código ───────────────────────────────────────────────────────

  /** Nós de editor com alteração pendente. Fora do snapshot: muda a cada tecla. */
  private dirtyEditors = new Set<UUID>()
  /** Editores com alteração pendente ainda por perguntar, na ordem. */
  private closingQueue: UUID[] = []
  /** path → quem quer saber que o arquivo mudou em disco. */
  private fileListeners = new Map<string, Set<(text: string) => void>>()

  setPlatform(platform: string): void {
    this.set({ platform })
  }

  /**
   * Arquivo arrastado para dentro de um terminal: cola o caminho na linha, sem
   * Enter.
   *
   * Não abre editor nem cria cabo. O terminal quase sempre já está no
   * repositório do arquivo, e o que falta ali é justamente o caminho para
   * completar o comando que a pessoa estava digitando — é o mesmo gesto do
   * Terminal do sistema, inclusive no espaço no fim.
   *
   * O caminho vai ABSOLUTO, não relativo ao diretório do nó: o `workingDirectory`
   * gravado é onde o PTY nasceu, e um `cd` depois disso tornaria o relativo uma
   * mentira silenciosa. O absoluto está certo em qualquer diretório.
   */
  async pasteIntoTerminal(nodeId: UUID, path: string): Promise<void> {
    const delivered = await window.atelier.terminal.write(
      nodeId,
      `${quoteForShell(path, this.state.platform)} `
    )
    if (!delivered) {
      this.showNotice('este terminal não está rodando — nada foi colado')
      return
    }
    this.set({ selection: [nodeId] })
  }

  setEditorDirty(nodeId: UUID, dirty: boolean): void {
    if (dirty) this.dirtyEditors.add(nodeId)
    else this.dirtyEditors.delete(nodeId)
  }

  hasUnsavedEditor(nodeId: UUID): boolean {
    return this.dirtyEditors.has(nodeId)
  }

  /**
   * Fechar com alteração pendente pergunta; o diálogo mora no App.
   *
   * Cancelar cancela a FILA inteira: quem desistiu de perder um arquivo não
   * quer responder a mesma pergunta mais três vezes.
   */
  cancelCloseEditor(): void {
    this.closingQueue = []
    this.set({ closingEditor: null })
  }

  async confirmCloseEditor(): Promise<void> {
    const id = this.state.closingEditor
    if (!id) return
    const next = this.closingQueue.shift() ?? null
    this.set({ closingEditor: next })
    this.dirtyEditors.delete(id)
    await this.removeNodes([id], { force: true })
  }

  /**
   * Abre o arquivo no canvas, no nó que sabe mostrá-lo.
   *
   * Nem todo arquivo é texto: um PDF no editor de código dava "arquivo grande
   * demais" — tecnicamente verdade, e inútil. Quem renderiza PDF aqui é o
   * visor do Chromium dentro de um nó Portal com a barra de endereço
   * escondida, exatamente como o item "Documento PDF" da dock. Não é tipo de nó
   * novo: é o mesmo Portal.
   */
  async openFileInWorkspace(path: string, position?: { x: number; y: number }): Promise<void> {
    if (!this.workspaceId) {
      this.showNotice('nenhum workspace aberto para receber o arquivo')
      return
    }
    if (isPdf(path)) {
      await this.openPdfInWorkspace(path, position)
      return
    }
    // Já aberto: seleciona em vez de criar um segundo editor do mesmo arquivo,
    // que seriam dois buffers disputando o mesmo disco.
    const existing = this.state.workspace?.nodes.find(
      (n) => n.content.type === 'codeEditor' && n.content.value.filePath === path
    )
    if (existing) {
      this.set({ selection: [existing.id] })
      return
    }
    const at = position ?? centerOfViewport(620, 440)
    await this.addNode('codeEditor', at, { filePath: path })
  }

  /**
   * O nó nasce estreito de propósito: acima de ~500px o visor do Chromium abre
   * sozinho a barra de miniaturas e come metade da largura. Ver pdf-viewer.ts,
   * onde o número está medido e explicado.
   */
  private async openPdfInWorkspace(
    path: string,
    position?: { x: number; y: number }
  ): Promise<void> {
    const [width, height] = PDF_NODE_SIZE
    const size = { width, height }
    // A URL vem do main: `pathToFileURL` resolve espaço, acento e unidade do
    // Windows, e a allowlist é conferida no caminho.
    const result = await window.atelier.fs.fileUrl(path)
    if ('error' in result) {
      this.showNotice('não foi possível abrir este PDF')
      return
    }

    const existing = this.state.workspace?.nodes.find(
      (n) => n.content.type === 'portal' && n.content.value.currentURL === result.url
    )
    if (existing) {
      this.set({ selection: [existing.id] })
      return
    }

    const at = position ?? centerOfViewport(size.width, size.height)
    const name = path.split(/[\\/]/).pop() || 'Documento'
    const node = await this.addNode('portal', at, { url: result.url, name }, size)
    // `chromeHidden` tira a barra de endereço: num documento local ela não
    // serve para nada, e o visor de PDF já traz os controles dele.
    if (node) await this.patchContent(node.id, { chromeHidden: true })
  }

  /**
   * Imagem colada (Ctrl/Cmd+V no canvas) ou arrastada do sistema: vira um nó de
   * imagem no ponto indicado. Os bytes vão junto no `node.add`; o main grava o
   * arquivo gerenciado.
   *
   * A proporção do nó sai da imagem — medida aqui, antes de criar, porque o
   * conteúdo guarda `naturalWidth`/`naturalHeight` e o renderer não teria como
   * dimensionar o nó depois sem um salto visível.
   */
  async addImageFromBlob(blob: Blob, position?: { x: number; y: number }): Promise<CanvasNode | null> {
    if (!this.workspaceId) {
      this.showNotice('nenhum workspace aberto para receber a imagem')
      return null
    }
    if (blob.size > IMAGE_MAX_BYTES) {
      this.showNotice('imagem grande demais (máx. 25 MB)')
      return null
    }
    const bytes = await blob.arrayBuffer()
    const { width, height } = await imageDimensions(blob)
    const size = imageNodeSize(width, height)
    const at = position ?? centerOfViewport(size.width, size.height)
    const name = blob instanceof File && blob.name ? blob.name.replace(/\.[^.]+$/, '') : 'Imagem'
    return this.addNode(
      'image',
      at,
      {
        title: name,
        mimeType: blob.type || 'image/png',
        naturalWidth: width,
        naturalHeight: height,
        bytes
      },
      size
    )
  }

  /**
   * Imagem arrastada da árvore de arquivos: o main lê os bytes pelo mesmo canal
   * com allowlist que abre qualquer arquivo, copia para o arquivo gerenciado do
   * nó e devolve o nó já dimensionado. Sem `size` daqui — quem mede é o main
   * (header do PNG), e passar um tamanho aqui só brigaria com o dele.
   */
  async addImageFromPath(path: string, position?: { x: number; y: number }): Promise<CanvasNode | null> {
    if (!this.workspaceId) {
      this.showNotice('nenhum workspace aberto para receber a imagem')
      return null
    }
    const at = position ?? centerOfViewport(360, 260)
    const node = await this.addNode('image', at, { filePath: path })
    if (!node) this.showNotice('não foi possível ler esta imagem')
    return node
  }

  /** Pasta solta no canvas: o análogo natural é o nó de árvore. */
  async addFolderTreeToWorkspace(
    path: string,
    name: string,
    position?: { x: number; y: number }
  ): Promise<void> {
    if (!this.workspaceId) {
      this.showNotice('nenhum workspace aberto para receber a pasta')
      return
    }
    await this.addNode('fileTree', position ?? centerOfViewport(300, 420), { name, rootPath: path })
  }

  /**
   * O arquivo mudou de lugar (renomeado ou arrastado para outra pasta): o
   * editor aberto nele segue o caminho novo em vez de virar um nó quebrado.
   */
  fileMoved(from: string, to: string): void {
    const nodes = this.state.workspace?.nodes ?? []
    for (const node of nodes) {
      if (node.content.type === 'codeEditor' && node.content.value.filePath === from) {
        void this.patchContent(node.id, { filePath: to })
      }
    }
  }

  /**
   * Assina as mudanças em disco de UM arquivo. Devolve a função de cancelar.
   *
   * O main vigia caminho por caminho (nunca uma árvore) e avisa só que mudou;
   * quem relê é aqui, pelo mesmo canal com allowlist que abriu o arquivo.
   */
  onExternalFileChange(path: string, cb: (text: string) => void): () => void {
    if (!path) return () => {}
    const set = this.fileListeners.get(path)
    if (set) {
      set.add(cb)
    } else {
      this.fileListeners.set(path, new Set([cb]))
      void window.atelier.fs.watch(path)
    }
    return () => {
      const current = this.fileListeners.get(path)
      if (!current) return
      current.delete(cb)
      if (current.size > 0) return
      this.fileListeners.delete(path)
      void window.atelier.fs.unwatch(path)
    }
  }

  /** Chamado pelo evento do main: relê e distribui para quem assinou. */
  async notifyFileChanged(path: string): Promise<void> {
    const listeners = this.fileListeners.get(path)
    if (!listeners || listeners.size === 0) return
    const result = await window.atelier.fs.readFile(path)
    if ('error' in result) return
    for (const cb of listeners) cb(result.text)
  }

  /** Commit do frame ao SOLTAR o nó — durante o arrasto escrevemos direto no DOM. */
  async commitFrame(nodeId: UUID, frame: Rect): Promise<void> {
    const id = this.workspaceId
    if (!id) return
    this.mutateWorkspace(
      (ws) => {
        ws.nodes = ws.nodes.map((n) => (n.id === nodeId ? { ...n, frame } : n))
      },
      { history: true }
    )
    await window.atelier.node.setFrame(id, nodeId, frame)
  }

  /**
   * Commit de VÁRIOS frames — o fim de um arrasto de seleção múltipla, e o de
   * mover um grupo pela faixa do título.
   *
   * Um `set()` e um IPC, não N de cada: a store notifica todo assinante a cada
   * `set()`, então N commits seriam N re-renders da árvore inteira com o
   * usuário ainda com o dedo no botão do mouse.
   */
  async commitFrames(entries: { nodeId: UUID; frame: Rect }[]): Promise<void> {
    const id = this.workspaceId
    if (!id || entries.length === 0) return
    const byId = new Map(entries.map((e) => [e.nodeId, e.frame]))
    this.mutateWorkspace(
      (ws) => {
        ws.nodes = ws.nodes.map((n) => {
          const frame = byId.get(n.id)
          return frame ? { ...n, frame } : n
        })
      },
      { history: true }
    )
    await window.atelier.node.setFrames(id, entries)
  }

  async patchContent(nodeId: UUID, patch: Record<string, unknown>): Promise<void> {
    const id = this.workspaceId
    if (!id) return
    const updated = await window.atelier.node.patchContent(id, nodeId, patch)
    if (!updated) return
    this.mutateWorkspace(
      (ws) => {
        ws.nodes = ws.nodes.map((n) => (n.id === nodeId ? updated : n))
      },
      { history: true }
    )
  }

  async bringToFront(nodeId: UUID): Promise<void> {
    const id = this.workspaceId
    if (!id) return
    await window.atelier.node.bringToFront(id, nodeId)
    this.mutateWorkspace((ws) => {
      const maxZ = ws.nodes.reduce((m, n) => Math.max(m, n.zIndex), 0)
      ws.nodes = ws.nodes.map((n) => (n.id === nodeId ? { ...n, zIndex: maxZ + 1 } : n))
    })
  }

  // ─── Ferramentas e desenhos ─────────────────────────────────────────────────

  setTool(tool: Tool): void {
    // Trocar de ferramenta limpa a seleção: com a caneta ativa a alça de resize
    // e a borda de seleção só atrapalham. 'pan' é exceção — mover o quadro não
    // é motivo para largar o que estava selecionado.
    const keeps = tool === 'select' || tool === 'pan'
    this.set({ tool, selection: keeps ? this.state.selection : [] })
  }

  setPen(patch: Partial<PenSettings>): void {
    this.set({ pen: { ...this.state.pen, ...patch } })
  }

  /** Traço concluído: persiste e insere no payload em memória. */
  async addDrawing(points: number[][], color: string, lineWidth: number): Promise<void> {
    const id = this.workspaceId
    if (!id || points.length < 2) return
    const drawing = await window.atelier.drawing.add(id, points, color, lineWidth)
    if (drawing) this.mutateWorkspace((ws) => ws.drawings.push(drawing), { history: true })
  }

  async removeDrawing(drawingId: UUID): Promise<void> {
    const id = this.workspaceId
    if (!id) return
    await window.atelier.drawing.remove(id, drawingId)
    this.mutateWorkspace(
      (ws) => {
        ws.drawings = ws.drawings.filter((d) => d.id !== drawingId)
      },
      { history: true }
    )
  }

  async clearDrawings(): Promise<void> {
    const id = this.workspaceId
    if (!id) return
    await window.atelier.drawing.clear(id)
    this.mutateWorkspace(
      (ws) => {
        ws.drawings = []
      },
      { history: true }
    )
  }

  /** Commit de mover/redimensionar um traço — soltar o mouse, não cada frame do arrasto. */
  async commitDrawingPoints(id: UUID, points: number[][], lineWidth?: number): Promise<void> {
    const wsId = this.workspaceId
    if (!wsId) return
    this.mutateWorkspace(
      (ws) => {
        ws.drawings = ws.drawings.map((d) =>
          d.id === id ? { ...d, points, lineWidth: lineWidth ?? d.lineWidth } : d
        )
      },
      { history: true }
    )
    await window.atelier.drawing.setPoints(wsId, id, points, lineWidth)
  }

  /**
   * O diálogo mora no topo da árvore (App), não na dock: `.dock` tem transform
   * e backdrop-filter, e os dois viram bloco contedor de `position: fixed` —
   * o overlay ficaria preso dentro da pill.
   */
  openNewTerminal(frame: Rect | null = null, workingDirectory: string | null = null): void {
    this.set({ newTerminalOpen: true, newTerminalFrame: frame, newTerminalCwd: workingDirectory })
  }

  closeNewTerminal(): void {
    this.set({ newTerminalOpen: false, newTerminalFrame: null, newTerminalCwd: null })
  }

  // ─── Botões ─────────────────────────────────────────────────────────────────

  /**
   * Quanto tempo o pulso de "rodando" fica na tela.
   *
   * É o tempo de uma CONFIRMAÇÃO de entrega, não a duração do comando: o
   * Atelier não acompanha o processo — quem mostra andamento, erro e código de
   * saída é o terminal. Um pulso que ficasse até o fim do `npm run dev` nunca
   * apagaria.
   */
  private static readonly RUN_PULSE_MS = 1400

  private runTimers = new Map<UUID, ReturnType<typeof setTimeout>>()

  private markRun(nodeId: UUID, state: 'running' | 'failed'): void {
    const timer = this.runTimers.get(nodeId)
    if (timer) clearTimeout(timer)
    this.set({ buttonRuns: { ...this.state.buttonRuns, [nodeId]: state } })
    this.runTimers.set(
      nodeId,
      setTimeout(() => {
        const runs = { ...this.state.buttonRuns }
        delete runs[nodeId]
        this.runTimers.delete(nodeId)
        this.set({ buttonRuns: runs })
      }, state === 'failed' ? 4000 : Store.RUN_PULSE_MS)
    )
  }

  /** O diálogo mora no App (ver openNewTerminal para o porquê). */
  openButtonDialog(nodeId: UUID | null, frame: Rect | null = null): void {
    this.set({ buttonDialog: { nodeId, frame } })
  }

  closeButtonDialog(): void {
    this.set({ buttonDialog: null })
  }

  /**
   * Botão é `widget` com `kind: 'button'` — não há caso novo no enum de
   * conteúdo, e a configuração inteira vai em `view` (ver ButtonConfig).
   */
  async addButton(frame: Rect, config: ButtonConfig): Promise<CanvasNode | null> {
    return this.addNode(
      'widget',
      { x: frame.x, y: frame.y },
      { kind: 'button', view: writeButtonConfig(config) },
      { width: frame.width, height: frame.height }
    )
  }

  async saveButton(nodeId: UUID, config: ButtonConfig): Promise<void> {
    // `view` é substituído inteiro: `writeButtonConfig` OMITE o que está vazio,
    // e um merge deixaria para trás a `url` de quando a ação ainda era `url`.
    await this.patchContent(nodeId, { view: writeButtonConfig(config) })
    this.set({ buttonDialog: null })
  }

  /** Aceite do usuário a um botão proposto por agente: só isto o arma. */
  async acceptButton(nodeId: UUID): Promise<void> {
    const config = this.buttonConfig(nodeId)
    if (!config) return
    await this.saveButton(nodeId, { ...config, pending: false, proposedBy: null })
  }

  private buttonConfig(nodeId: UUID): ButtonConfig | null {
    const node = this.state.workspace?.nodes.find((n) => n.id === nodeId)
    if (!node || node.content.type !== 'widget' || node.content.value.kind !== 'button') return null
    return readButtonConfig(node.content.value.view)
  }

  /**
   * Diretório em que a ação roda: o do botão, o do projeto em que ele está
   * FIXADO, ou o do workspace — nessa ordem, a mesma do widget de git.
   */
  private buttonCwd(nodeId: UUID, config: ButtonConfig): string {
    if (config.cwd) return config.cwd
    const node = this.state.workspace?.nodes.find((n) => n.id === nodeId)
    const pinned =
      node?.content.type === 'widget' ? node.content.value.projectId : null
    const projectId = pinned ?? this.state.selectedProjectId
    const project = this.state.projects.find((p) => p.id === projectId)
    return project?.path ?? this.state.workspace?.workingDirectory ?? ''
  }

  /**
   * O clique. Aqui é onde a decisão de execução vira código: nenhum comando
   * roda fora de um PTY visível — o terminal É o log. Um caminho de `execFile`
   * no main não teria onde mostrar saída, e a primeira vez que o comando
   * falhasse o usuário ficaria com um botão que "não faz nada".
   *
   * Um botão PENDENTE é recusado em silêncio: o componente já não deixa clicar,
   * e isto é a defesa em profundidade — o aceite é o que separa "o agente
   * propôs uma linha de comando" de "o agente executa no shell do usuário".
   */
  async runButton(nodeId: UUID): Promise<void> {
    const config = this.buttonConfig(nodeId)
    if (!config || config.pending) return

    if (config.action === 'url') {
      const url = normalizeURL(config.url)
      if (!url) {
        this.showNotice('este botão não tem endereço configurado')
        this.markRun(nodeId, 'failed')
        return
      }
      const node = this.state.workspace?.nodes.find((n) => n.id === nodeId)
      const at = node
        ? { x: node.frame.x + node.frame.width + 40, y: node.frame.y }
        : centerOfViewport(640, 440)
      await this.addNode('portal', at, { url, name: config.label || 'Portal' }, {
        width: 640,
        height: 440
      })
      this.markRun(nodeId, 'running')
      return
    }

    const text = config.action === 'prompt' ? config.prompt : config.command
    if (!text.trim()) {
      this.showNotice('este botão não tem o que enviar')
      this.markRun(nodeId, 'failed')
      return
    }

    // Alvo vivo? Escreve nele. O PTY já existe, o histórico está lá, e é onde o
    // usuário está olhando.
    const target = config.target
      ? this.state.workspace?.nodes.find(
          (n) => n.id === config.target && n.content.type === 'terminal'
        ) ?? null
      : null
    if (target && (await window.atelier.terminal.write(target.id, `${text}\r`))) {
      this.set({ selection: [target.id] })
      this.markRun(nodeId, 'running')
      return
    }

    // Prompt exige alvo: criar um agente do zero para receber uma frase não é o
    // que quem clicou pediu — ele subiria sem contexto nenhum.
    if (config.action === 'prompt') {
      this.showNotice(
        target
          ? 'o agente deste botão não está rodando — nada foi enviado'
          : 'este botão não tem um agente alvo — edite-o e escolha um'
      )
      this.markRun(nodeId, 'failed')
      return
    }

    // Sem alvo (ou com o alvo morto): terminal novo à direita do botão, já com
    // o comando — o TerminalManager o injeta 300 ms depois do spawn.
    const node = this.state.workspace?.nodes.find((n) => n.id === nodeId)
    const at = node
      ? { x: node.frame.x + node.frame.width + 40, y: node.frame.y }
      : centerOfViewport(560, 360)
    const created = await this.createTerminal(
      {
        name: config.label || 'Comando',
        command: text,
        agentType: 'generic_shell',
        workingDirectory: this.buttonCwd(nodeId, config),
        icon: config.icon,
        color: config.color,
        monitorWithOmbro: true,
        isManager: false,
        themeId: null,
        fontFamily: null,
        fontSize: null,
        assignedRoleId: null,
        claudeAccountId: null,
        resumeSessionId: null
      },
      at,
      { width: 560, height: 360 }
    )
    this.markRun(nodeId, created ? 'running' : 'failed')
  }

  /**
   * Lápis da barra de ações: cada tipo de nó abre o editor dele.
   *
   * Existia só `openEditTerminal`, chamado direto pela barra — o que só
   * funcionava enquanto o terminal era o único nó com barra.
   */
  openNodeEditor(nodeId: UUID): void {
    const node = this.state.workspace?.nodes.find((n) => n.id === nodeId)
    if (!node) return
    if (node.content.type === 'terminal') this.openEditTerminal(nodeId)
    else if (node.content.type === 'widget' && node.content.value.kind === 'button') {
      this.openButtonDialog(nodeId)
    }
  }

  // ─── Projetos ───────────────────────────────────────────────────────────────

  async loadProjects(): Promise<void> {
    this.set({ projects: await window.atelier.project.list() })
  }

  setProjectQuery(projectQuery: string): void {
    this.set({ projectQuery })
  }

  selectProject(selectedProjectId: UUID | null): void {
    this.set({ selectedProjectId })
  }

  /**
   * Manda a rail abrir num item. Ver RailRequest: é intenção, não estado — a
   * rail atende e chama `consumeRailRequest`.
   */
  requestRail(tab: RailTab, projectId: UUID | null = null): void {
    const nonce = (this.state.railRequest?.nonce ?? 0) + 1
    this.set({
      railRequest: { tab, projectId, nonce },
      selectedProjectId: projectId ?? this.state.selectedProjectId
    })
  }

  consumeRailRequest(): void {
    if (this.state.railRequest) this.set({ railRequest: null })
  }

  /** Seleciona e abre a árvore dele — o par que o menu de contexto usa. */
  showProjectFiles(id: UUID): void {
    this.requestRail('arquivos', id)
  }

  /** Abre o Git já apontado para este projeto — o menu de contexto usa isto. */
  showProjectGit(id: UUID): void {
    this.requestRail('git', id)
  }

  /**
   * O caminho comum: apontar UMA pasta. Abre o seletor nativo e indexa o que
   * voltar. Devolve a mensagem de erro, ou null quando deu certo — e também
   * quando o usuário cancelou, que não é erro.
   */
  async addProjectFolder(): Promise<{ error?: string; added?: Project }> {
    const chosen = await window.atelier.dialog.chooseDirectory()
    if (!chosen) return {}
    const result = await window.atelier.project.addFolder(chosen)
    if ('error' in result) return { error: result.error }
    await this.loadProjects()
    return { added: result.project }
  }

  // ─── Projetos novos achados no boot ────────────────────────────────────────

  setCandidates(candidates: DiscoveredProject[]): void {
    this.set({ candidates })
  }

  async loadCandidates(): Promise<void> {
    this.set({ candidates: await window.atelier.project.candidates() })
  }

  async acceptCandidates(paths: string[]): Promise<void> {
    const projects = await window.atelier.project.acceptCandidates(paths)
    // O card fecha inteiro: quem desmarcou um item já respondeu sobre ele. O
    // desmarcado não é ignorado — volta a ser oferecido na próxima abertura.
    this.set({ projects, candidates: [] })
  }

  async ignoreCandidates(): Promise<void> {
    await window.atelier.project.ignoreCandidates(this.state.candidates.map((c) => c.path))
    this.set({ candidates: [] })
  }

  /** Fecha sem responder: a próxima abertura pergunta de novo. */
  dismissCandidates(): void {
    this.set({ candidates: [] })
  }

  async setAutoScanOnLaunch(autoScanOnLaunch: boolean): Promise<void> {
    const prefs = await window.atelier.prefs.set({ autoScanOnLaunch })
    this.set({ prefs })
  }

  /** O botão do aviso: desliga e fecha, com o caminho de volta na mensagem. */
  async disableAutoScan(): Promise<void> {
    await this.setAutoScanOnLaunch(false)
    this.set({ candidates: [] })
    this.showNotice('varredura automática desligada — religa no menu ⋮ da aba Projetos')
  }

  openScanDialog(): void {
    this.set({ scanDialogOpen: true })
  }

  closeScanDialog(): void {
    this.set({ scanDialogOpen: false })
  }

  setAutoDescribe(autoDescribe: boolean): void {
    this.set({ autoDescribe })
  }

  async startScan(input: { mode: 'folder' | 'home'; path?: string; maxDepth?: number }): Promise<string | null> {
    const result = await window.atelier.project.scanStart(input)
    if ('error' in result) return result.error
    // Armado no início e consumido no fim: um toggle no diálogo enquanto a
    // varredura roda não muda o que ESTA varredura combinou de fazer.
    this.armedAutoDescribe = this.state.autoDescribe
    this.set({ scanning: true, scanDialogOpen: false })
    return null
  }

  cancelScan(): void {
    this.armedAutoDescribe = false
    void window.atelier.project.scanCancel()
  }

  /**
   * Chamado pelo evento scan-done: recarrega o índice e desarma o estado.
   * Devolve `true` quando o painel deve subir o agente que descreve — só faz
   * sentido se sobrou fila e há workspace aberto para receber o nó.
   */
  async finishScan(): Promise<boolean> {
    const armed = this.armedAutoDescribe
    this.armedAutoDescribe = false
    this.set({ scanning: false })
    await this.loadProjects()
    const pending = this.state.projects.some((p) => !p.isArchived && !p.enrichedAt)
    return armed && pending && this.workspaceId !== null
  }

  async patchProject(id: UUID, patch: Partial<Project>): Promise<void> {
    await window.atelier.project.patch(id, patch)
    await this.loadProjects()
  }

  async removeProject(id: UUID): Promise<void> {
    const projects = await window.atelier.project.remove(id)
    this.set({
      projects,
      selectedProjectId: this.state.selectedProjectId === id ? null : this.state.selectedProjectId
    })
  }

  /**
   * Cria o agente que descreve os projetos. O comando vem do preset escolhido
   * pelo usuário, não é fixo: nem todo mundo usa o mesmo agente.
   */
  async startScannerAgent(position: { x: number; y: number }, command: string): Promise<string | null> {
    const workspaceId = this.workspaceId
    if (!workspaceId) return 'nenhum workspace aberto'
    const result = await window.atelier.project.startScanner(workspaceId, position, command)
    if ('error' in result) return result.error
    await this.reload()
    this.set({ selection: [result.node.id] })
    return null
  }

  async addProjectToWorkspace(id: UUID, position: { x: number; y: number }): Promise<CanvasNode | null> {
    const workspaceId = this.workspaceId
    if (!workspaceId) return null
    const node = await window.atelier.project.addToWorkspace(workspaceId, id, position)
    if (node) {
      this.mutateWorkspace((ws) => ws.nodes.push(node), { history: true })
      this.set({ selection: [node.id] })
    }
    await this.loadProjects()
    return node
  }

  /**
   * Cria o terminal já com tudo que o diálogo coletou. Passa por node.add como
   * qualquer outro nó — o main é que valida a responsabilidade e monta o
   * TerminalContent.
   */
  async createTerminal(
    draft: TerminalDraft,
    position: { x: number; y: number },
    size?: { width: number; height: number }
  ): Promise<CanvasNode | null> {
    return this.addNode('terminal', position, { ...draft }, size)
  }

  openEditTerminal(nodeId: UUID): void {
    this.set({ editTerminalId: nodeId })
  }

  closeEditTerminal(): void {
    this.set({ editTerminalId: null })
  }

  /**
   * Grava o rascunho por cima do terminal existente. Os campos do TerminalDraft
   * são os mesmos do TerminalContent, então o patch raso dá conta.
   *
   * Comando, diretório e shell só valem no próximo boot do PTY: mexer neles não
   * mata o processo em andamento — quem decide isso é o botão de recarregar.
   */
  async saveTerminal(nodeId: UUID, draft: TerminalDraft): Promise<void> {
    await this.patchContent(nodeId, { ...draft })
    this.set({ editTerminalId: null })
  }

  /**
   * Retoma a sessão do agente: mata o PTY e deixa o boot seguinte encontrar o
   * id gravado.
   *
   * É o MESMO gesto do recarregar, menos o esquecimento — a diferença entre os
   * dois é exatamente uma linha, e é a linha que decide se a conversa anterior
   * volta. Ver core/terminal/session-store.ts.
   */
  async resumeTerminal(nodeId: UUID): Promise<void> {
    return this.restartTerminalKeepingSession(nodeId)
  }

  /**
   * A sessão gravada deste nó, ou null quando não há o que retomar (agente sem
   * suporte, primeiro boot, id apagado por um "Sessão nova").
   */
  async terminalSession(
    nodeId: UUID
  ): Promise<{ sessionId: UUID; startedAt: string } | null> {
    const wsId = this.workspaceId
    if (!wsId) return null
    return window.atelier.terminal.session(wsId, nodeId)
  }

  /**
   * Sessão nova: mata o PTY, ESQUECE o id e sobe outro no lugar.
   *
   * Recarregar é o gesto de desistir do estado atual — quem clica ali quer
   * começar limpo, e ressuscitar a conversa anterior seria o oposto do pedido.
   * Por isso o esquecimento acontece ANTES da remontagem: sem ele o spawn
   * seguinte encontraria o arquivo e retomaria o que o usuário descartou.
   */
  async restartTerminal(nodeId: UUID): Promise<void> {
    const wsId = this.workspaceId
    if (wsId) await window.atelier.terminal.forgetSession(wsId, nodeId)
    return this.restartTerminalKeepingSession(nodeId)
  }

  private async restartTerminalKeepingSession(nodeId: UUID): Promise<void> {
    await window.atelier.terminal.kill(nodeId)
    const epoch = this.state.terminalEpoch
    // Contadores zerados nos DOIS caminhos: eles são do processo que acabou de
    // morrer. Um agente retomado republica os dele nos primeiros segundos.
    const status = { ...this.state.terminalStatus }
    delete status[nodeId]
    // A leitura publicada é da sessão que acabou de morrer: custo e contexto do
    // processo velho não valem para o novo.
    const usage = { ...this.state.terminalUsage }
    delete usage[nodeId]
    this.set({
      terminalEpoch: { ...epoch, [nodeId]: (epoch[nodeId] ?? 0) + 1 },
      terminalStatus: status,
      terminalUsage: usage
    })
  }

  /**
   * Mostra um aviso na barra por alguns segundos.
   *
   * Existe porque falha de IPC no renderer não tem para onde ir: sem isto, uma
   * chamada que rejeita vira `void` engolido e o usuário fica achando que o
   * clique não fez nada.
   */
  showNotice(text: string, action?: Notice['action']): void {
    this.set({ notice: { text, action } })
    if (this.noticeTimer) clearTimeout(this.noticeTimer)
    this.noticeTimer = setTimeout(() => this.set({ notice: null }), 7000)
  }

  dismissNotice(): void {
    if (this.noticeTimer) clearTimeout(this.noticeTimer)
    this.set({ notice: null })
  }

  setTerminalStatus(nodeId: UUID, status: AgentStatus): void {
    this.set({ terminalStatus: { ...this.state.terminalStatus, [nodeId]: status } })
  }

  setTerminalUsage(nodeId: UUID, usage: AgentUsage): void {
    this.set({ terminalUsage: { ...this.state.terminalUsage, [nodeId]: usage } })
  }

  // ─── Contas do Claude ───────────────────────────────────────────────────────

  /**
   * Relê a lista de contas E o consumo guardado de cada uma — é o botão de
   * recarregar do bloco de perfis. As duas coisas juntas porque a pergunta do
   * clique é uma só ("como estão minhas contas agora"), e o login feito num
   * terminal muda as duas: aparece o e-mail e começa a aparecer o limite.
   *
   * Não vai buscar uso NOVO na API: o percentual só existe quando um agente o
   * publica, e sondar a Anthropic para preencher a tela gastaria da mesma
   * janela que este painel está medindo.
   */
  async refreshClaudeAccounts(): Promise<ClaudeAccountInfo[]> {
    const [claudeAccounts, claudeAccountUsage] = await Promise.all([
      window.atelier.claudeAccount.list(),
      window.atelier.claudeAccount.usage()
    ])
    this.set({ claudeAccounts, claudeAccountUsage })
    return claudeAccounts
  }

  async subscribeCodexAccount(): Promise<void> {
    const usage = await window.atelier.codex.subscribe()
    this.set({ codexAccountUsage: usage })
  }

  async unsubscribeCodexAccount(): Promise<void> {
    await window.atelier.codex.unsubscribe()
  }

  setCodexAccountUsage(usage: CodexAccountUsage): void {
    this.set({ codexAccountUsage: usage })
  }

  async refreshCodexAccount(): Promise<CodexAccountUsage> {
    const usage = await window.atelier.codex.refreshAccount()
    this.set({ codexAccountUsage: usage })
    return usage
  }

  /**
   * Cria a conta. NÃO faz login: o diretório nasce vazio de credencial, e quem
   * conduz o /login é o próprio `claude` no primeiro terminal aberto nela — é
   * por isso que o aviso abaixo fala em abrir um terminal, e não em autenticar.
   */
  async createClaudeAccount(label: string): Promise<string | null> {
    try {
      const { account, warnings, accounts } = await window.atelier.claudeAccount.create(label)
      this.set({ claudeAccounts: accounts })
      if (warnings.length > 0) this.showNotice(warnings.join('; '))
      return account.id
    } catch (err) {
      this.showNotice(`não deu para criar a conta: ${(err as Error).message}`)
      return null
    }
  }

  async removeClaudeAccount(id: string, deleteFiles: boolean): Promise<void> {
    const claudeAccounts = await window.atelier.claudeAccount.remove(id, deleteFiles)
    this.set({ claudeAccounts })
  }

  /**
   * Troca a conta de um terminal e reinicia o PTY dele.
   *
   * O reinício não é zelo: `CLAUDE_CONFIG_DIR` é lido no `exec` do `claude`, e
   * um processo já rodando continuaria na conta antiga por mais que o nó
   * mostrasse a nova. Só este terminal cai — os outros do canvas seguem.
   */
  async setTerminalAccount(nodeId: UUID, accountId: string): Promise<void> {
    const id = accountId === DEFAULT_CLAUDE_ACCOUNT_ID ? null : accountId
    await this.patchContent(nodeId, { claudeAccountId: id })
    await this.restartTerminal(nodeId)
    const label =
      this.state.claudeAccounts.find((a) => a.id === accountId)?.label ?? 'conta padrão'
    this.showNotice(`terminal reiniciado na conta ${label}`)
  }

  // ─── Responsabilidades (agentes) ────────────────────────────────────────────

  async saveRole(patch: Partial<AgentRole> & { name: string }): Promise<AgentRole> {
    const saved = await window.atelier.role.save(patch)
    const roles = await window.atelier.role.list()
    this.set({ roles })
    return saved
  }

  async removeRole(id: UUID): Promise<void> {
    const roles = await window.atelier.role.remove(id)
    this.set({ roles })
    // O main limpou o assignedRoleId dos terminais que apontavam para ela
    await this.reload()
  }

  // ─── Preferências ───────────────────────────────────────────────────────────

  async patchPrefs(patch: Partial<Preferences>): Promise<void> {
    const prefs = await window.atelier.prefs.set(patch)
    this.set({ prefs })
  }

  // ─── Conexões ───────────────────────────────────────────────────────────────

  async addConnection(idA: UUID, idB: UUID): Promise<Connection | null> {
    const id = this.workspaceId
    if (!id) return null
    const conn = await window.atelier.connection.add(id, idA, idB)
    if (conn) this.mutateWorkspace((ws) => ws.connections.push(conn), { history: true })
    return conn
  }

  async removeConnection(connectionId: UUID): Promise<void> {
    const id = this.workspaceId
    if (!id) return
    await window.atelier.connection.remove(id, connectionId)
    this.mutateWorkspace(
      (ws) => {
        ws.connections = ws.connections.filter((c) => c.id !== connectionId)
      },
      { history: true }
    )
  }

  setConnectionStatus(connectionId: UUID, status: Connection['status']): void {
    this.mutateWorkspace((ws) => {
      ws.connections = ws.connections.map((c) => (c.id === connectionId ? { ...c, status } : c))
    })
  }

  // ─── Grupos ─────────────────────────────────────────────────────────────────
  // A moldura com título. A verdade é a lista de membros (`nodeIds`); a
  // contenção geométrica é só o gesto que a edita — ver canvas/group-geometry.ts.

  get groups(): NodeGroup[] {
    return this.state.workspace?.groups ?? []
  }

  group(id: UUID): NodeGroup | null {
    return this.groups.find((g) => g.id === id) ?? null
  }

  /** Seleciona a moldura. Grupo, nós e traço são exclusivos: escolher um limpa os outros. */
  selectGroup(id: UUID | null): void {
    this.set({
      selectedGroupId: id,
      selection: id ? [] : this.state.selection,
      selectedDrawingId: id ? null : this.state.selectedDrawingId
    })
  }

  async createGroup(title: string, frame: Rect, nodeIds: UUID[]): Promise<NodeGroup | null> {
    const id = this.workspaceId
    if (!id) return null
    // Retrato de antes, capturado à parte: este caminho não passa por
    // mutateWorkspace (o resultado vem de `reload`, não de um patch local), e só
    // deve empilhar se a criação realmente vingar — não em cada tentativa.
    const before = this.state.workspace ? this.snapshotOf(this.state.workspace) : null
    const group = await window.atelier.group.create(id, title, frame, nodeIds)
    if (!group) return null
    if (before) this.pushSnapshot({ snapshot: before, removal: null })
    // Substitui a lista inteira em vez de só empurrar o novo: o main pode ter
    // tirado membros de outros grupos para honrar a regra de um dono por nó, e
    // a cópia daqui ficaria mostrando o nó nos dois lugares.
    await this.reload()
    this.set({ selection: [], selectedGroupId: group.id })
    return group
  }

  /**
   * Ctrl/Cmd+G: envolve o que está selecionado. O frame é a união dos membros
   * com folga em volta e o espaço da faixa no topo (ver boundsForNodes).
   */
  async groupSelection(): Promise<NodeGroup | null> {
    const ids = this.state.selection
    if (ids.length === 0) return null
    const nodes = (this.state.workspace?.nodes ?? []).filter((n) => ids.includes(n.id))
    const frame = boundsForNodes(nodes.map((n) => n.frame))
    if (!frame) return null
    return this.createGroup('Grupo', frame, ids)
  }

  private async patchGroup(
    groupId: UUID,
    patch: Partial<Pick<NodeGroup, 'title' | 'frame' | 'color' | 'isCollapsed' | 'nodeIds'>>
  ): Promise<void> {
    const id = this.workspaceId
    if (!id) return
    // Otimista: a moldura acompanha o gesto na hora, e o main confirma depois.
    // O que volta de lá é a mesma coisa — a única regra que ele pode mudar
    // (dono único) só vale para `nodeIds`, e esse caminho recarrega. História só
    // aqui, não na confirmação abaixo — senão um Ctrl+Z desfaria a mesma edição
    // duas vezes.
    this.mutateWorkspace(
      (ws) => {
        ws.groups = ws.groups.map((g) => (g.id === groupId ? { ...g, ...patch } : g))
      },
      { history: true }
    )
    const updated = await window.atelier.group.update(id, groupId, patch)
    if (updated) {
      this.mutateWorkspace((ws) => {
        ws.groups = ws.groups.map((g) => (g.id === groupId ? updated : g))
      })
    }
  }

  renameGroup(groupId: UUID, title: string): Promise<void> {
    return this.patchGroup(groupId, { title: title.trim() || 'Grupo' })
  }

  setGroupFrame(groupId: UUID, frame: Rect): Promise<void> {
    return this.patchGroup(groupId, { frame })
  }

  setGroupColor(groupId: UUID, color: string): Promise<void> {
    return this.patchGroup(groupId, { color })
  }

  /**
   * Colapsa/expande. Os membros saem do RENDER, nunca do estado: o PTY de um
   * terminal vive no processo principal e continua rodando, e um portal
   * colapsado continua na exceção do portalWake — senão a leitura pelo agente
   * pararia de funcionar por causa de um retângulo dobrado na tela.
   */
  setGroupCollapsed(groupId: UUID, isCollapsed: boolean): Promise<void> {
    return this.patchGroup(groupId, { isCollapsed })
  }

  /** "Ajustar ao conteúdo": a moldura encolhe até os membros, com a folga. */
  async fitGroupToContent(groupId: UUID): Promise<void> {
    const group = this.group(groupId)
    if (!group) return
    const nodes = (this.state.workspace?.nodes ?? []).filter((n) => group.nodeIds.includes(n.id))
    const frame = boundsForNodes(nodes.map((n) => n.frame))
    if (!frame) return
    await this.setGroupFrame(groupId, frame)
  }

  /**
   * Desagrupar: some a moldura, ficam os nós. Com `withNodes`, os membros vão
   * junto — caminho separado e com confirmação, porque é o único destrutivo.
   */
  async removeGroup(groupId: UUID, opts: { withNodes?: boolean } = {}): Promise<void> {
    const id = this.workspaceId
    if (!id) return
    if (opts.withNodes) {
      // Um retrato só para os N membros: desfazer devolve os nós (SOLTOS — a
      // moldura foi embora no mesmo gesto e não faz parte do retrato).
      const group = this.group(groupId)
      await this.removeNodes(group?.nodeIds ?? [], { force: true })
    }
    await window.atelier.group.remove(id, groupId)
    this.mutateWorkspace(
      (ws) => {
        ws.groups = ws.groups.filter((g) => g.id !== groupId)
      },
      { history: true }
    )
    this.set({
      selectedGroupId: this.state.selectedGroupId === groupId ? null : this.state.selectedGroupId,
      isolatedGroupId: this.state.isolatedGroupId === groupId ? null : this.state.isolatedGroupId
    })
  }

  /**
   * Muda o dono de um nó — o que o fim de um arrasto decide. `null` solta.
   *
   * Não faz nada quando o dono já é esse: é chamado a cada `mouseup` de arrasto
   * de nó, e sem a saída rápida todo movimento dentro do mesmo grupo custaria
   * um IPC e um re-render.
   */
  async setNodeGroup(nodeId: UUID, groupId: UUID | null): Promise<void> {
    const id = this.workspaceId
    if (!id) return
    const current = groupOf(this.groups, nodeId)
    if ((current?.id ?? null) === groupId) return
    this.mutateWorkspace((ws) => {
      ws.groups = ws.groups.map((g) => {
        if (g.id === groupId) return { ...g, nodeIds: [...g.nodeIds, nodeId] }
        if (g.nodeIds.includes(nodeId)) return { ...g, nodeIds: g.nodeIds.filter((n) => n !== nodeId) }
        return g
      })
    })
    await window.atelier.group.setNode(id, nodeId, groupId)
  }

  /** Foco: o grupo fica opaco e o resto do canvas apaga. Só em memória. */
  isolateGroup(id: UUID | null): void {
    this.set({ isolatedGroupId: id })
  }

  // ─── Seleção e interação ────────────────────────────────────────────────────

  select(ids: UUID[]): void {
    // Selecionar nó tira a seleção da moldura: são o mesmo "o que está
    // selecionado", e o Delete precisa de uma resposta só.
    this.set({
      selection: ids,
      selectedGroupId: ids.length > 0 ? null : this.state.selectedGroupId,
      selectedDrawingId: ids.length > 0 ? null : this.state.selectedDrawingId
    })
  }

  /** Seleciona um traço de desenho. Exclusivo com nó e grupo — mesma regra. */
  selectDrawing(id: UUID | null): void {
    this.set({ selectedDrawingId: id, selection: id ? [] : this.state.selection, selectedGroupId: id ? null : this.state.selectedGroupId })
  }

  toggleSelect(id: UUID): void {
    const sel = this.state.selection
    this.set({ selection: sel.includes(id) ? sel.filter((s) => s !== id) : [...sel, id] })
  }

  /**
   * Largura da coluna da rail. Chamada UMA vez, no fim do arrasto — durante o
   * gesto quem manda na largura é o CSS var, escrito direto no documento.
   *
   * Grava em `prefs.sidebarWidth`: o campo do disco é reaproveitado porque
   * mede exatamente a mesma coisa que media antes, e trocar o nome custaria
   * uma migração de preferências para nada.
   */
  async setRailWidth(sidebarWidth: number): Promise<void> {
    const prefs = await window.atelier.prefs.set({ sidebarWidth })
    this.set({ prefs })
  }

  /**
   * Move uma pílula flutuante e grava a posição.
   *
   * UMA gravação, no fim do gesto — como `setRailWidth`, e pelo mesmo motivo:
   * gravar durante o arrasto escreveria `preferences.json` sessenta vezes por
   * segundo por uma posição da qual só a última importa.
   */
  async setPillPlacement(id: PillId, placement: PillPlacement): Promise<void> {
    const key = PILL_PREF_KEY[id]
    this.set({ [key]: placement } as Partial<AppSnapshot>)
    this.mirrorPrefs({ [key]: formatPlacement(placement) })
    await window.atelier.prefs.set({ [key]: formatPlacement(placement) })
  }

  /**
   * Liga e desliga a tira do monitor na borda.
   *
   * Desligada, ela não é escondida: deixa de ser MONTADA (ver canvas-view), e
   * com ela vai embora o `useSystemStats` que assina o amostrador. É o que faz
   * "não quero pagar por isso" custar zero de fato, e não zero de aparência.
   *
   * Quem liga de volta é o item da dock — a alternância nasceu com as duas
   * pontas de propósito. Um "Ocultar" no menu da pílula sem caminho de volta é
   * exatamente o estado ruim que o plano das docks móveis deixou registrado.
   */
  async setMonitorDockVisible(monitorDockVisible: boolean): Promise<void> {
    this.set({ monitorDockVisible })
    this.mirrorPrefs({ monitorDockVisible })
    await window.atelier.prefs.set({ monitorDockVisible })
  }

  setTheme(theme: ThemeMode): void {
    applyTheme(theme)
    this.set({ theme })
    this.mirrorPrefs({ theme })
    void window.atelier.prefs.set({ theme })
  }

  /** Espelho local de preferences.json — sem isto `prefs` envelhece na store. */
  private mirrorPrefs(patch: Partial<Preferences>): void {
    const prefs = this.state.prefs
    if (prefs) this.set({ prefs: { ...prefs, ...patch } })
  }

  startConnecting(from: UUID | null): void {
    // Os dois modos disputam o mesmo clique no canvas: entrar num cancela o outro.
    this.set({ connectingFrom: from, placing: from ? null : this.state.placing })
  }

  /** Liga o modo "desenhe a área": o próximo arrasto no canvas cria o nó. */
  startPlacing(placing: Placement): void {
    this.set({ placing, connectingFrom: null, selection: [] })
  }

  cancelPlacing(): void {
    if (this.state.placing) this.set({ placing: null })
  }

  /** Chamado pelo canvas quando a área ficou pronta. */
  completePlacing(frame: Rect): void {
    const placing = this.state.placing
    if (!placing) return
    this.set({ placing: null })
    placing.finish(frame)
  }

  /** Recarrega do main — usado quando o CLI muda o canvas por fora. */
  async reload(): Promise<void> {
    const id = this.state.activeId
    if (!id) return
    const workspace = await window.atelier.workspace.open(id)
    this.set({ workspace })
  }
}

/** Espelha Constants.imageMaxBytes do main — o main recusa de novo, isto só evita o round-trip. */
const IMAGE_MAX_BYTES = 25 * 1024 * 1024
/** Maior lado de um nó de imagem recém-criado, em pontos de canvas. */
const IMAGE_NODE_MAX_SIDE = 520
const IMAGE_NODE_MIN_SIDE = 120
/** Altura reservada para a barra do nó, somada à área da imagem. */
const IMAGE_NODE_BAR = 24

/** Dimensões naturais de um blob de imagem; (0,0) quando não dá para medir (ex.: SVG). */
async function imageDimensions(blob: Blob): Promise<{ width: number; height: number }> {
  try {
    const bitmap = await createImageBitmap(blob)
    const dims = { width: bitmap.width, height: bitmap.height }
    bitmap.close()
    return dims
  } catch {
    return { width: 0, height: 0 }
  }
}

/** Tamanho do nó a partir da proporção da imagem, preso entre o piso e o teto. */
function imageNodeSize(w: number, h: number): { width: number; height: number } {
  if (w <= 0 || h <= 0) return { width: 360, height: 260 }
  const scale = Math.min(1, IMAGE_NODE_MAX_SIDE / Math.max(w, h))
  const width = Math.max(IMAGE_NODE_MIN_SIDE, Math.round(w * scale))
  const height = Math.max(IMAGE_NODE_MIN_SIDE, Math.round(h * scale)) + IMAGE_NODE_BAR
  return { width, height }
}

/** Retângulo centrado no que está à vista — onde o usuário está olhando. */
function centerOfViewport(width: number, height: number): { x: number; y: number } {
  const c = viewport.toCanvas({ x: viewport.width / 2, y: viewport.height / 2 })
  return { x: c.x - width / 2, y: c.y - height / 2 }
}

export const store = new Store()

export function useStore(): AppSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}
