/**
 * Dock flutuante do canvas.
 *
 * Pill ancorada na base, ícones outline, um item por ação — o padrão da
 * referência de design. Itens com mais de uma opção (nota, arquivo, texto,
 * desenho) abrem um menu suspenso ACIMA do botão; a dock fica na base, então
 * um menu para baixo sairia da janela.
 *
 * O que a dock NÃO faz: escolher a ferramenta de desenho. Clicar no ícone de
 * desenho só entra no modo 'draw'; quem decide o que fazer é o menu que abre
 * no ponto clicado dentro do canvas (ver canvas/draw-menu.tsx).
 */
import { useEffect, useRef, useState } from 'react'
import type { PlacementEdge, Rect } from '@shared/types'
import {
  IconChevronDown,
  IconClip,
  IconCursor,
  IconDraw,
  IconFolder,
  IconGlobe,
  IconGroup,
  IconHand,
  IconLock,
  IconNote,
  IconPlay,
  IconPulse,
  IconCheck,
  IconTerminal,
  IconText
} from './icons'
import { GROUP_MIN_HEIGHT, GROUP_MIN_WIDTH, rectContains } from './canvas/group-geometry'
import { rectCenter } from './canvas/viewport'
import { HOME_URL } from './nodes/portal-node'
import { truncateStart } from './paths'
import { PlacementTargets } from './floating/placement-targets'
import { PillMenu } from './floating/pill-menu'
import { usePill } from './floating/use-pill'
import { store, useStore } from './state/store'
import { PDF_NODE_SIZE } from './pdf-viewer'

/**
 * Piso por tipo, em pontos de canvas. Mora aqui, e não só no processo
 * principal, porque é durante o arrasto que ele precisa aparecer: o retângulo
 * para de encolher e o usuário vê o tamanho que vai receber de fato.
 */
const MIN_SIZE: Record<string, [number, number]> = {
  terminal: [200, 100],
  note: [120, 80],
  portal: [240, 180],
  fileTree: [180, 140],
  secretVault: [220, 140],
  text: [80, 32],
  // Espelha Constants.buttonMin* — o main aplica o mesmo piso ao criar.
  button: [56, 56],
  // Espelha Constants.widgetMin*: o monitor nasce menor que o painel padrão,
  // mas o PISO continua o do widget — abaixo disso o bloco IA não cabe.
  widget: [240, 180]
}

interface MenuItem {
  id: string
  label: string
  hint?: string
  run: () => void
}

