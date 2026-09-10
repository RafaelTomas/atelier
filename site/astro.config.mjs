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
      // O SVG é a marca sem a margem que o ícone do app carrega (a arte ocupa
      // 828 de 1024): com ela, o favicon aparece menor que os vizinhos na aba.
      // Ver o <head> de layouts/Marketing.astro.
      favicon: '/favicon.svg',
      defaultLocale: 'root',
      locales: {
        root: { label: 'Português', lang: 'pt-BR' },
      },
      customCss: ['./src/styles/atelier.css'],
      components: {
        ThemeSelect: './src/components/EmptyThemeSelect.astro',
        Header: './src/components/DocsHeader.astro',
        PageTitle: './src/components/DocsPageTitle.astro',
        Footer: './src/components/DocsFooter.astro',
      },
      social: [
        { icon: 'gitlab', label: 'GitLab', href: 'https://gitlab.fcxlabs.com/platform/tools/fcx-atelier-ai-agents-orquestrator' },
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
        {
          label: 'Referência',
          items: [{ autogenerate: { directory: 'referencia' } }],
        },
      ],
    }),
  ],
});
