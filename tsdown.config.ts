import { defineConfig } from 'tsdown'

/**
 * Two bundles, two shapes:
 *
 * 1. The node half bundles the TypeScript-emitted entry modules into the
 *    shipped lib/ layout: tsc emits declarations and JS to lib/types, tsdown
 *    bundles the two entry modules to lib/index.js and lib/invariant.js.
 *    `@deepseek-ai/*` imports and node: builtins stay external.
 *
 * 2. The browser half bundles src/client.ts into a classic-script artifact at
 *    lib/client.js wrapped in the `window.__ModuleLoader__.load` registration
 *    the host module loader requires (mirrors the DeepSeek Harness client
 *    preset). The source has no runtime SDK imports — the only @deepseek-ai/*
 *    import is a type — so the bundle needs no externals and the whole module
 *    inlines into the factory.
 */
export default [
  defineConfig({
    entry: ['lib/types/index.js', 'lib/types/invariant.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  }),
  defineConfig({
    entry: { client: 'src/client.ts' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    target: 'es2022',
    // package.json exports "./client" points at lib/client.js. clean must
    // stay off — tsc owns lib/types and a clean pass would wipe it.
    dts: false,
    sourcemap: true,
    clean: false,
    outputOptions: {
      entryFileNames: 'client.js',
      banner: 'window.__ModuleLoader__.load({ id: "@open-agfs/dsh-agfs", factory: (require) => {',
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  }),
]
