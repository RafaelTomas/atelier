import { defineCollection } from 'astro:content';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';

// Starlight sempre lê de `src/content/docs/`, mas o site inteiro só expõe
// esse conteúdo sob a rota `/docs` — a landing e a página de download vivem
// fora do tema de docs. Como o loader não tem opção de prefixo de rota,
// prefixamos o id (slug) gerado com `docs/` aqui; a estrutura física dos
// arquivos (e o `autogenerate` da sidebar, que usa o caminho físico) fica
// intacta.
const docsExtension = /\.(md|mdx|markdown|mdown|mkdn|mkd|mdwn)$/;

export const collections = {
  docs: defineCollection({
    loader: docsLoader({
      generateId: ({ entry, data }) => {
        const withoutExtension = entry.replace(docsExtension, '');
        let slug = typeof data.slug === 'string' ? data.slug : withoutExtension;
        slug = slug.replace(/(^|\/)index$/, '$1').replace(/\/$/, '');
        return slug ? `docs/${slug}` : 'docs';
      },
    }),
    schema: docsSchema(),
  }),
};
