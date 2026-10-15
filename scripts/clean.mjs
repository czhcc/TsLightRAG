import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

for (const path of ['internal/contracts/dist', 'apps/server/dist', 'apps/web/dist', 'apps/web/node_modules/.cache']) {
  await rm(fileURLToPath(new URL(`../${path}`, import.meta.url)), { recursive: true, force: true });
}