export function Dock(): JSX.Element {
  const { tool, workspace } = useStore()
  // Arrastar, menu de contexto e troca de borda: o mesmo comportamento da rail,
  // e por isso num hook compartilhado em vez de duplicado nas duas.
  const pill = usePill('dock')
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const dockRef = useRef<HTMLDivElement>(null)

  // Fecha em clique fora e no Esc. mousedown (não click) para o menu sumir
  // antes de o canvas processar o arrasto embaixo dele.
  useEffect(() => {
    if (!openMenu) return
    const onDown = (e: MouseEvent): void => {
      if (!dockRef.current?.contains(e.target as Node)) setOpenMenu(null)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpenMenu(null)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [openMenu])

  /**
   * Cria o nó na área pedida e, se houver, aplica o patch de conteúdo depois —
   * os `opts` do IPC só cobrem name/url/rootPath/text; o resto (fontSize, cor,
   * peso) é campo de conteúdo e vai por patchContent.
   */
  const create = (
    kind: 'terminal' | 'note' | 'text' | 'portal' | 'fileTree' | 'secretVault' | 'widget',
    frame: Rect,
    opts: Record<string, unknown> = {},
    patch?: Record<string, unknown>
  ): void => {
    const size = { width: frame.width, height: frame.height }
    void store.addNode(kind, { x: frame.x, y: frame.y }, opts, size).then((node) => {
      if (node && patch) void store.patchContent(node.id, patch)
    })
  }

  /**
   * Nada nasce no clique do menu: o item arma o modo "desenhe a área" e quem
   * decide o lugar e o tamanho é o arrasto seguinte no canvas. Clique seco no
   * canvas vale como "tamanho padrão aqui" (ver CLICK_SLOP no canvas-view).
   */
  const add = (
    kind: 'terminal' | 'note' | 'text' | 'portal' | 'fileTree' | 'secretVault' | 'widget',
    size: [number, number],
    opts: Record<string, unknown> = {},
    patch?: Record<string, unknown>,
    label = 'componente'
  ): void => {
    setOpenMenu(null)
    store.startPlacing({
      label,
      defaultSize: size,
      minSize: MIN_SIZE[kind],
      finish: (frame) => create(kind, frame, opts, patch)
    })
  }

  /**
   * A home vem resolvida do main: passar '~' aqui não funciona, porque o
   * rootPath do nó vai cru para o fs e ninguém expande til nesse caminho.
   */
  const openHomeTree = async (): Promise<void> => {
    const { homeDir } = await window.atelier.bootInfo()
    add('fileTree', [300, 420], { name: 'Home', rootPath: homeDir }, undefined, 'árvore de arquivos')
  }

  const NOTE_MENU: MenuItem[] = [
    {
      id: 'note',
      label: 'Nota adesiva',
      hint: 'amarela, o padrão',
      run: () => add('note', [240, 160], {}, undefined, 'nota')
    },
    {
      id: 'note-blue',
      label: 'Nota azul',
      hint: 'para separar assunto por cor',
      run: () => add('note', [240, 160], {}, { color: '#DCEBFF' }, 'nota')
    },
    {
      id: 'note-preview',
      label: 'Nota em markdown',
      hint: 'já aberta em modo preview',
      run: () => add('note', [280, 200], {}, { isPreviewing: true }, 'nota')
    },
    {
      id: 'doc',
      label: 'Documento',
      hint: 'texto longo, formatável',
      run: () => add('text', [420, 300], {}, undefined, 'documento')
    },
    {
      id: 'pdf',
      label: 'Documento PDF',
      hint: 'abre um arquivo e renderiza no canvas',
      run: () => {
        setOpenMenu(null)
        // Página em pé, e estreita o bastante para o visor do Chromium não
        // abrir a barra de miniaturas — ver pdf-viewer.ts.
        store.startPlacing({
          label: 'documento PDF',
          defaultSize: PDF_NODE_SIZE,
          minSize: MIN_SIZE.portal,
          finish: (frame) => void openPDF(frame)
        })
      }
    }
  ]

  /**
   * PDF vira um nó Portal apontando para `file://`: quem renderiza é o
   * visualizador embutido do Chromium, dentro do mesmo <webview> do navegador.
   * Não inventamos um nono tipo de nó — o formato em disco tem oito, e um tipo
   * novo quebraria o round-trip com o app nativo.
   */
  const openPDF = async (frame: Rect): Promise<void> => {
    // A ponte pode ser mais velha que este código (dev sem reiniciar): sem esta
    // checagem o clique não abriria nada e não diria por quê.
    const picker = window.atelier.dialog.chooseFile
    if (typeof picker !== 'function') {
      store.showNotice('seletor de arquivo indisponível — reinicie o app (npm run dev)')
      return
    }

    let chosen: { path: string; url: string } | null = null
    try {
      chosen = await picker([{ name: 'PDF', extensions: ['pdf'] }])
    } catch (err) {
      store.showNotice(`não foi possível abrir o seletor: ${(err as Error).message}`)
      return
    }
    if (!chosen) return
    const name = chosen.path.split(/[\\/]/).pop() || 'Documento'
    // `chromeHidden` tira a barra de endereço, que num documento local não
    // serve para nada — o visor de PDF traz os controles dele.
    create('portal', frame, { url: chosen.url, name }, { chromeHidden: true })
  }

  /**
   * A pasta vem do seletor do sistema, DEPOIS da área — o mesmo compasso do
   * Documento PDF.
   *
   * O item que existia aqui prometia "a pasta do workspace" e não passava
   * rootPath nenhum: o nó nascia vazio, com a mensagem de "nenhuma pasta
   * definida", e não havia como consertá-lo a não ser apagando. Escolher a
   * pasta é o que o item sempre deveria ter feito.
   */
  const openPickedTree = async (frame: Rect): Promise<void> => {
    const picker = window.atelier.dialog.chooseDirectory
    if (typeof picker !== 'function') {
      store.showNotice('seletor de pasta indisponível — reinicie o app (npm run dev)')
      return
    }
    let chosen: string | null = null
    try {
      chosen = await picker(workspace?.workingDirectory || undefined)
    } catch (err) {
      store.showNotice(`não foi possível abrir o seletor: ${(err as Error).message}`)
      return
    }
    if (!chosen) return // cancelou: nada de nó vazio
    create('fileTree', frame, { name: folderName(chosen), rootPath: chosen })
  }

  const FILE_MENU: MenuItem[] = [
    {
      id: 'tree-pick',
      label: 'Escolher pasta…',
      hint: 'abre o seletor do sistema',
      run: () => {
        setOpenMenu(null)
        store.startPlacing({
          label: 'árvore de arquivos',
          defaultSize: [300, 420],
          minSize: MIN_SIZE.fileTree,
          finish: (frame) => void openPickedTree(frame)
        })
      }
    },
    // Só aparece quando há diretório de trabalho: sem ele o item criaria
    // exatamente o nó vazio que este conserto veio eliminar.
    ...(workspace?.workingDirectory
      ? [
          {
            id: 'tree-ws',
            label: 'Pasta do workspace',
            hint: truncateStart(workspace.workingDirectory, 26),
            run: () =>
              add(
                'fileTree',
                [300, 420],
                {
                  name: folderName(workspace.workingDirectory),
                  rootPath: workspace.workingDirectory
                },
                undefined,
                'árvore de arquivos'
              )
          }
        ]
      : []),
    {
      id: 'tree-home',
      label: 'Árvore na home',
      hint: 'abre na sua pasta pessoal',
      run: () => void openHomeTree()
    }
  ]

  const TEXT_MENU: MenuItem[] = [
    {
      id: 'text',
      label: 'Bloco de texto',
      hint: 'parágrafo solto no canvas',
      run: () => add('text', [280, 60], {}, undefined, 'bloco de texto')
    },
    {
      id: 'heading',
      label: 'Título',
      hint: 'grande e em negrito, para rotular área',
      run: () => add('text', [360, 90], { text: 'Título' }, { fontSize: 32, fontWeight: 'bold' }, 'título')
    },
    {
      id: 'caption',
      label: 'Legenda',
      hint: 'pequena e apagada',
      run: () => add('text', [240, 40], {}, { fontSize: 12, color: '#6b6b70' }, 'legenda')
    }
  ]

  return (
    <>
    {/* Os alvos só existem durante o gesto: fora dele são quatro retângulos
        pintados sobre o canvas sem motivo. */}
    {pill.dragging && <PlacementTargets hot={pill.hot} />}
    <div
      className={pill.dragging ? 'floating pill dock is-dragging' : 'floating pill dock'}
      data-edge={pill.placement.edge}
      // A posição AO LONGO da borda é contínua: vai por CSS var, não por um
      // atributo de três valores (ver styles/floating.css).
      style={{ '--pill-offset': String(pill.placement.offset) } as React.CSSProperties}
      ref={dockRef}
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={pill.onPointerDown}
      onContextMenu={pill.onContextMenu}
    >
      {/* Um botão, dois modos: ponteiro seleciona, mão move o quadro. Clicar
          de novo volta ao ponteiro — o ícone é o que diz em qual dos dois se
          está, então ele troca junto. */}
      <DockButton
        label={tool === 'pan' ? 'Mover o canvas' : 'Selecionar'}
        hint={tool === 'pan' ? 'clique para voltar a selecionar' : 'clique para mover o canvas'}
        active={tool === 'select' || tool === 'pan'}
        onClick={() => {
          store.setTool(tool === 'pan' ? 'select' : 'pan')
          setOpenMenu(null)
        }}
      >
        {tool === 'pan' ? <IconHand /> : <IconCursor />}
      </DockButton>

      <span className="dock-sep" />

      <DockButton
        label="Terminal"
        hint="desenhe a área; o diálogo abre em seguida"
        onClick={() => {
          setOpenMenu(null)
          store.startPlacing({
            label: 'terminal',
            defaultSize: [560, 360],
            minSize: MIN_SIZE.terminal,
            finish: (frame) => store.openNewTerminal(frame)
          })
        }}
      >
        <IconTerminal />
      </DockButton>

      <DockMenuButton
        label="Nota"
        items={NOTE_MENU}
        open={openMenu === 'note'}
        onToggle={() => setOpenMenu((v) => (v === 'note' ? null : 'note'))}
        edge={pill.placement.edge}
      >
        <IconNote />
      </DockMenuButton>

      <DockButton
        label="Anexo"
        hint="desenhe a área; cola imagem ou texto da área de transferência"
        onClick={() => {
          setOpenMenu(null)
          store.startPlacing({
            label: 'anexo',
            defaultSize: [360, 120],
            minSize: MIN_SIZE.text,
            finish: (frame) => void pasteAttachment(frame)
          })
        }}
      >
        <IconClip />
      </DockButton>

      <DockMenuButton
        label="Arquivos"
        items={FILE_MENU}
        open={openMenu === 'files'}
        onToggle={() => setOpenMenu((v) => (v === 'files' ? null : 'files'))}
        edge={pill.placement.edge}
      >
        <IconFolder />
      </DockMenuButton>

      <DockButton
        label="Navegador"
        onClick={() =>
          add('portal', [640, 440], { url: HOME_URL, name: 'Portal' }, undefined, 'navegador')
        }
      >
        <IconGlobe />
      </DockButton>

      {/* Ao lado do navegador de propósito: o cofre existe, entre outras coisas,
          para o portal poder logar sem o segredo passar pelo agente. */}
      <DockButton
        label="Cofre"
        hint="guarda segredos cifrados; ligue por cabo a um terminal ou portal"
        onClick={() => add('secretVault', [320, 280], { name: 'Cofre' }, undefined, 'cofre')}
      >
        <IconLock />
      </DockButton>

      {/* Ao lado do cofre e do botão, e não na cascata da rail com Git e
          Projetos: aqueles pedem um projeto escolhido antes de terem o que
          mostrar, e o monitor mede a MÁQUINA — não depende de nada. */}
      {/* Ao lado do Monitor: os dois são painéis que o AGENTE alimenta, e
          nenhum dos dois depende de um projeto selecionado. */}
      <DockButton
        label="TODO"
        hint="quadro de trabalho — o agente move os cartões enquanto trabalha"
        onClick={() =>
          add(
            'widget',
            [560, 380],
            // O nome do ARQUIVO nasce aqui: o quadro vive em
            // `todos/<file>.json`, e sem ele o painel não teria onde gravar. O
            // arquivo em si só passa a existir no primeiro cartão — um quadro
            // vazio não tem nada a persistir.
            { kind: 'todo', view: { title: 'TODO', mode: 'kanban', file: crypto.randomUUID() } },
            undefined,
            'quadro de TODO'
          )
        }
      >
        <IconCheck />
      </DockButton>

      <DockButton
        label="Monitor"
        hint="CPU, memória, disco e o uso dos agentes deste canvas"
        onClick={() =>
          add('widget', [340, 300], { kind: 'monitor' }, undefined, 'monitor de recursos')
        }
      >
        <IconPulse />
      </DockButton>

      <DockButton
        label="Botão"
        hint="desenhe a área; o diálogo abre em seguida"
        onClick={() => {
          setOpenMenu(null)
          // Como o Terminal: o diálogo abre DEPOIS da área, e o botão nasce
          // configurado — nunca vazio. Cancelar não cria nó nenhum.
          store.startPlacing({
            label: 'botão',
            defaultSize: [88, 88],
            minSize: MIN_SIZE.button,
            finish: (frame) => store.openButtonDialog(null, frame)
          })
        }}
      >
        <IconPlay />
      </DockButton>

      <DockMenuButton
        label="Texto"
        items={TEXT_MENU}
        open={openMenu === 'text'}
        onToggle={() => setOpenMenu((v) => (v === 'text' ? null : 'text'))}
        edge={pill.placement.edge}
      >
        <IconText />
      </DockMenuButton>

      {/* Grupo não passa por `add`: ele não cria nó nenhum. Desenha a moldura
          e ADOTA quem já estava dentro dela — o gesto de organizar o que existe,
          não o de acrescentar mais uma coisa ao canvas. */}
      <DockButton
        label="Grupo"
        hint="desenhe a moldura em volta do que quer agrupar"
        onClick={() => {
          setOpenMenu(null)
          store.startPlacing({
            label: 'grupo',
            defaultSize: [520, 380],
            minSize: [GROUP_MIN_WIDTH, GROUP_MIN_HEIGHT],
            finish: (frame) => void createGroupIn(frame)
          })
        }}
      >
        <IconGroup />
      </DockButton>

      <span className="dock-sep" />

      <DockButton
        label="Desenhar"
        hint="clique no canvas para escolher o que fazer"
        active={tool !== 'select' && tool !== 'pan'}
        onClick={() => {
          setOpenMenu(null)
          // 'pan' conta como "não estou desenhando": vindo da mão, o clique
          // entra no modo desenho em vez de cair no toggle de volta.
          const drawing = tool !== 'select' && tool !== 'pan'
          store.setTool(drawing ? 'select' : 'draw')
        }}
      >
        <IconDraw />
      </DockButton>
    </div>

    {pill.menu && (
      <PillMenu
        x={pill.menu.x}
        y={pill.menu.y}
        current={pill.placement}
        fallback={pill.fallback}
        onPick={pill.apply}
        onClose={pill.closeMenu}
      />
    )}
    </>
  )
}

/**
 * A moldura desenhada adota quem estiver DENTRO dela — pelo centro do nó, a
 * mesma regra do arrasto (ver groupAt). Nós já pertencentes a outro grupo
 * trocam de dono: o main faz valer a regra de um dono por nó.
 */
async function createGroupIn(frame: Rect): Promise<void> {
  const inside = store
    .getSnapshot()
    .workspace?.nodes.filter((n) => rectContains(frame, rectCenter(n.frame)))
  await store.createGroup('Grupo', frame, (inside ?? []).map((n) => n.id))
}

/**
 * Cola o que estiver na área de transferência — o "clipe" da referência.
 * Imagem vira nó de imagem; texto vira nó de texto; vazio (ou sem permissão de
 * leitura) vira uma nota para escrever, em vez de falhar em silêncio.
 */
async function pasteAttachment(frame: Rect): Promise<void> {
  const position = { x: frame.x, y: frame.y }
  const size = { width: frame.width, height: frame.height }

  // Imagem primeiro: `clipboard.read()` dá os tipos disponíveis; se houver um
  // `image/*`, o nó de imagem cuida da própria proporção e ignora o `frame`.
  try {
    const items = await navigator.clipboard.read()
    for (const item of items) {
      const type = item.types.find((t) => t.startsWith('image/'))
      if (type) {
        const blob = await item.getType(type)
        void store.addImageFromBlob(blob, position)
        return
      }
    }
  } catch {
    /* sem permissão ou API indisponível — cai no texto */
  }

  let text = ''
  try {
    text = await navigator.clipboard.readText()
  } catch {
    text = ''
  }
  // Com conteúdo vira nó de texto (é o único cujo corpo é campo de conteúdo —
  // a nota adesiva guarda o texto em arquivo). Vazio, vira nota para escrever.
  if (text.trim()) void store.addNode('text', position, { text }, size)
  else void store.addNode('note', position, {}, size)
}

interface DockButtonProps {
  label: string
  hint?: string
  active?: boolean
  onClick: () => void
  children: React.ReactNode
}

function DockButton({ label, hint, active, onClick, children }: DockButtonProps): JSX.Element {
  return (
    <button
      type="button"
      className={active ? 'dock-btn is-active' : 'dock-btn'}
      title={hint ? `${label} · ${hint}` : label}
      aria-label={label}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

interface DockMenuButtonProps {
  label: string
  items: MenuItem[]
  open: boolean
  onToggle: () => void
  /**
   * Borda em que a dock está. O menu abre para o lado do CANVAS — com a dock na
   * base ele sobe, no topo desce, e nas verticais sai de lado. A regra é uma por
   * borda e mora no CSS (`.dock-menu[data-edge]`); o componente só a informa.
   */
  edge: PlacementEdge
  children: React.ReactNode
}

function DockMenuButton({
  label,
  items,
  open,
  onToggle,
  edge,
  children
}: DockMenuButtonProps): JSX.Element {
  return (
    <div className="dock-item">
      <button
        type="button"
        className={open ? 'dock-btn has-menu is-open' : 'dock-btn has-menu'}
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={onToggle}
      >
        {children}
        <span className="dock-caret">
          <IconChevronDown />
        </span>
      </button>

      {open && (
        <div className="dock-menu" role="menu" data-edge={edge}>
          <div className="dock-menu-title">{label}</div>
          {items.map((item) => (
            <button key={item.id} type="button" role="menuitem" onClick={item.run}>
              <span className="dock-menu-label">{item.label}</span>
              {item.hint && <span className="dock-menu-hint">{item.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Último componente do caminho — vira o nome do nó. */
function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || 'Arquivos'
}
