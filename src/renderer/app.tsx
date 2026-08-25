import { useEffect, useState } from 'react'
import type { BootInfo, TerminalDraft } from '@shared/types'
import { CanvasView } from './canvas/canvas-view'
import { viewport } from './canvas/viewport'
import { NewTerminalDialog } from './dialogs/new-terminal-dialog'
import { ScanDialog } from './dialogs/scan-dialog'
import { Sidebar } from './sidebar'
import { store, useStore } from './state/store'
import { Toolbar } from './toolbar'

export function App(): JSX.Element {
  const {
    loading,
    bootError,
    workspace,
    sidebarCollapsed,
    newTerminalOpen,
    newTerminalFrame,
    newTerminalCwd,
    editTerminalId,
    scanDialogOpen
  } = useStore()
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
    const offStatus2 = window.atelier.terminal.onStatus(({ id, status }) => {
      store.setTerminalStatus(id, status)
    })
    return () => {
      offWorkspace()
      offStatus()
      offStatus2()
    }
  }, [])

  /**
   * Nasce na área que o usuário desenhou antes de abrir o diálogo. Sem área
   * (criação por outro caminho), cai no centro da viewport.
   */
  const createTerminal = (draft: TerminalDraft): void => {
    const frame = newTerminalFrame
    store.closeNewTerminal()
    if (frame) {
      void store.createTerminal(draft, { x: frame.x, y: frame.y }, {
        width: frame.width,
        height: frame.height
      })
      return
    }
    const c = viewport.toCanvas({ x: viewport.width / 2, y: viewport.height / 2 })
    void store.createTerminal(draft, { x: c.x - 280, y: c.y - 180 })
  }

  /** Nó em edição → rascunho com o que já está gravado nele. */
  const editing = workspace?.nodes.find((n) => n.id === editTerminalId) ?? null
  const editDraft: TerminalDraft | null =
    editing && editing.content.type === 'terminal'
      ? {
          name: editing.content.value.name,
          command: editing.content.value.command,
          agentType: editing.content.value.agentType,
          workingDirectory: editing.content.value.workingDirectory,
          icon: editing.content.value.icon,
          color: editing.content.value.color,
          monitorWithOmbro: editing.content.value.monitorWithOmbro,
          isManager: editing.content.value.isManager,
          themeId: editing.content.value.themeId,
          fontFamily: editing.content.value.fontFamily,
          fontSize: editing.content.value.fontSize,
          assignedRoleId: editing.content.value.assignedRoleId
        }
      : null

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
          // O projeto escolhido no painel manda no cwd; sem ele, o do workspace.
          defaultWorkingDirectory={newTerminalCwd ?? workspace?.workingDirectory ?? ''}
          onCancel={() => store.closeNewTerminal()}
          onCreate={createTerminal}
        />
      )}

      {editDraft && editTerminalId && (
        <NewTerminalDialog
          key={editTerminalId}
          defaultWorkingDirectory={workspace?.workingDirectory ?? ''}
          initial={editDraft}
          onCancel={() => store.closeEditTerminal()}
          onCreate={(draft) => void store.saveTerminal(editTerminalId, draft)}
        />
      )}

      {scanDialogOpen && <ScanDialog />}
    </div>
  )
}
