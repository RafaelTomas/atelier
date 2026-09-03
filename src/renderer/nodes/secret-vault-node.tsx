/**
 * Nó Cofre — a lista de NOMES de chave de um `.vault` cifrado.
 *
 * A regra que organiza este arquivo inteiro: nenhum valor de segredo vive aqui.
 * A lista vem de `vault:list-keys`, que só devolve nomes; o único valor que
 * atravessa a ponte é o de `vault:reveal`, e ele vive só num estado que o timer
 * de 10s apaga — nunca em `localStorage`, nunca no conteúdo do nó, nunca num
 * `ref` que sobreviva ao contador. *Copiar* nem por esse estado passa: o valor
 * vai da ponte direto ao clipboard.
 *
 * Estado bloqueado: sem chaveiro do SO o `safeStorage` não decifra nada, e o
 * corpo mostra só isso. É o comportamento correto, não uma falha a contornar —
 * o Atelier recusa gravar em claro.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CanvasNode, SecretVaultContent, SecretVaultKeyRef, UUID } from '@shared/types'
import { VAULT_ROTATE_AFTER_DAYS, rotationReason } from '@shared/vault'
import {
  IconCheck,
  IconChevronDown,
  IconCopy,
  IconEye,
  IconEyeOff,
  IconLock,
  IconPencil,
  IconPlus,
  IconRotateKey,
  IconTrash
} from '../icons'

interface Props {
  node: CanvasNode
  content: SecretVaultContent
  workspaceId: UUID
}

/** Quanto tempo o valor revelado fica na tela antes de sumir sozinho. */
const REVEAL_MS = 10_000

