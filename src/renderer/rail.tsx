/**
 * Rail esquerda e a cascata que sai dela — o que substituiu a sidebar de abas.
 *
 * A sidebar tinha quatro abas numa coluna só. As abas existiam por uma
 * restrição real: três áreas de rolagem empilhadas numa coluna de 220px são
 * três áreas inutilizáveis. Mas elas também escondiam a DEPENDÊNCIA entre os
 * painéis — Arquivos e Git só têm o que mostrar depois que Projetos escolheu um
 * projeto, e nas abas isso aparecia como um vazio com um atalho de volta.
 *
 * A cascata é essa dependência virando geometria: coluna 1 escolhe, coluna 2
 * mostra. Cada nível tem a própria rolagem, que é o que as abas resolviam.
 *
 * Duas regras que o desenho preserva:
 *
 *  - `selectedProjectId` continua sendo a FONTE ÚNICA de "em que projeto
 *    estou". A cascata mostra essa seleção; nunca guarda uma cópia dela.
 *  - Qual item está aberto é estado LOCAL, como o `openMenu` da dock. Quem
 *    precisa mandar a rail abrir (o menu de contexto de um projeto, o vazio de
 *    Arquivos) manda uma INTENÇÃO pela store — ver RailRequest.
 */
import { useEffect, useRef, useState } from 'react'
import type { Project } from '@shared/types'
import { viewport } from './canvas/viewport'
import { IconBranch, IconCube, IconFolder } from './icons'
import { FilesPanel } from './panels/files-panel'
import { GitPanel } from './panels/git-panel'
import { ProjectPanel } from './panels/project-panel'
import { store, useStore, type RailTab } from './state/store'
import { useGit } from './state/use-git'

interface Item {
  id: RailTab
  icon: (p: { size?: number }) => JSX.Element
  /** Legenda do hover, e também o nome acessível do botão. */
  label: string
  /**
   * O item não tem o que mostrar sem um projeto escolhido. Vira botão
   * DESABILITADO, e não um item que abre um vazio: a dependência entre os
   * painéis fica visível antes do clique, e não depois dele.
   */
  needsProject?: boolean
}

/**
 * Workspaces não está aqui: subiu para o chip do canto superior esquerdo, que é
 * onde o nome do workspace já estava sendo lido.
 *
 * A legenda é em inglês porque é o vocabulário do domínio: project, file e git
 * são os mesmos termos do formato em disco e do CLI.
 */
const ITEMS: Item[] = [
  { id: 'projetos', icon: IconCube, label: 'Projects' },
  { id: 'arquivos', icon: IconFolder, label: 'Files', needsProject: true },
  { id: 'git', icon: IconBranch, label: 'Git', needsProject: true }
]

/** Padrão, e os limites do arrasto. O teto relativo é aplicado à parte. */
export const RAIL_WIDTH = { default: 220, min: 180, max: 480 }

/** Fração da janela que a coluna nunca passa — numa tela pequena, o teto fixo
 *  de 480px engoliria o canvas. */
const MAX_FRACTION = 0.4

function clampWidth(px: number): number {
  const ceiling = Math.min(RAIL_WIDTH.max, window.innerWidth * MAX_FRACTION)
  return Math.round(Math.max(RAIL_WIDTH.min, Math.min(ceiling, px)))
}

function applyWidth(px: number): void {
  document.documentElement.style.setProperty('--rail-panel-width', `${px}px`)
}

/** Onde a coluna de conteúdo começa na tela — a rail mais a coluna de lista. */
const CASCADE_LEFT = 62
const LIST_WIDTH = 220

