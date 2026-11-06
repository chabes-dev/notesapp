import * as esbuild from 'esbuild';
import fs from 'node:fs';
import crypto from 'node:crypto';
const r = await esbuild.build({
  entryPoints: ['src/app.js'], bundle: true, minify: true, write: false, outdir: 'out',
  format: 'iife', target: ['chrome110', 'safari16'],
  loader: { '.woff2': 'dataurl', '.woff': 'empty' },
});
const js = r.outputFiles.find(f => f.path.endsWith('.js')).text.replace(/<\/script/gi, '<\\/script');
const css = r.outputFiles.find(f => f.path.endsWith('.css')).text;
const html = fs.readFileSync('src/index.html', 'utf8').replace('%CSS%', () => css).replace('%JS%', () => js);
fs.rmSync('dist', { recursive: true, force: true }); fs.mkdirSync('dist');
fs.writeFileSync('dist/index.html', html);
for (const f of fs.readdirSync('public')) fs.copyFileSync('public/' + f, 'dist/' + f);
const version = crypto.createHash('sha1').update(html).digest('hex').slice(0, 10);
fs.writeFileSync('dist/sw.js', fs.readFileSync('src/sw.js', 'utf8').replace('%VERSION%', version));
console.log('built', (html.length / 1024).toFixed(0) + ' KB', 'version', version);
