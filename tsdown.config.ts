import { defineConfig } from 'tsdown'

/**
 * Bundles the TypeScript-emitted entry modules into the shipped lib/ layout:
 * tsc emits declarations and JS to lib/types, tsdown bundles the two entry
 * modules to lib/index.js and lib/invariant.js. `@deepseek-ai/*` imports and
 * node: builtins stay external.
 */
export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/invariant.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
