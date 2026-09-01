/**
 * Os quatro primitivos de que a tela de Configurações inteira é feita.
 *
 * Existem antes dos grupos, e não junto com eles, porque o alinhamento é o
 * problema que uma tela de configurações tem de resolver UMA vez: se cada grupo
 * montar a própria linha, o rótulo da Aparência começa num x e o dos Terminais
 * noutro, e sete grupos viram sete telas. Aqui a geometria é uma só — rótulo e
 * dica à esquerda, controle à direita, alinhado ao topo da linha — e um grupo
 * novo herda isso sem escrever CSS.
 *
 * Nenhum deles guarda estado. `value` vem da store e `onChange` escreve nela;
 * é a regra da tela (ver o plano, decisão 1) e a razão de não haver OK nem
 * Cancelar em lugar nenhum.
 *
 * `SettingsRow` é o caso geral: quando o controle não é um interruptor nem uma
 * lista — um número, uma paleta, uma grade de amostras —, o grupo passa o
 * controle como filho e ganha o mesmo alinhamento dos outros.
 */
import { useId } from 'react'
import type { ReactNode } from 'react'

/**
 * Uma linha: rótulo (e dica) à esquerda, o que vier como filho à direita.
 *
 * `htmlFor` é opcional porque nem todo controle é um elemento único que aceita
 * rótulo — uma grade de botões não é. Quando ele vem, o `<label>` é de verdade
 * e clicar no texto foca o campo; quando não vem, o rótulo é um `<span>`, que é
 * honesto: um `<label>` sem destino não faz nada e ainda mente para o leitor de
 * tela.
 */
export function SettingsRow({
  label,
  hint,
  htmlFor,
  children
}: {
  label: string
  hint?: string
  /** id do controle, quando ele for um só e puder receber foco pelo rótulo. */
  htmlFor?: string
  children: ReactNode
}): JSX.Element {
  const text = (
    <>
      <span className="settings-row-label">{label}</span>
      {hint && <span className="settings-row-hint">{hint}</span>}
    </>
  )
  return (
    <div className="settings-row">
      {htmlFor ? (
        <label className="settings-row-text" htmlFor={htmlFor}>
          {text}
        </label>
      ) : (
        <span className="settings-row-text">{text}</span>
      )}
      <div className="settings-row-control">{children}</div>
    </div>
  )
}

/** Liga/desliga. Uma caixa de seleção, no mesmo lugar dos outros controles. */
export function SettingsToggle({
  label,
  hint,
  value,
  onChange,
  disabled = false
}: {
  label: string
  hint?: string
  value: boolean
  onChange: (value: boolean) => void
  disabled?: boolean
}): JSX.Element {
  const id = useId()
  return (
    <SettingsRow label={label} hint={hint} htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        className="settings-checkbox"
        checked={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
    </SettingsRow>
  )
}

/**
 * Escolha entre poucas opções, num `<select>` nativo.
 *
 * Genérico no tipo do valor: quem chama com uma união de literais (`ThemeMode`,
 * `RopeStyleId`) recebe o mesmo tipo de volta no `onChange`, sem cast. É o que
 * impede um grupo de gravar `'escuro'` numa chave que só aceita `'dark'`.
 */
export function SettingsSelect<T extends string>({
  label,
  hint,
  options,
  value,
  onChange,
  disabled = false
}: {
  label: string
  hint?: string
  options: readonly { value: T; label: string }[]
  value: T
  onChange: (value: T) => void
  disabled?: boolean
}): JSX.Element {
  const id = useId()
  return (
    <SettingsRow label={label} hint={hint} htmlFor={id}>
      <select
        id={id}
        className="settings-select"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as T)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </SettingsRow>
  )
}

/**
 * Um bloco de linhas com título.
 *
 * O título é o único texto em caixa alta da tela, e é de propósito: ele separa
 * sem desenhar uma caixa em volta, que é o que faria a coluna da direita virar
 * uma pilha de cartões dentro de um modal que já é um cartão.
 */
export function SettingsSection({
  title,
  children
}: {
  title: string
  children: ReactNode
}): JSX.Element {
  return (
    <section className="settings-section">
      <h3 className="settings-section-title">{title}</h3>
      <div className="settings-section-rows">{children}</div>
    </section>
  )
}
