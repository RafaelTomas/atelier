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
import { viewport } from './canvas/viewport'
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

/** Cria o nó no centro da viewport atual, descontando metade do tamanho. */
function centerFor(width: number, height: number): { x: number; y: number } {
  const c = viewport.toCanvas({ x: viewport.width / 2, y: viewport.height / 2 })
  return { x: c.x - width / 2, y: c.y - height / 2 }
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
   * Cria o nó e, se houver, aplica o patch de conteúdo depois — os `opts` do
   * IPC só cobrem name/url/rootPath/text; o resto (fontSize, cor, peso) é
   * campo de conteúdo e vai por patchContent.
   */
  const add = (
    kind: 'terminal' | 'note' | 'text' | 'portal' | 'fileTree',
    size: [number, number],
    opts: Record<string, unknown> = {},
    patch?: Record<string, unknown>
  ): void => {
    const [w, h] = size
    setOpenMenu(null)
    void store.addNode(kind, centerFor(w, h), opts).then((node) => {
      if (node && patch) void store.patchContent(node.id, patch)
    })
  }

  const NOTE_MENU: MenuItem[] = [
    {
      id: 'note',
      label: 'Nota adesiva',
      hint: 'amarela, o padrão',
      run: () => add('note', [240, 160])
    },
    {
      id: 'note-blue',
      label: 'Nota azul',
      hint: 'para separar assunto por cor',
      run: () => add('note', [240, 160], {}, { color: '#DCEBFF' })
    },
    {
      id: 'note-preview',
      label: 'Nota em markdown',
      hint: 'já aberta em modo preview',
      run: () => add('note', [280, 200], {}, { isPreviewing: true })
    },
    {
      id: 'doc',
      label: 'Documento',
      hint: 'texto longo, formatável',
      run: () => add('text', [420, 300])
    }
  ]

  const FILE_MENU: MenuItem[] = [
    {
      id: 'tree',
      label: 'Árvore de arquivos',
      hint: 'a pasta do workspace',
      run: () => add('fileTree', [300, 420])
    },
    {
      id: 'tree-home',
      label: 'Árvore na home',
      hint: 'abre em ~',
      run: () => add('fileTree', [300, 420], { name: 'Home', rootPath: '~' })
    }
  ]

  const TEXT_MENU: MenuItem[] = [
    {
      id: 'text',
      label: 'Bloco de texto',
      hint: 'parágrafo solto no canvas',
      run: () => add('text', [280, 60])
    },
    {
      id: 'heading',
      label: 'Título',
      hint: 'grande e em negrito, para rotular área',
      run: () => add('text', [360, 90], { text: 'Título' }, { fontSize: 32, fontWeight: 'bold' })
    },
    {
      id: 'caption',
      label: 'Legenda',
      hint: 'pequena e apagada',
      run: () => add('text', [240, 40], {}, { fontSize: 12, color: '#6b6b70' })
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
        hint="escolhe agente, aparência e responsabilidade"
        onClick={() => {
          setOpenMenu(null)
          store.openNewTerminal()
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
        hint="cola o conteúdo da área de transferência"
        onClick={() => void pasteAttachment()}
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
        onClick={() => add('portal', [640, 440], { url: HOME_URL, name: 'Portal' })}
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
async function pasteAttachment(): Promise<void> {
  let text = ''
  try {
    text = await navigator.clipboard.readText()
  } catch {
    // Sem permissão de leitura o clipboard rejeita; segue com nota vazia.
    text = ''
  }
  // Com conteúdo vira nó de texto (é o único cujo corpo é campo de conteúdo —
  // a nota adesiva guarda o texto em arquivo). Vazio, vira nota para escrever.
  if (text.trim()) void store.addNode('text', centerFor(360, 120), { text })
  else void store.addNode('note', centerFor(240, 160))
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
