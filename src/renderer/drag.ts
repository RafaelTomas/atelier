/**
 * O tipo MIME do arrasto de projeto.
 *
 * Um tipo próprio, e não `text/plain`: assim o canvas aceita o drop de um
 * projeto e ignora qualquer outra coisa arrastada para dentro dele — um arquivo
 * do gerenciador, um link do navegador, texto de outro app.
 */
export const PROJECT_DRAG_TYPE = 'application/x-atelier-project'
