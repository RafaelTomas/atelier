import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app'
import './styles.css'

// O amostrador de recursos do main é ref-contado, e uma recarga da janela (dev,
// ou um crash do renderer) leva embora os `unsubscribe` dos nós que estavam
// montados: sem este zerar, o timer sobreviveria rodando para ninguém.
window.atelier.system.reset()

const container = document.getElementById('root')
if (!container) throw new Error('#root não encontrado')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)
