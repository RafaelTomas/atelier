/**
 * Certificado inválido dentro de um Portal.
 *
 * Sem isto, o `<webview>` cai direto na tela nativa do Chromium ("sua conexão
 * não é particular") sem opção de prosseguir — o app não tem controle nenhum
 * sobre essa tela, e ela nem sempre aparece de um jeito que dá para sair.
 *
 * Escopo é só `webview` (Portal): `certificate-error` é um evento do `app`,
 * então vale para TODO webContents — inclusive a janela principal, que não
 * deve nunca aceitar um certificado ruim silenciosamente. Fora do webview, o
 * handler não faz nada e o Electron aplica o comportamento padrão (rejeitar).
 *
 * A escolha de confiar é por host+certificado, só durante esta sessão do app
 * (não persiste em disco) — perguntar de novo a cada imagem/XHR da mesma
 * página seria insuportável, mas reabrir o app deve voltar a perguntar.
 */
import { app, dialog } from 'electron'
import { log } from '../logger'

const trusted = new Set<string>()

export function armCertificateErrorHandling(): void {
  app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
    if (webContents.getType() !== 'webview') return

    let host: string
    try {
      host = new URL(url).host
    } catch {
      callback(false)
      return
    }

    const key = `${certificate.fingerprint}:${host}`
    if (trusted.has(key)) {
      event.preventDefault()
      callback(true)
      return
    }

    event.preventDefault()
    void dialog
      .showMessageBox({
        type: 'warning',
        buttons: ['Cancelar', 'Continuar mesmo assim'],
        defaultId: 0,
        cancelId: 0,
        title: 'Certificado não confiável',
        message: `O certificado de ${host} não pôde ser verificado (${error}).`,
        detail:
          'Continuar expõe a conexão a um possível ataque — só prossiga se você confia neste endereço. Vale só para esta sessão do app.'
      })
      .then(({ response }) => {
        const proceed = response === 1
        if (proceed) trusted.add(key)
        log.info('portal', `certificado de ${host} ${proceed ? 'aceito manualmente' : 'rejeitado'}`)
        callback(proceed)
      })
  })
}
