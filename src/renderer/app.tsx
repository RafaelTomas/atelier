import { useEffect, useState } from 'react'
import type { BootInfo, ButtonConfig, TerminalDraft } from '@shared/types'
import { readButtonConfig } from '@shared/types'
import { CanvasView } from './canvas/canvas-view'
import { viewport } from './canvas/viewport'
import { ButtonDialog } from './dialogs/button-dialog'
import { NewTerminalDialog } from './dialogs/new-terminal-dialog'
import { ScanDialog } from './dialogs/scan-dialog'
import { ProjectCandidates } from './project-candidates'
import { CanvasChrome } from './canvas-chrome'
import { Rail } from './rail'
import { listenForPortalWake } from './state/portal-wake'
import { store, useStore } from './state/store'

export function App(): JSX.Element {
  const {
    loading,
    bootError,
    workspace,
    newTerminalOpen,
    newTerminalFrame,
    newTerminalCwd,
    editTerminalId,
    buttonDialog,
    scanDialogOpen,
    integrity,
    closingEditor
  } = useStore()
  const [boot, setBoot] = useState<BootInfo | null>(null)

  useEffect(() => {
    void store.load()
    void window.atelier.bootInfo().then((info) => {
      setBoot(info)
      // Os semáforos do macOS ficam à esquerda, sobre a página, e a faixa de
      // arrasto precisa reservar espaço para eles; no Windows/Linux a moldura
      // é nativa e a faixa não existe.
      document.documentElement.dataset.platform = info.platform
      // A store também precisa: é ela que decide as aspas ao colar um caminho
      // no terminal.
      store.setPlatform(info.platform)
    })

    // O CLI pode alterar o canvas por fora (atelier note create, por exemplo)
    const offWorkspace = window.atelier.events.onWorkspaceChanged(() => void store.reload())
    const offStatus = window.atelier.events.onConnectionStatus(({ id, status }) => {
      store.setConnectionStatus(id, status as 'idle' | 'communicating' | 'error')
    })
    const offUsage = window.atelier.terminal.onUsage(({ id, usage }) => {
      store.setTerminalUsage(id, usage)
    })
    const offStatus2 = window.atelier.terminal.onStatus(({ id, status }) => {
      store.setTerminalStatus(id, status)
    })
    // A varredura do boot roda uns segundos depois da janela abrir. Assinamos o
    // evento E perguntamos: o evento cobre o caso normal, a pergunta cobre um
    // F5 no renderer, que perderia o evento e deixaria o aviso sumido.
    const offCandidates = window.atelier.events.onProjectCandidates(({ candidates }) =>
      store.setCandidates(candidates)
    )
    void store.loadCandidates()
    // O agente no canvas edita o arquivo que está aberto no editor ao lado: o
    // main avisa que mudou, a store relê e entrega a quem tem o arquivo aberto.
    const offFile = window.atelier.fs.onFileChanged(({ path }) => {
      void store.notifyFileChanged(path)
    })
    // Agente pedindo para ler um portal que o zoom ou a virtualização
    // desmontou. A assinatura fica aqui, e não no nó: um nó desmontado não tem
    // como escutar o pedido para se montar.
    const offWake = listenForPortalWake()
    return () => {
      offWorkspace()
      offStatus()
      offStatus2()
      offUsage()
      offCandidates()
      offFile()
      offWake()
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

  /**
   * Botão novo nasce na área desenhada; sem área (edição, ou criação por outro
   * caminho), o diálogo só grava por cima do nó que já existe.
   */
  const submitButton = (config: ButtonConfig): void => {
    const dialog = buttonDialog
    if (!dialog) return
    if (dialog.nodeId) {
      void store.saveButton(dialog.nodeId, config)
      return
    }
    store.closeButtonDialog()
    const frame = dialog.frame ?? centeredButtonFrame()
    void store.addButton(frame, config)
  }

  const editingButton = buttonDialog?.nodeId
    ? workspace?.nodes.find((n) => n.id === buttonDialog.nodeId) ?? null
    : null
  const buttonDraft =
    editingButton && editingButton.content.type === 'widget'
      ? readButtonConfig(editingButton.content.value.view)
      : null

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
          assignedRoleId: editing.content.value.assignedRoleId,
          claudeAccountId: editing.content.value.claudeAccountId
        }
      : null

  if (loading) return <div className="boot-screen">carregando…</div>
  if (bootError) return <div className="boot-screen error">falha no boot: {bootError}</div>

  return (
    <div className="app-shell">
      <main className="main-pane">
        {/* Só no macOS, e só por CSS: a janela lá é `hiddenInset`, então sem uma
            faixa de arrasto os semáforos ficariam soltos sobre o canvas e a
            janela não se moveria. Nos outros sistemas a moldura nativa já faz
            isso e esta div tem altura zero. */}
        <div className="mac-drag-strip" />

        {integrity?.safeMode && <SafeModeBanner integrity={integrity} />}

        {/* A rail FLUTUA sobre o canvas, não divide a linha com ele: é o que
            dá o que borrar ao backdrop-filter — encostada, atrás dela só há a
            cor de fundo da janela e a translucidez não aparece. */}
        <div className="canvas-area">
          {workspace ? <CanvasView /> : <div className="boot-screen">nenhum workspace aberto</div>}
          <Rail />
          <CanvasChrome />
        </div>
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

      {buttonDialog && (
        <ButtonDialog
          key={buttonDialog.nodeId ?? 'novo'}
          initial={buttonDraft}
          defaultWorkingDirectory={workspace?.workingDirectory ?? ''}
          onCancel={() => store.closeButtonDialog()}
          onSubmit={submitButton}
        />
      )}

      {scanDialogOpen && <ScanDialog />}

      {closingEditor && <UnsavedEditorDialog />}

      <ProjectCandidates />
    </div>
  )
}

/** Botão criado sem área desenhada: 88×88 no meio do que está à vista. */
function centeredButtonFrame(): { x: number; y: number; width: number; height: number } {
  const c = viewport.toCanvas({ x: viewport.width / 2, y: viewport.height / 2 })
  return { x: c.x - 44, y: c.y - 44, width: 88, height: 88 }
}

/**
 * Modo seguro: o arquivo tem nós que este binário não entende.
 *
 * A faixa é visível e permanente de propósito. O caso que ela evita é o pior
 * tipo de bug de formato: o app abre normalmente, o autosave regrava o arquivo
 * sem os nós desconhecidos, e a perda é irreversível e invisível. Enquanto ela
 * estiver na tela, nada é gravado sem o usuário mandar.
 */
function SafeModeBanner({
  integrity
}: {
  integrity: { droppedNodes: number; fileSchemaVersion: number }
}): JSX.Element {
  const { droppedNodes, fileSchemaVersion } = integrity
  return (
    <div className="safe-mode-banner" role="alert">
      <span>
        {droppedNodes > 0
          ? `${droppedNodes} ${droppedNodes === 1 ? 'nó deste workspace não foi reconhecido' : 'nós deste workspace não foram reconhecidos'} — salvar apagaria ${droppedNodes === 1 ? 'ele' : 'eles'}.`
          : `este workspace foi gravado por uma versão mais nova (schema v${fileSchemaVersion}).`}{' '}
        O salvamento automático está desligado.
      </span>
      <button
        type="button"
        className="btn is-danger"
        title="Grava o workspace como está agora, descartando o que não foi reconhecido"
        onClick={() => void store.saveNow()}
      >
        Salvar assim mesmo
      </button>
    </div>
  )
}

/** Fechar um editor com alteração pendente pergunta antes de descartar. */
function UnsavedEditorDialog(): JSX.Element {
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) store.cancelCloseEditor()
      }}
    >
      <div className="modal is-compact" role="dialog" aria-label="Fechar editor">
        <h2 className="modal-title">Fechar sem salvar?</h2>
        <p className="trash-hint">
          Este editor tem alterações que não foram gravadas em disco. Fechar o nó descarta o que
          você digitou.
        </p>
        <div className="modal-footer">
          <button type="button" className="btn" onClick={() => store.cancelCloseEditor()}>
            Cancelar
          </button>
          <button
            type="button"
            className="btn is-danger"
            onClick={() => void store.confirmCloseEditor()}
          >
            Fechar sem salvar
          </button>
        </div>
      </div>
    </div>
  )
}
