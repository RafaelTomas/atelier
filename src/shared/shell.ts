/**
 * Um caminho pronto para ser digitado num shell.
 *
 * Compartilhado entre main e renderer: os dois precisam da MESMA regra de aspas
 * ao colar um caminho no PTY (o renderer quando um arquivo é arrastado para
 * dentro do terminal, o main quando uma imagem colada vira arquivo temporário).
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