export function SecretVaultNode({ node, content, workspaceId }: Props): JSX.Element {
  const [keys, setKeys] = useState<SecretVaultKeyRef[]>(content.keys)
  const [locked, setLocked] = useState(content.locked)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  // Qual chave está aberta em edição. Uma por vez, e nunca junto do formulário
  // de criar: duas fichas abertas no mesmo nó estreito não se distinguem.
  const [editing, setEditing] = useState<string | null>(null)
  const [revealed, setRevealed] = useState<{ key: string; value: string } | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const revealTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const apply = useCallback((result: { keys: SecretVaultKeyRef[] } | { error: string }): void => {
    if ('keys' in result) {
      setKeys(result.keys)
      setLocked(false)
      setError(null)
      return
    }
    if (result.error === 'locked') setLocked(true)
    else setError(result.error)
  }, [])

  useEffect(() => {
    let alive = true
    void window.atelier.vault.listKeys(workspaceId, node.id).then((r) => {
      if (alive) apply(r)
    })
    return () => {
      alive = false
    }
  }, [workspaceId, node.id, apply])

  // Chave criada por um agente (`atelier vault set`) aparece sem remontar o nó.
  // O evento não traz chave nenhuma — ele só diz "releia", e quem lê é o mesmo
  // canal de sempre, que devolve nomes.
  useEffect(
    () =>
      window.atelier.vault.onChanged((p) => {
        if (p.workspaceId !== workspaceId || p.nodeId !== node.id) return
        void window.atelier.vault.listKeys(workspaceId, node.id).then(apply)
      }),
    [workspaceId, node.id, apply]
  )

  // O valor revelado morre com o nó: desmontar por culling do canvas não pode
  // deixar um timer pendurado segurando um segredo.
  useEffect(
    () => () => {
      if (revealTimer.current) clearTimeout(revealTimer.current)
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
    },
    []
  )

  /** O mesmo botão esconde de volta: revelar é um estado, não um disparo. */
  const reveal = async (key: string): Promise<void> => {
    if (revealed?.key === key) {
      if (revealTimer.current) clearTimeout(revealTimer.current)
      setRevealed(null)
      return
    }
    const result = await window.atelier.vault.reveal(workspaceId, node.id, key)
    if ('error' in result) {
      setError(result.error === 'locked' ? 'cofre bloqueado' : result.error)
      return
    }
    setError(null)
    setRevealed({ key, value: result.value })
    if (revealTimer.current) clearTimeout(revealTimer.current)
    revealTimer.current = setTimeout(() => setRevealed(null), REVEAL_MS)
  }

  /** Copiar não passa pelo estado: o valor vai da ponte direto para o clipboard. */
  const copy = async (key: string): Promise<void> => {
    const result = await window.atelier.vault.reveal(workspaceId, node.id, key)
    if ('error' in result) {
      setError(result.error === 'locked' ? 'cofre bloqueado' : result.error)
      return
    }
    await navigator.clipboard.writeText(result.value)
    setError(null)
    setCopied(key)
    if (copiedTimer.current) clearTimeout(copiedTimer.current)
    copiedTimer.current = setTimeout(() => setCopied(null), 1400)
  }

  const remove = async (key: string): Promise<void> => {
    if (revealed?.key === key) setRevealed(null)
    if (editing === key) setEditing(null)
    apply(await window.atelier.vault.remove(workspaceId, node.id, key))
  }

  /** Abrir a ficha fecha o que estiver revelado: o valor não fica atrás do form. */
  const edit = (key: string): void => {
    setEditing((current) => (current === key ? null : key))
    if (revealTimer.current) clearTimeout(revealTimer.current)
    setRevealed(null)
    setAdding(false)
  }

  const save = async (input: KeyInput): Promise<void> => {
    const result = await window.atelier.vault.set(workspaceId, node.id, input)
    apply(result)
    if ('keys' in result) {
      setAdding(false)
      setEditing(null)
    }
  }

  if (locked) {
    return (
      <div className="secret-vault is-locked" data-node-interactive>
        <span className="secret-vault-locked-mark">
          <IconLock size={22} />
        </span>
        <p className="secret-vault-locked">cofre ilegível neste sistema</p>
        <p className="secret-vault-locked-why">chaveiro do SO ausente</p>
      </div>
    )
  }

  return (
    <div className="secret-vault" data-node-interactive onMouseDown={(e) => e.stopPropagation()}>
      <div className="secret-vault-bar">
        {/* O cadeado é a assinatura do nó dentro do corpo: o nome "Cofre" mora
            no cabeçalho da casca, e sem ele esta faixa seria a de qualquer
            lista da casa. */}
        <span className="secret-vault-title">
          <span className="secret-vault-mark">
            <IconLock size={11} />
          </span>
          chaves<span className="panel-count">{keys.length}</span>
        </span>
        <button
          type="button"
          className={
            adding ? 'icon-btn ghost-btn secret-vault-add is-open' : 'icon-btn ghost-btn secret-vault-add'
          }
          title={adding ? 'Fechar' : 'Adicionar chave'}
          onClick={() => {
            setAdding((v) => !v)
            setEditing(null)
          }}
        >
          <IconPlus size={13} />
        </button>
      </div>

      {error && <p className="secret-vault-error">{error}</p>}

      {adding && (
        <KeyForm onCancel={() => setAdding(false)} onSubmit={save} />
      )}

      {keys.length === 0 && !adding && (
        <div className="secret-vault-empty">
          <p>nenhuma chave guardada aqui</p>
          <p className="secret-vault-empty-hint">＋ grave a primeira</p>
        </div>
      )}

      <ul className="secret-vault-list">
        {keys.map((entry) => {
          const isOpen = revealed?.key === entry.key
          const isEditing = editing === entry.key
          // Em edição o item VIRA a ficha: manter a linha da chave por cima
          // duplicaria o nome e as ações a dois centímetros do formulário que
          // já as governa.
          if (isEditing) {
            return (
              <li key={entry.key} className="secret-vault-item is-editing">
                <KeyForm entry={entry} onCancel={() => setEditing(null)} onSubmit={save} />
              </li>
            )
          }
          return (
            <li
              key={entry.key}
              className={isOpen ? 'secret-vault-item is-revealed' : 'secret-vault-item'}
            >
              <div className="secret-vault-item-top">
                <span className="secret-vault-key" title={entry.note ?? undefined}>
                  {entry.key}
                </span>
                {/* A tarja fica COLADA no nome, e não numa linha própria: ela
                    só diz "existe e está coberto", e repetida em dez chaves
                    uma linha inteira de bolinhas gastava metade da altura do
                    nó dizendo dez vezes a mesma coisa. */}
                {!isOpen && <span className="secret-vault-mask">••••</span>}
                {/* A marca de troca fica colada no nome, antes de tudo o que é
                    opcional: ela não descreve a chave, ela pede uma ação. */}
                <RotateMark entry={entry} />
                {entry.inEnv && (
                  <span
                    className="secret-vault-badge"
                    title="Entra no ambiente dos terminais ligados"
                  >
                    env
                  </span>
                )}
                <span className="secret-vault-actions">
                  <button
                    type="button"
                    className={isOpen ? 'icon-btn ghost-btn is-active' : 'icon-btn ghost-btn'}
                    title={isOpen ? 'Esconder' : 'Revelar por 10s'}
                    onClick={() => void reveal(entry.key)}
                  >
                    {isOpen ? <IconEyeOff size={14} /> : <IconEye size={14} />}
                  </button>
                  <button
                    type="button"
                    className={
                      copied === entry.key ? 'icon-btn ghost-btn is-copied' : 'icon-btn ghost-btn'
                    }
                    title="Copiar valor"
                    onClick={() => void copy(entry.key)}
                  >
                    {copied === entry.key ? <IconCheck size={14} /> : <IconCopy size={14} />}
                  </button>
                  <button
                    type="button"
                    className="icon-btn ghost-btn"
                    title="Editar chave"
                    onClick={() => edit(entry.key)}
                  >
                    <IconPencil size={14} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn ghost-btn is-danger"
                    title="Apagar chave"
                    onClick={() => void remove(entry.key)}
                  >
                    <IconTrash size={14} />
                  </button>
                </span>
              </div>

              {/* A origem só ocupa uma linha quando existe, como a descrição de um
                  projeto. Sem origem a chave não é digitável em portal — e isso se
                  lê na ausência, não em uma linha dizendo "sem origem" em todo item
                  de um cofre que provavelmente não tem nenhuma. */}
              {entry.origin && (
                <div
                  className="secret-vault-origin"
                  title={`Só pode ser digitada em ${entry.origin}`}
                >
                  {entry.origin}
                </div>
              )}

              {/* A gaveta: o item cresce só no instante em que tem o que mostrar,
                  e a barra que encolhe é o contador dos 10s — o valor some
                  sozinho, e ver isso acontecer é o que impede a surpresa. */}
              {isOpen && <div className="secret-vault-reveal">{revealed.value}</div>}
              {isOpen && (
                <span
                  className="secret-vault-countdown"
                  style={{ animationDuration: `${REVEAL_MS}ms` }}
                />
              )}
            </li>
          )
        })}
      </ul>

      <AccessLog workspaceId={workspaceId} vaultId={content.id} />
    </div>
  )
}

