/**
 * Ícones ESCOLHÍVEIS de terminal e de responsabilidade.
 *
 * Separado de icons.tsx de propósito: lá ficam os ícones fixos da interface
 * (dock, toolbar), um componente por ícone; aqui é um catálogo indexado por
 * nome, porque o nome é o que fica gravado em disco no nó e na responsabilidade.
 *
 * O app nativo usa SF Symbols, que não existem fora do macOS. Aqui é SVG
 * traçado (24×24, `currentColor`), então o mesmo nome de ícone rende igual nos
 * três sistemas — e o `color` do terminal entra por `currentColor`, sem CSS
 * extra por ícone.
 */
/** Ordem em que aparecem na grade do diálogo (a primeira é o padrão do shell). */
export const ICON_NAMES = [
  'smiley',
  'terminal',
  'sparkle',
  'brain',
  'burst',
  'chat',
  'gear',
  'square',
  'server',
  'globe',
  'hammer',
  'wrench',
  'bolt',
  'cpu',
  'memory',
  'laptop',
  'display',
  'paintbrush',
  'folder',
  'document',
  'cube',
  'shield',
  'eye',
  'wand',
  // Vocabulário de AÇÃO — entrou com o botão do canvas. Fica no mesmo catálogo
  // de propósito: o diálogo de terminal passa a oferecê-los também, e um
  // terminal que roda a suíte de testes merece o frasco tanto quanto o botão.
  'play',
  'stop',
  'pause',
  'reload',
  'rocket',
  'flask',
  'package',
  'broom',
  'database',
  'upload',
  'download',
  'link',
  'check',
  'plus-circle',
  // Entrou com o monitor de recursos: um traço de eletrocardiograma diz
  // "isto está medindo alguma coisa agora" sem precisar de rótulo.
  'pulse',
  // Entrou com o nó de relógio: mostrador com dois ponteiros, o desenho que se
  // lê como "tempo" sem rótulo, nos quatro modos do nó.
  'clock'
] as const

export type IconName = (typeof ICON_NAMES)[number]

