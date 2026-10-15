import { defineConfig } from 'vite'
import { resolve } from 'node:path'

export default defineConfig({
  build: {
    target: 'es2022',
    outDir: 'dist/modules/map/codecs/package/portable',
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    lib: {
      entry: resolve(import.meta.dirname, 'dist/modules/map/codecs/package/src/codec.js'),
      formats: ['es'],
      fileName: () => 'codec.mjs',
    },
    rollupOptions: {
      treeshake: true,
      output: { inlineDynamicImports: true },
    },
  },
})