export function Rail(): JSX.Element {
  const { prefs, projects, selectedProjectId, railRequest, workspace } = useStore()
  const [open, setOpen] = useState<RailTab | null>(null)
  // Mostrar o seletor de projeto ao lado do conteúdo. Não é "qual projeto" —
  // isso é global; é só a geometria da cascata.
  const [picker, setPicker] = useState(false)
  const dragging = useRef(false)
  const hostRef = useRef<HTMLDivElement>(null)

  const project = projects.find((p) => p.id === selectedProjectId) ?? null

  // A largura vem das preferências e vai direto para o CSS var. Não entra na
  // store: durante o arrasto isso seria um set() por frame, e cada set()
  // notifica TODOS os assinantes, canvas incluído.
  useEffect(() => {
    if (prefs) applyWidth(clampWidth(prefs.sidebarWidth))
  }, [prefs?.sidebarWidth])

  /** Um item que depende de projeto está fechado enquanto não houver um. */
  const blocked = (tab: RailTab): boolean =>
    ITEMS.find((i) => i.id === tab)?.needsProject === true && !selectedProjectId

  const openTab = (tab: RailTab): void => {
    if (blocked(tab)) return
    setOpen(tab)
    // Projetos JÁ é a lista — abrir um seletor ao lado dela seria a mesma lista
    // duas vezes. Arquivos e Git pulam o seletor quando já há projeto.
    setPicker(tab !== 'projetos' && !selectedProjectId)
  }

  const toggleTab = (tab: RailTab): void => {
    if (open === tab) setOpen(null)
    else openTab(tab)
  }

  /**
   * Perder a seleção com Arquivos ou Git abertos fecha a cascata.
   *
   * Sem isto o app ficaria num estado que ele mesmo diz ser impossível: a
   * coluna aberta num item cujo botão está desabilitado ao lado dela. Acontece
   * de verdade — desmarcar o projeto no seletor é um clique.
   */
  useEffect(() => {
    if (open && blocked(open)) setOpen(null)
  }, [open, selectedProjectId])

  // Pedido vindo de fora (menu de contexto de projeto, vazio de um painel).
  // Consumir e zerar é o contrato do RailRequest: é intenção, não estado.
  useEffect(() => {
    if (!railRequest) return
    openTab(railRequest.tab)
    store.consumeRailRequest()
  }, [railRequest?.nonce])

  useEffect(() => {
    const typing = (el: EventTarget | null): boolean =>
      el instanceof HTMLElement &&
      (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)

    const onKey = (e: KeyboardEvent): void => {
      if (typing(e.target)) return

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        setOpen((v) => (v ? null : 'projetos'))
        return
      }
      // ⌘1..3 vão direto ao item, na ordem em que eles aparecem na rail.
      if (e.metaKey || e.ctrlKey) {
        const n = Number(e.key)
        if (n >= 1 && n <= ITEMS.length) {
          e.preventDefault()
          openTab(ITEMS[n - 1].id)
        }
        return
      }
      if (!open) return

      // Esc fecha o nível MAIS INTERNO: de "conteúdo" volta ao seletor, e só o
      // segundo Esc fecha a cascata. Em Projetos não há nível acima do
      // conteúdo, então um Esc já fecha.
      if (e.key === 'Escape') {
        if (open !== 'projetos' && !picker) setPicker(true)
        else setOpen(null)
        return
      }
      // ← e → percorrem os mesmos níveis que o Esc sobe.
      if (e.key === 'ArrowLeft' && open !== 'projetos' && !picker) setPicker(true)
      if (e.key === 'ArrowRight' && open !== 'projetos' && picker && selectedProjectId) {
        setPicker(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, picker, selectedProjectId])

  /**
   * Clique fora fecha a cascata — o mesmo contrato dos menus da dock e do chip.
   *
   * `mousedown` e não `click`, pelo mesmo motivo da dock: o clique no canvas
   * começa um arrasto, e fechar só no `click` deixaria a coluna aberta durante
   * todo o gesto, por cima do que ele desenha.
   *
   * As exceções são as superfícies que VIVEM fora da árvore da rail mas
   * pertencem a ela: os menus de contexto e os diálogos são renderizados em
   * portal no `body` (ver context-menu.tsx), então um clique em "Renomear" ou no
   * diálogo de varredura conta como clique fora e fecharia a cascata debaixo do
   * próprio menu que o usuário está usando.
   */
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      const target = e.target as HTMLElement | null
      if (hostRef.current?.contains(target)) return
      if (target?.closest('.context-menu, .modal-backdrop, .dock-menu')) return
      setOpen(null)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  // ─── Arrasto da coluna ──────────────────────────────────────────────────────

  /** A largura é a distância do cursor à borda ESQUERDA da coluna, não ao 0 da
   *  janela: a coluna começa depois da rail (e, no modo seletor, depois dele). */
  const widthFromPointer = (clientX: number): number =>
    clampWidth(clientX - CASCADE_LEFT - (picker ? LIST_WIDTH + 8 : 0))

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    dragging.current = true
    // Sem captura o arrasto morre assim que o ponteiro entra no canvas — que é
    // onde ele passa quase todo o gesto.
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragging.current) return
    applyWidth(widthFromPointer(e.clientX))
  }

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragging.current) return
    dragging.current = false
    e.currentTarget.releasePointerCapture(e.pointerId)
    // Uma gravação só, no fim do gesto.
    void store.setRailWidth(widthFromPointer(e.clientX))
  }

  const resetWidth = (): void => {
    applyWidth(RAIL_WIDTH.default)
    void store.setRailWidth(RAIL_WIDTH.default)
  }

  // ─── Fixar no canvas ────────────────────────────────────────────────────────

  /**
   * Mesmo compasso da dock: nada nasce no clique. O item arma o modo "desenhe a
   * área", e quem decide lugar e tamanho é o gesto seguinte no canvas.
   */
  const pin = (
    label: string,
    size: [number, number],
    kind: 'fileTree' | 'widget',
    opts: Record<string, unknown>
  ): void => {
    if (!workspace) {
      store.showNotice('abra um workspace para fixar um painel no canvas')
      return
    }
    setOpen(null)
    store.startPlacing({
      label,
      defaultSize: size,
      minSize: [200, 160],
      finish: (frame) => {
        void store.addNode(kind, { x: frame.x, y: frame.y }, opts, {
          width: frame.width,
          height: frame.height
        })
      }
    })
  }

  /**
   * Arquivos não vira widget: `fileTree` já é um tipo de nó do canvas, criado
   * pela dock desde sempre. Fixar a coluna Arquivos é criar um deles com a raiz
   * do projeto — zero formato novo.
   */
  const pinFiles = (): void => {
    if (!project) return
    pin('árvore de arquivos', [300, 420], 'fileTree', {
      name: project.name,
      rootPath: project.path
    })
  }

  /** Git e Projetos viram widget, que é o caso de enum criado para isto. */
  const pinGit = (): void => {
    if (!project) return
    // Nasce FIXADO no projeto: quem fixa o painel de um repositório no canvas
    // quer aquele repositório, não "o que estiver selecionado". O cadeado no
    // cabeçalho do nó desfaz isso.
    pin('painel de git', [420, 460], 'widget', { kind: 'git', projectId: project.id })
  }

  const pinProjects = (): void => {
    pin('painel de projetos', [320, 460], 'widget', { kind: 'projects' })
  }

  // ─── Colunas ────────────────────────────────────────────────────────────────

  const columns: JSX.Element[] = []

  if (open === 'projetos') {
    // UMA coluna, não duas. Projetos é o único item da rail sem dependência a
    // resolver: escolher já é o fim do caminho, e o que se quer saber do
    // escolhido cabe embaixo dele. A cascata de duas colunas é de Arquivos e
    // Git, onde a coluna 1 responde uma pergunta que a 2 precisa.
    columns.push(
      <Column
        key="lista"
        label="Projetos"
        resizable
        onResize={{ onPointerDown, onPointerMove, onPointerUp, resetWidth }}
      >
        <ProjectPanel
          onPin={pinProjects}
          detail={project ? <ProjectSummary project={project} onClose={() => setOpen(null)} /> : null}
        />
      </Column>
    )
  }

  if (open === 'arquivos' || open === 'git') {
    if (picker) {
      columns.push(
        <Column key="seletor" label="Escolher projeto" list>
          <ProjectPanel
            mode="picker"
            // Escolher resolve a dependência: a coluna 2 nasce agora. O seletor
            // FICA na tela — trocar de projeto é o gesto seguinte mais provável.
            onPick={() => setPicker(false)}
          />
        </Column>
      )
    }
    // A coluna 2 só NASCE depois que a dependência foi resolvida. Abri-la vazia
    // ao lado do seletor seria mostrar o vazio de "escolha um projeto" bem ao
    // lado da lista que serve para escolher um.
    if (project || !picker) columns.push(
      <Column
        key="conteudo"
        label={open === 'arquivos' ? 'Arquivos do projeto' : 'Git do projeto'}
        resizable
        onResize={{ onPointerDown, onPointerMove, onPointerUp, resetWidth }}
      >
        {/* Sem o seletor à vista, o cabeçalho é a única volta possível: sem ele
            a coluna 2 seria um beco, e trocar de projeto exigiria fechar e
            reabrir a cascata. */}
        {!picker && project && (
          <button type="button" className="rail-back" onClick={() => setPicker(true)}>
            ‹ <span>{project.name}</span>
          </button>
        )}
        {open === 'arquivos' ? (
          <FilesPanel onPin={project ? pinFiles : undefined} />
        ) : (
          <GitPanel onPin={project ? pinGit : undefined} />
        )}
      </Column>
    )
  }

  return (
    <div ref={hostRef}>
      <div className="floating rail" role="toolbar" aria-label="Painéis" aria-orientation="vertical">
        {ITEMS.map(({ id, icon: Icon, label }) => (
          <button
            key={id}
            type="button"
            className={open === id ? 'rail-btn is-open' : 'rail-btn'}
            disabled={blocked(id)}
            // O motivo no hover: um botão apagado sem explicação vira um bug
            // aos olhos de quem clica.
            title={blocked(id) ? `${label} — escolha um projeto primeiro` : label}
            aria-label={label}
            aria-expanded={open === id}
            onClick={() => toggleTab(id)}
          >
            <Icon size={17} />
          </button>
        ))}
        {open && (
          <>
            <div className="rail-sep" />
            <button
              type="button"
              className="rail-btn rail-collapse"
              title="Recolher (Esc)"
              aria-label="Recolher a cascata"
              onClick={() => setOpen(null)}
            >
              ‹
            </button>
          </>
        )}
      </div>

      {columns.length > 0 && <div className="rail-cascade">{columns}</div>}
    </div>
  )
}