/**
 * O aviso de "troque esta senha".
 *
 * Dois motivos, um ícone: a chave que um AGENTE gravou (o valor passou pelo
 * contexto dele — está queimado, e isso é de agora) e a chave VELHA demais (é
 * manutenção). O primeiro vem em cor cheia, o segundo apagado; a frase inteira
 * mora no title, porque num nó estreito não cabe texto ao lado de cada chave e
 * um ícone que ninguém entende é pior que ícone nenhum.
 */
function RotateMark({ entry }: { entry: SecretVaultKeyRef }): JSX.Element | null {
  const reason = rotationReason(entry)
  if (!reason) return null

  const days = entry.updatedAt
    ? Math.floor((Date.now() - Date.parse(entry.updatedAt)) / 86_400_000)
    : 0
  const title =
    reason === 'agent'
      ? 'gravada por um agente, que teve o valor em claro — troque a senha na origem e regrave a chave'
      : `guardada há ${days} dias (o limite é ${VAULT_ROTATE_AFTER_DAYS}) — hora de trocar`

  return (
    <span
      className={reason === 'agent' ? 'secret-vault-rotate is-burned' : 'secret-vault-rotate'}
      title={title}
    >
      <IconRotateKey size={12} />
    </span>
  )
}

/**
 * Quem leu o quê, e quando.
 *
 * Fica fechado por padrão: é informação de auditoria, não de uso diário, e um
 * nó pequeno no canvas não pode gastar metade da altura com histórico. A lista
 * é carregada só quando o usuário abre — e nunca traz valor, porque o arquivo
 * que a alimenta também não tem nenhum.
 *
 * As linhas são do workspace inteiro, e o filtro por cofre acontece aqui: o
 * `access.log` é um arquivo só, como o de um servidor, para não multiplicar
 * arquivos pequenos por nó.
 */
