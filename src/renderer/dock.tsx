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
import type { Rect } from '@shared/types'
import {
  IconChevronDown,
  IconClip,
  IconCursor,
  IconDraw,
  IconFolder,
  IconGlobe,
  IconNote,
  IconTerminal,
  IconText
} from './icons'
import { HOME_URL } from './nodes/portal-node'
import { store, useStore } from './state/store'

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
  text: [80, 32]
}

interface MenuItem {
  id: string
  label: string
  hint?: string
  run: () => void
}

export function Dock(): JSX.Element {
  const { tool } = useStore()
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
    kind: 'terminal' | 'note' | 'text' | 'portal' | 'fileTree',
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
    kind: 'terminal' | 'note' | 'text' | 'portal' | 'fileTree',
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
        // Proporção de página em pé como padrão do clique seco.
        store.startPlacing({
          label: 'documento PDF',
          defaultSize: [560, 720],
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

  const FILE_MENU: MenuItem[] = [
    {
      id: 'tree',
      label: 'Árvore de arquivos',
      hint: 'a pasta do workspace',
      run: () => add('fileTree', [300, 420], {}, undefined, 'árvore de arquivos')
    },
    {
      id: 'tree-home',
      label: 'Árvore na home',
      hint: 'abre em ~',
      run: () => add('fileTree', [300, 420], { name: 'Home', rootPath: '~' }, undefined, 'árvore de arquivos')
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
    <div className="dock" ref={dockRef} onMouseDown={(e) => e.stopPropagation()}>
      <DockButton
        label="Selecionar"
        hint="V"
        active={tool === 'select'}
        onClick={() => {
          store.setTool('select')
          setOpenMenu(null)
        }}
      >
        <IconCursor />
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
      >
        <IconNote />
      </DockMenuButton>

      <DockButton
        label="Anexo"
        hint="desenhe a área; cola a área de transferência nela"
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

      <DockMenuButton
        label="Texto"
        items={TEXT_MENU}
        open={openMenu === 'text'}
        onToggle={() => setOpenMenu((v) => (v === 'text' ? null : 'text'))}
      >
        <IconText />
      </DockMenuButton>

      <span className="dock-sep" />

      <DockButton
        label="Desenhar"
        hint="clique no canvas para escolher o que fazer"
        active={tool !== 'select'}
        onClick={() => {
          setOpenMenu(null)
          store.setTool(tool === 'select' ? 'draw' : 'select')
        }}
      >
        <IconDraw />
      </DockButton>
    </div>
  )
}

/**
 * Cola o que estiver na área de transferência como nota (texto) — o "clipe"
 * da referência. Sem permissão de leitura, cria uma nota vazia em vez de
 * falhar em silêncio.
 */
async function pasteAttachment(frame: Rect): Promise<void> {
  let text = ''
  try {
    text = await navigator.clipboard.readText()
  } catch {
    // Sem permissão de leitura o clipboard rejeita; segue com nota vazia.
    text = ''
  }
  const position = { x: frame.x, y: frame.y }
  const size = { width: frame.width, height: frame.height }
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
  children: React.ReactNode
}

function DockMenuButton({ label, items, open, onToggle, children }: DockMenuButtonProps): JSX.Element {
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
        <div className="dock-menu" role="menu">
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
