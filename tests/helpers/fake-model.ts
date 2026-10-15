import { createServer } from 'node:http';
import type { IncomingHttpHeaders, ServerResponse } from 'node:http';

export interface ModelRequest {
  method: string; path: string; headers: IncomingHttpHeaders; body: unknown;
}
export async function startFakeModel(handler: (request: ModelRequest, response: ServerResponse) => void) {
  const requests: ModelRequest[] = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        bytes += buffer.length;
        if (bytes > 1024 * 1024) throw new Error('Fixture request too large');
        chunks.push(buffer);
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      const record = { method: request.method ?? '', path: request.url ?? '', headers: request.headers, body: raw ? JSON.parse(raw) as unknown : null };
      requests.push(record);
      handler(record, response);
    } catch {
      response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Invalid fixture request' }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture failed to bind TCP');
  return {
    url: `http://127.0.0.1:${String(address.port)}`, requests,
    stop: () => new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error) reject(error); else resolve(); });
      server.closeAllConnections();
    }),
  };
}
