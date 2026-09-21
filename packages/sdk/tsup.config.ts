import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/eas/index.ts', 'src/lenses/index.ts', 'src/chain/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  splitting: true,
  treeshake: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
})
