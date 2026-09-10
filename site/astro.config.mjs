// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
  // Deploy em GitHub Pages como *project page* (br3nds0n.github.io/atelier), não
  // *user/org page* — por isso o `base` com o nome do repo. Se um domínio custom
  // entrar (CNAME), isso vira uma origem própria: troque `site` para a URL do
  // domínio e `base` para '/' — senão todo link interno sai com o prefixo errado.
  site: 'https://br3nds0n.github.io',
  base: '/atelier',
  integrations: [
    starlight({
      title: 'Atelier',
      description: 'Documentação do Atelier — seu ateliê de agentes de IA.',
      defaultLocale: 'root',
      locales: {
        root: { label: 'Português', lang: 'pt-BR' },
      },
      customCss: ['./src/styles/atelier.css'],
      // Anti-FOUC: precisa rodar antes do primeiro paint, senão a doc pisca no
      // tema errado por um frame. Entradas de `head` do Starlight já renderizam
      // como tags cruas (ver Head.astro: `<Tag {...attrs} set:html={content} />`),
      // então um `<script>` aqui já é inline por natureza — não aceita (nem
      // precisa de) atributo `is:inline`, que é uma diretiva de compilação do
      // Astro, não um atributo HTML real, e o schema de `attrs` rejeitaria.
      // Mesmo snippet colado em Marketing.astro (ver src/scripts/theme-init.js).
      head: [
        {
          tag: 'script',
          content: `(function () {
  try {
    var stored = localStorage.getItem('atelier-theme');
    if (stored === 'light' || stored === 'dark') {
      document.documentElement.setAttribute('data-theme', stored);
    }
  } catch (e) {}
})();`,
        },
      ],
      components: {
        ThemeSelect: './src/components/EmptyThemeSelect.astro',
        Header: './src/components/DocsHeader.astro',
        PageTitle: './src/components/DocsPageTitle.astro',
        Footer: './src/components/DocsFooter.astro',
        Sidebar: './src/components/DocsSidebar.astro',
        PageSidebar: './src/components/EmptyPageSidebar.astro',
      },
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/br3nds0n/atelier' },
      ],
      sidebar: [
        {
          label: 'Primeiros passos',
          items: [{ autogenerate: { directory: 'primeiros-passos' } }],
        },
        {
          label: 'O canvas',
          items: [{ autogenerate: { directory: 'canvas' } }],
        },
        {
          label: 'Os nós',
          items: [{ autogenerate: { directory: 'nos' } }],
        },
        {
          label: 'Agentes e cabos',
          items: [{ autogenerate: { directory: 'agentes' } }],
        },
        // Desativado temporariamente: seção "Referência" fora do menu lateral.
        // {
        //   label: 'Referência',
        //   items: [{ autogenerate: { directory: 'referencia' } }],
        // },
      ],
    }),
  ],
});
