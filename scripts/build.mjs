import { build } from 'esbuild'

await build({
  entryPoints: ['lib/client.js'],
  outfile: 'dist/client.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome125',
  loader: { '.css': 'text' },
  legalComments: 'inline',
  define: { 'process.env.NODE_ENV': '"production"' },
})
