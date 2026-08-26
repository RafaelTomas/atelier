/** Encurtamento de caminhos para exibição. Extraído do diálogo de terminal. */
export function shortenPath(path: string): string {
  if (!path) return ''
  const home = path.match(/^(\/Users\/[^/]+|\/home\/[^/]+|C:\\Users\\[^\\]+)/)
  return home ? `~${path.slice(home[0].length)}` : path
}

/** Corta pelo início: num caminho, o fim é a parte informativa. */
export function truncateStart(path: string, max = 42): string {
  const short = shortenPath(path)
  return short.length <= max ? short : `…${short.slice(short.length - max + 1)}`
}

/**
 * O caminho pronto para ser digitado num shell.
 *
 * Só põe aspas quando precisa: a maioria dos caminhos não tem nada de especial,
 * e `'/home/u/src/app.ts'` na linha de comando é ruído. Um espaço no caminho,
 * porém, vira dois argumentos — daí as aspas quando aparece qualquer coisa fora
 * do conjunto seguro.
 *
 * No Windows são aspas duplas: o `cmd.exe` não entende aspas simples (o
 * PowerShell entende as duas). Nos demais são simples, que não interpolam nada
 * — e o `'` embutido vira o truque de sempre, fechar-escapar-reabrir.
 */
export function quoteForShell(path: string, platform: string): string {
  if (/^[A-Za-z0-9_@%+=:,.\/-]+$/.test(path)) return path
  if (platform === 'win32') return `"${path}"`
  return `'${path.replace(/'/g, `'\\''`)}'`
}
