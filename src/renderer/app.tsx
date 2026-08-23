import { useEffect, useState } from 'react'
import type { BootInfo } from '@shared/types'
import { CanvasView } from './canvas/canvas-view'
import { Sidebar } from './sidebar'
import { store, useStore } from './state/store'
import { Toolbar } from './toolbar'

export function App(): JSX.Element {
  const { loading, bootError, workspace } = useStore()
  const [boot, setBoot] = useState<BootInfo | null>(null)

  useEffect(() => {
    void store.load()
    void window.atelier.bootInfo().then(setBoot)

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

  if (loading) return <div className="boot-screen">carregando…</div>
  if (bootError) return <div className="boot-screen error">falha no boot: {bootError}</div>

  return (
    <div className="app-shell">
      <Sidebar />
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
    </div>
  )
}
