// Explicit esbuild task over pinned upstream source; not upstream's npm run build.
const { build } = require('esbuild');
const ts = require('typescript');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const expected = [
  'fixtures/file.md', 'fixtures/first/file.md', 'fixtures/first/nested/file.md', 'fixtures/first/nested/directory/file.md',
  'fixtures/second/file.md', 'fixtures/second/nested/file.md', 'fixtures/second/nested/directory/file.md',
  'fixtures/third/library/a/book.md', 'fixtures/third/library/b/book.md',
].sort();
(async () => {
  const result = await build({ entryPoints: ['src/index.ts'], bundle: true, format: 'cjs', platform: 'node', target: 'node18',
    outfile: 'dist/fast-glob.cjs', sourcemap: true, metafile: true,
    // Preserve upstream legacy CommonJS imports and ES2017 field assignment.
    // This is syntax transpilation, not type checking or explainFiles collection.
    plugins: [{ name: 'upstream-commonjs', setup(builder) {
      builder.onLoad({ filter: /\.ts$/ }, async ({ path: file }) => ({ loader: 'js', contents: ts.transpileModule(await fs.readFile(file, 'utf8'), {
        fileName: file, compilerOptions: { target: ts.ScriptTarget.ES2017, module: ts.ModuleKind.CommonJS },
      }).outputText }));
    } }],
  });
  const fg = require('./dist/fast-glob.cjs');
  assert.deepEqual(fg.sync('fixtures/**/*.md').sort(), expected);
  assert.deepEqual((await fg('fixtures/**/*.md')).sort(), expected);
  const stream = []; for await (const file of fg.stream('fixtures/**/*.md')) stream.push(file);
  assert.deepEqual(stream.sort(), expected);
  await fs.writeFile('dist/meta.json', JSON.stringify(result.metafile));
  await fs.writeFile('dist/smoke.json', JSON.stringify({ passed: true, count: expected.length, checked: ['sync', 'async', 'stream'] }));
})().catch(e => { console.error(e); process.exitCode = 1; });
