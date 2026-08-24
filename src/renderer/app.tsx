import { useEffect, useState } from 'react'
import type { BootInfo, TerminalDraft } from '@shared/types'
import { CanvasView } from './canvas/canvas-view'
import { viewport } from './canvas/viewport'
import { NewTerminalDialog } from './dialogs/new-terminal-dialog'
import { Sidebar } from './sidebar'
import { store, useStore } from './state/store'
import { Toolbar } from './toolbar'

export function App(): JSX.Element {
  const { loading, bootError, workspace, sidebarCollapsed, newTerminalOpen } = useStore()
  const [boot, setBoot] = useState<BootInfo | null>(null)

  useEffect(() => {
    void store.load()
    void window.atelier.bootInfo().then((info) => {
      setBoot(info)
      // Os semáforos do macOS ficam à esquerda e a toolbar precisa reservar
      // espaço para eles; no Windows/Linux os controles ficam à direita.
      document.documentElement.dataset.platform = info.platform
    })

    // O CLI pode alterar o canvas por fora (atelier note create, por exemplo)
    const offWorkspace = window.atelier.events.onWorkspaceChanged(() => void store.reload())
    const offStatus = window.atelier.events.onConnectionStatus(({ id, status }) => {
      store.setConnectionStatus(id, status as 'idle' | 'communicating' | 'error')
    })
    return () => {
      offWorkspace()
      offStatus()
    }
  }, [])

  /** Nasce centrado na viewport (560×360 é o tamanho que o main dá ao nó). */
  const createTerminal = (draft: TerminalDraft): void => {
    store.closeNewTerminal()
    const c = viewport.toCanvas({ x: viewport.width / 2, y: viewport.height / 2 })
    void store.createTerminal(draft, { x: c.x - 280, y: c.y - 180 })
  }

  if (loading) return <div className="boot-screen">carregando…</div>
  if (bootError) return <div className="boot-screen error">falha no boot: {bootError}</div>

  return (
    <div className="app-shell">
      {!sidebarCollapsed && <Sidebar />}
      <main className="main-pane">
        <Toolbar />
        {workspace ? <CanvasView /> : <div className="boot-screen">nenhum workspace aberto</div>}
        <footer className="status-bar">
          <span>{boot ? `IPC :${boot.serverPort}` : 'IPC —'}</span>
          <span>{boot?.socketPath}</span>
          <span>{boot?.dataDir}</span>
          {boot?.needsRecovery && <span className="warn">sessão anterior não encerrou corretamente</span>}
        </footer>
      </main>

      {newTerminalOpen && (
        <NewTerminalDialog
          defaultWorkingDirectory={workspace?.workingDirectory ?? ''}
          onCancel={() => store.closeNewTerminal()}
          onCreate={createTerminal}
        />
      )}
    </div>
  )
}
