/**
 * Ícones da dock — SVG inline, traço de 1.5px em currentColor.
 *
 * Desenhados em uma grade de 24 e sem preenchimento: é o que dá o visual
 * "outline" da dock. Nada de emoji aqui — emoji não herda cor do tema e cada
 * plataforma renderiza num peso diferente, o que quebra o alinhamento da pill.
 */
interface IconProps {
  size?: number
}

function Svg({ size = 18, children }: IconProps & { children: React.ReactNode }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

/** Cursor de seleção — o único ícone preenchido, como na referência. */
export function IconCursor(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M6 3.5 18.5 12 12 13 9.5 20Z" fill="currentColor" stroke="none" />
    </Svg>
  )
}

export function IconTerminal(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <rect x="2.5" y="5" width="19" height="14" rx="2.5" />
      <path d="M7 10.5 9.5 13 7 15.5M12.5 16h4" />
    </Svg>
  )
}

export function IconNote(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M6 3.5h11a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H6" />
      <path d="M6 3.5a2 2 0 0 0 0 4M6 20.5a2 2 0 0 0 0-4h2" />
      <path d="M10 8.5h5M10 12h5" />
    </Svg>
  )
}

export function IconClip(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M17.5 7 9 15.5a2.5 2.5 0 0 0 3.5 3.5l7-7a4.5 4.5 0 0 0-6.5-6.5l-7 7a6.5 6.5 0 0 0 9 9L21 15" />
    </Svg>
  )
}

export function IconFolder(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M3 7.5a2 2 0 0 1 2-2h3.8l1.7 2H19a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </Svg>
  )
}

export function IconGlobe(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.6 2.5 15.4 0 18M12 3c-2.5 2.6-2.5 15.4 0 18" />
    </Svg>
  )
}

/** "Aa" — texto. Desenhado como glifo para casar com o peso dos outros. */
export function IconText({ size = 18 }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <text
        x="12"
        y="17"
        textAnchor="middle"
        fontSize="14"
        fontFamily="-apple-system, system-ui, sans-serif"
        fill="currentColor"
      >
        Aa
      </text>
    </svg>
  )
}

/** Modo desenho: círculo com um traço atravessando, como na referência. */
export function IconDraw(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M16.5 7.5 7.5 16.5" />
    </Svg>
  )
}

export function IconPen(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M4 20l4-1 10-10a2.5 2.5 0 0 0-3.5-3.5L4.5 15.5Z" />
      <path d="M13.5 6.5 17.5 10.5" />
    </Svg>
  )
}

export function IconHighlighter(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M9 14.5l6.5-8a2 2 0 0 1 3 0l1.5 1.8a2 2 0 0 1-.3 2.9L11.5 17Z" />
      <path d="M9 14.5 7 19h5l-.5-2M4 21.5h16" />
    </Svg>
  )
}

export function IconEraser(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M8.5 19.5 4 15a1.5 1.5 0 0 1 0-2.2l8.3-8.3a1.5 1.5 0 0 1 2.2 0l5 5a1.5 1.5 0 0 1 0 2.2l-7.8 7.8Z" />
      <path d="M9.5 7.5 16.5 14.5M9 19.5h11" />
    </Svg>
  )
}

/** Traço reto. */
export function IconLine(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M4.5 19.5 19.5 4.5" />
    </Svg>
  )
}

export function IconArrow(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M4.5 19.5 19 5M13 5h6v6" />
    </Svg>
  )
}

export function IconRect(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <rect x="4" y="6" width="16" height="12" rx="2" />
    </Svg>
  )
}

export function IconEllipse(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <ellipse cx="12" cy="12" rx="8.5" ry="6.5" />
    </Svg>
  )
}

export function IconTrash(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M4.5 7h15M9.5 7V5h5v2M6.5 7l1 13h9l1-13M10 11v6M14 11v6" />
    </Svg>
  )
}

export function IconChevronDown({ size = 10 }: IconProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M2.5 4.5 6 8l3.5-3.5" />
    </svg>
  )
}