function AccessLog({ workspaceId, vaultId }: { workspaceId: UUID; vaultId: UUID }): JSX.Element {
  const [open, setOpen] = useState(false)
  const [lines, setLines] = useState<string[] | null>(null)

  useEffect(() => {
    if (!open) return
    let alive = true
    void window.atelier.vault.accessLog(workspaceId, 80).then((all) => {
      if (!alive) return
      setLines(all.filter((line) => line.includes(vaultId)).slice(0, 12))
    })
    return () => {
      alive = false
    }
  }, [open, workspaceId, vaultId])

  return (
    <div className={open ? 'secret-vault-log is-open' : 'secret-vault-log'}>
      <button
        type="button"
        className="icon-btn ghost-btn secret-vault-log-toggle"
        onClick={() => setOpen((v) => !v)}
      >
        acessos
        <IconChevronDown size={9} />
      </button>
      {open && (
        <ul>
          {lines === null && <li className="is-empty">lendo…</li>}
          {lines?.length === 0 && <li className="is-empty">nenhum acesso registrado</li>}
          {lines?.map((line) => {
            const [when, who, , what] = line.split('\t')
            return (
              <li key={line}>
                <span className="secret-vault-log-when">{when?.slice(11, 16)}</span>
                <span className="secret-vault-log-what">{what}</span>
                <span className="secret-vault-log-who">{who}</span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

interface KeyInput {
  key: string
  value: string
  origin: string
  inEnv: boolean
  note: string
}

/**
 * O formulário de uma chave — a mesma ficha para criar e para editar.
 *
 * Com `entry` ele edita, e o que muda é pouco de propósito: o NOME fica travado
 * e o VALOR nasce em branco. As duas coisas pelo mesmo motivo, que é o motivo de
 * a edição existir — o agente cria a chave com `atelier vault set` e o usuário
 * chega depois para trocar só o segredo. O nome é o identificador (é a variável
 * de ambiente que os terminais ligados já usam): mudá-lo é criar outra chave, e
 * para isso existem o ＋ e a lixeira. O valor não é pré-preenchido porque
 * imprimi-lo num input seria revelá-lo sem ninguém pedir — deixado em branco,
 * ele preserva o segredo que está no arquivo (ver `withSavedEntry`).
 *
 * `origin` nasce vazia — o default do formato é `null`, e "quem não declarou
 * não autorizou" só vale se o caminho preguiçoso for o restritivo.
 */
function KeyForm({
  entry,
  onSubmit,
  onCancel
}: {
  entry?: SecretVaultKeyRef
  onSubmit: (input: KeyInput) => void | Promise<void>
  onCancel: () => void
}): JSX.Element {
  const [form, setForm] = useState<KeyInput>({
    key: entry?.key ?? '',
    value: '',
    origin: entry?.origin ?? '',
    inEnv: entry?.inEnv ?? false,
    note: entry?.note ?? ''
  })
  // Editando uma chave que TEM origem ou nota, a gaveta já abre: escondê-las
  // faria a ficha parecer que perdeu os dois campos ao ser gravada.
  const [extra, setExtra] = useState(Boolean(entry && (entry.origin || entry.note)))

  // Fechado com conteúdo dentro, o rótulo diz o que está guardado ali. Um campo
  // preenchido que não aparece em lugar nenhum é um campo que vai ser gravado
  // sem ninguém ver.
  const guardados = [form.origin && 'origem', form.note && 'nota'].filter(Boolean).join(' · ')

  return (
    <form
      className="secret-vault-form"
      onSubmit={(e) => {
        e.preventDefault()
        void onSubmit(form)
      }}
    >
      {/* Nome e valor lado a lado: é o par mínimo de uma chave, e é tudo o que
          o formulário mostra de saída. */}
      <div className="secret-vault-form-pair">
        <input
          className="field-input secret-vault-input is-key"
          placeholder="NOME_DA_CHAVE"
          value={form.key}
          readOnly={Boolean(entry)}
          title={entry ? 'o nome não muda: apague e crie outra chave' : undefined}
          autoFocus={!entry}
          onChange={(e) => setForm((f) => ({ ...f, key: e.target.value }))}
        />
        <input
          className="field-input secret-vault-input"
          type="password"
          placeholder={entry ? 'novo segredo (vazio = mantém)' : 'valor'}
          value={form.value}
          autoFocus={Boolean(entry)}
          onChange={(e) => setForm((f) => ({ ...f, value: e.target.value }))}
        />
      </div>
      {/* Origem e nota são opcionais, e a maioria das chaves nasce sem as duas:
          mostradas sempre, elas dobravam a altura do formulário para perguntar o
          que quase ninguém responde. Ficam atrás desta linha, que é o lugar onde
          alguém que PRECISA delas vai procurar. A linha fica ACIMA dos dois
          campos: assim ela não muda de lugar quando abre, e o clique de fechar
          cai onde o de abrir caiu. */}
      <button
        type="button"
        className="icon-btn ghost-btn secret-vault-more"
        onClick={() => setExtra((v) => !v)}
      >
        <span className="secret-vault-more-sign">{extra ? '−' : '+'}</span>
        origem e nota
        {!extra && guardados && <span className="secret-vault-more-sum">{guardados}</span>}
      </button>
      {extra && (
        <>
          <input
            className="field-input secret-vault-input"
            placeholder="origem para login (https://exemplo.com)"
            value={form.origin}
            autoFocus={!entry}
            onChange={(e) => setForm((f) => ({ ...f, origin: e.target.value }))}
          />
          <input
            className="field-input secret-vault-input"
            placeholder="nota"
            value={form.note}
            onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
          />
        </>
      )}
      {/* O checkbox divide a linha com os botões: é a última pergunta da ficha,
          e sozinho numa linha própria pesava tanto quanto o gravar. */}
      <div className="secret-vault-form-actions">
        <label className="secret-vault-check" title="A chave entra no ambiente dos terminais ligados a este cofre">
          <input
            type="checkbox"
            checked={form.inEnv}
            onChange={(e) => setForm((f) => ({ ...f, inEnv: e.target.checked }))}
          />
          no ambiente
        </label>
        <button
          type="button"
          className="icon-btn ghost-btn secret-vault-cancel"
          onClick={onCancel}
        >
          cancelar
        </button>
        <button
          type="submit"
          className="btn is-primary secret-vault-save"
          disabled={!form.key.trim() || (!entry && !form.value)}
        >
          {entry ? 'salvar' : 'gravar'}
        </button>
      </div>
    </form>
  )
}

/** Título no header do nó. */
export function secretVaultLabel(content: SecretVaultContent): string {
  return content.name || 'Cofre'
}