const PATHS: Record<IconName, JSX.Element> = {
  smiley: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9 10.2h.01M15 10.2h.01" />
      <path d="M8.4 14.2a4.3 4.3 0 0 0 7.2 0" />
    </>
  ),
  terminal: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M7.5 9.5 10.5 12.5 7.5 15.5M13 15.5h4" />
    </>
  ),
  pulse: <path d="M3 12h3.5l2-5.5 3.5 11 2.5-7 1.8 3.5H21" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7v5l3.5 2" />
    </>
  ),
  sparkle: <path d="M12 3.2 13.8 8.4 19 10.2 13.8 12 12 17.2 10.2 12 5 10.2 10.2 8.4z" />,
  brain: (
    <>
      <ellipse cx="8.6" cy="12" rx="4.4" ry="7" />
      <ellipse cx="15.4" cy="12" rx="4.4" ry="7" />
      <path d="M12 5.4v13.2" />
    </>
  ),
  burst: <path d="M12 2.8v18.4M2.8 12h18.4M5.5 5.5l13 13M18.5 5.5l-13 13" />,
  chat: (
    <path d="M20 13.5A2.5 2.5 0 0 1 17.5 16H10l-4 3.5V16A2 2 0 0 1 4 14V6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5z" />
  ),
  gear: (
    <>
      <circle cx="12" cy="12" r="6.2" />
      <circle cx="12" cy="12" r="2.6" />
      <path d="M12 2.6v3.2M12 18.2v3.2M2.6 12h3.2M18.2 12h3.2M5.3 5.3l2.3 2.3M16.4 16.4l2.3 2.3M18.7 5.3l-2.3 2.3M7.6 16.4l-2.3 2.3" />
    </>
  ),
  square: <rect x="4" y="4" width="16" height="16" rx="3" />,
  server: (
    <>
      <rect x="3" y="4" width="18" height="5.5" rx="1.8" />
      <rect x="3" y="14.5" width="18" height="5.5" rx="1.8" />
      <path d="M6.5 6.8h.01M6.5 17.3h.01" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17" />
      <path d="M12 3.5a13 13 0 0 1 0 17 13 13 0 0 1 0-17z" />
    </>
  ),
  hammer: (
    <>
      <path d="M14.2 3.6 20.4 9.8l-2.6 2.6-6.2-6.2z" />
      <path d="M11.6 6.2 4.2 13.6a2.1 2.1 0 0 0 3 3l7.4-7.4" />
    </>
  ),
  wrench: (
    <path d="M15.4 3.6a5.2 5.2 0 0 0-4.6 7.7l-7 7 2.9 2.9 7-7a5.2 5.2 0 0 0 6.6-6.6l-3.1 3.1-2.6-.6-.6-2.6z" />
  ),
  bolt: <path d="M13.4 2.8 5.6 13.6h5.4l-.9 7.6 8.3-10.8h-5.4z" />,
  cpu: (
    <>
      <rect x="6.5" y="6.5" width="11" height="11" rx="2" />
      <rect x="10" y="10" width="4" height="4" rx="1" />
      <path d="M9.5 3v3.5M14.5 3v3.5M9.5 17.5V21M14.5 17.5V21M3 9.5h3.5M3 14.5h3.5M17.5 9.5H21M17.5 14.5H21" />
    </>
  ),
  memory: (
    <>
      <rect x="2.8" y="7" width="18.4" height="10" rx="2" />
      <path d="M7.5 11v3M12 11v3M16.5 11v3" />
    </>
  ),
  laptop: (
    <>
      <path d="M5 7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v8H5z" />
      <path d="M2.8 17.8h18.4" />
    </>
  ),
  display: (
    <>
      <rect x="3" y="4.5" width="18" height="11.5" rx="2" />
      <path d="M12 16v3.5M9 19.5h6" />
    </>
  ),
  paintbrush: (
    <>
      <path d="M17.2 3.4a2.2 2.2 0 0 1 3.1 3.1l-6.4 6.4-3.1-3.1z" />
      <path d="M10.8 9.8 9.2 11.4a3.4 3.4 0 0 0-1 2.4c0 1.2-.9 2.2-2.4 2.6 1 1.7 2.6 2.6 4.3 2.6a3.7 3.7 0 0 0 3.7-3.7c0-1 .3-1.8 1-2.5" />
    </>
  ),
  folder: (
    <path d="M3 7.5A1.8 1.8 0 0 1 4.8 5.7h3.9L11 8.4h8.2A1.8 1.8 0 0 1 21 10.2v7.6a1.8 1.8 0 0 1-1.8 1.8H4.8A1.8 1.8 0 0 1 3 17.8z" />
  ),
  document: (
    <>
      <path d="M6.2 3.4h7L19 9.2v11.4H6.2z" />
      <path d="M13.2 3.4v5.8H19M9.2 13h6M9.2 16.4h6" />
    </>
  ),
  cube: (
    <>
      <path d="M12 2.8 20 7.4v9.2L12 21.2 4 16.6V7.4z" />
      <path d="M12 12 20 7.4M12 12v9.2M12 12 4 7.4" />
    </>
  ),
  shield: <path d="M12 2.8 19.4 6v5.6c0 4.4-3 8-7.4 9.6-4.4-1.6-7.4-5.2-7.4-9.6V6z" />,
  eye: (
    <>
      <path d="M2.6 12S6.2 5.8 12 5.8 21.4 12 21.4 12 17.8 18.2 12 18.2 2.6 12 2.6 12z" />
      <circle cx="12" cy="12" r="2.9" />
    </>
  ),
  wand: (
    <>
      <path d="M4.2 19.8 13.4 10.6" />
      <path d="M15 4.2 16 6.8l2.6 1-2.6 1-1 2.6-1-2.6-2.6-1 2.6-1z" />
      <path d="M19.4 13.6l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6z" />
    </>
  ),
  play: <path d="M8 5.2 18.4 12 8 18.8z" />,
  stop: <rect x="6.5" y="6.5" width="11" height="11" rx="1.6" />,
  pause: <path d="M9.5 5.5v13M14.5 5.5v13" />,
  reload: (
    <>
      <path d="M20 12a8 8 0 1 1-2.6-5.9" />
      <path d="M20 4v4.5h-4.5" />
    </>
  ),
  rocket: (
    <>
      <path d="M12 2.8c3.2 2.2 5 5.6 5 9.4l-2.2 4.4H9.2L7 12.2c0-3.8 1.8-7.2 5-9.4z" />
      <circle cx="12" cy="10" r="1.8" />
      <path d="M9.2 16.6 6.6 19l1.2-4M14.8 16.6 17.4 19l-1.2-4" />
    </>
  ),
  flask: (
    <>
      <path d="M10 3.2h4M11 3.2v6L5.8 18a2 2 0 0 0 1.7 3h9a2 2 0 0 0 1.7-3L13 9.2v-6" />
      <path d="M8.4 14.6h7.2" />
    </>
  ),
  package: (
    <>
      <path d="M12 2.8 20 7v10l-8 4.2L4 17V7z" />
      <path d="M4 7l8 4.2L20 7M12 11.2v10" />
      <path d="M8 4.9 16 9.1" />
    </>
  ),
  broom: (
    <>
      <path d="M19.4 4.6 12 12" />
      <path d="M11.4 10.2 4.8 16.8a2 2 0 0 0-.5 2l.6 2.4 2.4.6a2 2 0 0 0 2-.5l6.6-6.6z" />
      <path d="M8.6 13 11 15.4" />
    </>
  ),
  database: (
    <>
      <ellipse cx="12" cy="6" rx="7.2" ry="3.2" />
      <path d="M4.8 6v12c0 1.8 3.2 3.2 7.2 3.2s7.2-1.4 7.2-3.2V6" />
      <path d="M4.8 12c0 1.8 3.2 3.2 7.2 3.2s7.2-1.4 7.2-3.2" />
    </>
  ),
  upload: (
    <>
      <path d="M12 16V4.4" />
      <path d="M7.6 8.8 12 4.4l4.4 4.4" />
      <path d="M4.5 19.6h15" />
    </>
  ),
  download: (
    <>
      <path d="M12 4.4V16" />
      <path d="M7.6 11.6 12 16l4.4-4.4" />
      <path d="M4.5 19.6h15" />
    </>
  ),
  link: (
    <>
      <path d="M10.4 13.6a3.6 3.6 0 0 0 5.1 0l3-3a3.6 3.6 0 1 0-5.1-5.1l-1.6 1.6" />
      <path d="M13.6 10.4a3.6 3.6 0 0 0-5.1 0l-3 3a3.6 3.6 0 1 0 5.1 5.1l1.6-1.6" />
    </>
  ),
  check: <path d="M5 12.6 10 17.6 19.2 6.8" />,
  'plus-circle': (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 8.2v7.6M8.2 12h7.6" />
    </>
  )
}

export function isIconName(value: string): value is IconName {
  return (ICON_NAMES as readonly string[]).includes(value)
}

interface IconProps {
  name: string
  size?: number
  className?: string
}

/** Nome desconhecido cai no terminal — nó antigo nunca fica sem ícone. */
export function Icon({ name, size = 20, className }: IconProps): JSX.Element {
  const key: IconName = isIconName(name) ? name : 'terminal'
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[key]}
    </svg>
  )
}
