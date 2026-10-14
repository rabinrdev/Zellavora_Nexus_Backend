// Bundles the Vercel handler into one ES module.
//
// Why: Vercel's Node runtime does not allow require() of ES modules, and several dependencies are ESM-only
// (uuid -> exceljs, htmlparser2 -> sanitize-html, ...). A bundler converts those at build time, so no
// per-package workaround is needed. Only packages that cannot be bundled stay external (native addons,
// optional drivers and packages that read their own files at runtime); `api/index.js` imports the bundle so
// Vercel's file tracer ships those externals with the function.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/vercel/handler.ts'],
  outfile: 'dist/vercel/handler.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  logLevel: 'info',
  external: [
    'argon2', // native addon
    'pg-native', 'better-sqlite3', 'sqlite3', 'mysql', 'mysql2', 'mariadb', 'mariadb/callback', 'oracledb', 'tedious', 'pg-query-stream', // optional drivers (knex / pg)
    'swagger-ui-express', 'swagger-ui-dist', 'redoc', // serve their own static files from node_modules
  ],
  // CJS packages that get bundled still call require()/__dirname
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "import { fileURLToPath as __fileURLToPath } from 'node:url';",
      "import { dirname as __dirname_fn } from 'node:path';",
      'const require = __createRequire(import.meta.url);',
      'const __filename = __fileURLToPath(import.meta.url);',
      'const __dirname = __dirname_fn(__filename);',
    ].join('\n'),
  },
});