interface ResizeHandlers {
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void
  onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void
  onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void
  resetWidth: () => void
}

/** Uma coluna da cascata: superfície, rolagem própria e, na última, a alça. */
function Column({
  label,
  children,
  list = false,
  resizable = false,
  onResize
}: {
  label: string
  children: React.ReactNode
  /** Coluna de lista: largura fixa, sem alça (ver rail.css). */
  list?: boolean
  resizable?: boolean
  onResize?: ResizeHandlers
}): JSX.Element {
  return (
    <section
      className={list ? 'floating rail-col is-list' : 'floating rail-col'}
      role="region"
      aria-label={label}
    >
      <div className="rail-col-body">{children}</div>
      {resizable && onResize && (
        <div
          className="rail-resizer"
          onPointerDown={onResize.onPointerDown}
          onPointerMove={onResize.onPointerMove}
          onPointerUp={onResize.onPointerUp}
          onDoubleClick={onResize.resetWidth}
          title="Arraste para redimensionar · duplo clique para o padrão"
        />
      )}
    </section>
  )
}

/**
 * O detalhe do projeto escolhido, logo abaixo do item dele na lista recolhida.
 * Não é um painel novo — é o que faltava entre "escolhi um projeto" e "abri a
 * árvore dele".
 */
function ProjectSummary({
  project,
  onClose
}: {
  project: Project
  onClose: () => void
}): JSX.Element {
  // O branch vem do mesmo poller compartilhado do painel de git: um resumo
  // aberto não acrescenta um `git status` por ciclo (ver use-git.ts).
  const { status } = useGit(project.path)

  return (
    <div className="rail-summary">
      {/* Nome, caminho e descrição NÃO se repetem aqui: o item logo acima é a
          identidade do projeto, e a coluna recolhida o mantém à vista. O que
          sobra é o que só o detalhe tem — os fatos e o que fazer com eles. */}
      <dl className="rail-summary-facts">
        <div className="rail-summary-line">
          <dt>tipo</dt>
          <dd>{project.kind}</dd>
        </div>
        {status?.branch && (
          <div className="rail-summary-line">
            <dt>branch</dt>
            <dd>{status.branch}</dd>
          </div>
        )}
        {project.stack.length > 0 && (
          <div className="rail-summary-line">
            <dt>stack</dt>
            <dd>{project.stack.join(', ')}</dd>
          </div>
        )}
      </dl>

      <div className="rail-summary-actions">
        <button type="button" className="btn" onClick={() => store.requestRail('arquivos', project.id)}>
          Ver arquivos
        </button>
        <button type="button" className="btn" onClick={() => store.requestRail('git', project.id)}>
          Ver Git
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            onClose()
            const c = viewport.toCanvas({ x: viewport.width / 2, y: viewport.height / 2 })
            void store.addProjectToWorkspace(project.id, { x: c.x - 150, y: c.y - 210 })
          }}
        >
          Levar para o canvas
        </button>
      </div>
    </div>
  )
}
