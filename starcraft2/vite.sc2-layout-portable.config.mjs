import { defineConfig } from 'vite'
import { resolve } from 'node:path'
import { erasedNodeHelpers } from './vite.sc2-erased-node-helpers.mjs'

export default defineConfig({
  plugins: [erasedNodeHelpers],
  build: {
    target: 'es2022',
    outDir: 'dist/modules/layout/codecs/layout/portable',
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    lib: {
      entry: resolve(import.meta.dirname, 'dist/modules/layout/codecs/layout/src/codec.js'),
      formats: ['es'],
      fileName: () => 'codec.mjs',
    },
    rollupOptions: {
      treeshake: true,
      output: { inlineDynamicImports: true },
    },
  },
})
