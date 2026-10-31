import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// index.html shows this as v.ab12. Slice the full hash: --short=4 grows when four characters are ambiguous.
function commitPrefix() {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).slice(0, 4);
  } catch {
    return 'dev';
  }
}
process.env.VITE_APP_VERSION = commitPrefix();

// The offline build runs second and adds dist/slop-newyork.html beside the site, with everything inlined.
const offlineFile = {
  name: 'offline-file',
  enforce: 'post',
  transformIndexHtml: {
    order: 'pre',
    // Preloading an inlined file would embed it twice, and a manifest can't load from file://
    handler: (html) => html
      .replace(/^\s*<link rel="(?:preload|manifest)"[^\n]*\n/gm, '')
      .replace('<html lang="en">', '<html lang="en" data-offline>')
  },
  generateBundle(_options, bundle) {
    bundle['index.html'].fileName = 'slop-newyork.html';
  }
};

export default defineConfig(({ mode }) => {
  const offline = mode === 'offline';
  return {
    base: './',
    plugins: offline ? [viteSingleFile(), offlineFile] : [],
    build: {
      target: 'esnext', // the geodata modules use top-level await
      chunkSizeWarningLimit: 6000,
      ...(offline && { emptyOutDir: false, assetsInlineLimit: 100_000_000 })
    }
  };
});
