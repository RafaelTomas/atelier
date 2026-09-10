// Anti-FOUC: aplica o tema salvo ANTES do primeiro paint, senão a página
// pisca no tema errado por um frame (dark por padrão, depois troca pro claro
// escolhido). Ausência de valor salvo = "seguir sistema", e aí quem decide é
// o `@media (prefers-color-scheme)` do atelier.css, sem tocar em `data-theme`.
//
// Mesmo snippet colado em dois lugares (Marketing.astro e astro.config.mjs,
// via `starlight().head`): é pequeno demais para justificar um passo de build
// que una as duas cascas do site num único bundle de tema.
(function () {
  try {
    var stored = localStorage.getItem('atelier-theme');
    if (stored === 'light' || stored === 'dark') {
      document.documentElement.setAttribute('data-theme', stored);
    }
  } catch (e) {}
})();
