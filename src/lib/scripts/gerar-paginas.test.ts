import { execFileSync } from 'node:child_process';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('gerar-paginas CLI', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gerar-paginas-'));
    await mkdir(join(root, 'scripts'));
    await mkdir(join(root, 'assets', 'js'), { recursive: true });
    await copyFile(
      join(process.cwd(), 'scripts', 'gerar-paginas.js'),
      join(root, 'scripts', 'gerar-paginas.js')
    );
  });

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it.each([
    { nome: 'Empanada de Queijo', descricao: 'Queijo e cebola' },
    { nome: 'Empanada $& Especial', descricao: "Recheio $& $$ $` $' especial" },
  ])(
    'writes rendered HTML with literal catalog values: $nome',
    async (item) => {
      const filename =
        item.nome === 'Empanada de Queijo'
          ? 'empanada-de-queijo-fixture.html'
          : 'empanada-especial-fixture.html';
      const canonicalUrl = 'https://laempanadas.com.br/produtos/' + filename;
      const expected = {
        PRODUTO_NOME: item.nome,
        PRODUTO_NOME_ENCODED: encodeURIComponent(item.nome),
        PRODUTO_DESCRICAO: item.descricao,
        PRODUTO_DESCRICAO_SEO:
          item.descricao +
          ' Peca online com entrega rapida em Santo Andre. Frete gratis acima de R$ 100.',
        PRODUTO_ID: 'fixture',
        CATEGORIA_NOME: 'Empanadas Salgadas',
        CATEGORIA_SLUG: 'empanadas-salgadas',
        CATEGORIA_SLUG_LOWER: 'empanadas-salgadas',
        PRECO_NUMERICO: '12,50',
        PRECO_FORMATADO: 'R$ 12,50',
        IMAGEM_URL: 'https://laempanadas.com.br/assets/fixture.jpg',
        CANONICAL_URL: canonicalUrl,
        INGREDIENTES: item.descricao,
        CALORIAS: '320',
        PROTEINAS: '12',
        CARBOIDRATOS: '28',
        GORDURAS: '18',
        FIBRAS: '2',
        SODIO: '380',
      };
      const template =
        '<!DOCTYPE html><title>{{PRODUTO_NOME}}</title>\n' +
        Object.keys(expected)
          .map((key) => `<p data-field="${key}">{{${key}}}</p>`)
          .join('\n');
      await writeFile(join(root, 'produto-template.html'), template);
      await writeFile(
        join(root, 'assets', 'js', 'cardapio.json'),
        JSON.stringify({
          itens: [
            {
              ...item,
              id: 'fixture',
              categoriaId: 'salgada',
              preco: 12.5,
              imagem: 'assets/fixture.jpg',
            },
          ],
        })
      );

      const stdout = execFileSync(
        process.execPath,
        [join(root, 'scripts', 'gerar-paginas.js')],
        { cwd: root, encoding: 'utf8', timeout: 10_000 }
      );

      expect(stdout).toContain('Produtos processados: 1');
      expect(stdout).toContain('Erros: 0');
      const html = await readFile(join(root, 'produtos', filename), 'utf8');
      expect(html).toBe(
        `<!DOCTYPE html><title>${item.nome}</title>\n` +
          Object.entries(expected)
            .map(([key, value]) => `<p data-field="${key}">${value}</p>`)
            .join('\n')
      );
      expect(html).not.toMatch(/\{\{[A-Z_]+\}\}/);
      expect(
        await readFile(join(root, 'public', 'sitemap.xml'), 'utf8')
      ).toContain(`<loc>${canonicalUrl}</loc>`);
      expect(await readFile(join(root, 'produto-template.html'), 'utf8')).toBe(
        template
      );
    }
  );
});
