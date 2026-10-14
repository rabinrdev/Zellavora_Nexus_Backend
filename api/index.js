// Vercel serverless entry. The handler lives in src/vercel/handler.ts and is bundled into dist/vercel/handler.mjs
// by `npm run build:vercel` (see scripts/build-vercel.mjs).
export { default } from '../dist/vercel/handler.mjs';
