import { fileURLToPath } from 'node:url';

// Identical from src/paths.ts (tsx) and dist/paths.js (production).
export const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
export const webDist = fileURLToPath(new URL('../../web/dist/', import.meta.url));
