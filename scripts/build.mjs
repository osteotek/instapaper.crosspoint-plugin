// Builds the installed plugin files from src/: minified plugin.js and epub.js
// in instapaper.crosspoint-plugin/. The reader serves plugin files
// uncompressed every time its Settings page opens, so smaller files load
// faster. Run `npm run build` after changing src/; `npm test` fails when the
// built files are out of date.
import { readFile, writeFile } from 'node:fs/promises';
import { transform } from 'esbuild';

const repo = new URL('../', import.meta.url);
const PAYLOAD = 'instapaper.crosspoint-plugin/';

// plugin.js is a classic script (an IIFE); epub.js is an ES module whose
// exports the card imports by name. Neither is bundled: each file is
// minified on its own.
const SOURCES = [
  { name: 'plugin.js', format: undefined },
  { name: 'epub.js', format: 'esm' },
];

export async function buildFiles() {
  const manifest = JSON.parse(await readFile(new URL(PAYLOAD + 'manifest.json', repo), 'utf8'));
  const pkg = JSON.parse(await readFile(new URL('package.json', repo), 'utf8'));
  const source = pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '');
  const built = {};
  for (const { name, format } of SOURCES) {
    const code = await readFile(new URL('src/' + name, repo), 'utf8');
    const result = await transform(code, {
      loader: 'js',
      format,
      minify: true,
      target: 'es2020',
      legalComments: 'none',
      banner: '// Articles for Instapaper ' + manifest.version + ', minified. Source: ' + source + '/blob/v' + manifest.version + '/src/' + name,
    });
    built[name] = result.code;
  }
  return built;
}

if (import.meta.url === 'file://' + process.argv[1]) {
  for (const [name, code] of Object.entries(await buildFiles())) {
    await writeFile(new URL(PAYLOAD + name, repo), code);
    console.log(PAYLOAD + name + ': ' + code.length + ' bytes');
  }
}
