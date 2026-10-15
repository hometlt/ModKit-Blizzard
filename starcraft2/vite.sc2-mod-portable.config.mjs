import { defineConfig } from 'vite'
import { resolve } from 'node:path'
import { erasedNodeHelpers } from './vite.sc2-erased-node-helpers.mjs'

export default defineConfig({
  plugins: [erasedNodeHelpers],
  build: {
    target: 'es2022',
    outDir: 'dist/modules/mod/codecs/mod/portable',
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    lib: {
      entry: {
        codec: resolve(import.meta.dirname, 'dist/modules/mod/codecs/mod/src/codec.js'),
        'directory-codec': resolve(import.meta.dirname, 'dist/modules/mod/codecs/directory/src/codec.js'),
      },
      formats: ['es'],
      fileName: (_format, entryName) => `${entryName}.mjs`,
    },
    rollupOptions: {
      treeshake: true,
    },
  },
})
