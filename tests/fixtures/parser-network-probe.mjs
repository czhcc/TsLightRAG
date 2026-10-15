import { disableParserNetwork } from '../../apps/server/dist/parsers/network.js';
disableParserNetwork();
const http = await import('node:http'); const https = await import('node:https'); const net = await import('node:net');
const attempts = [() => fetch('http://127.0.0.1:9'), () => http.get('http://127.0.0.1:9'), () => https.get('https://127.0.0.1:9'), () => net.connect(9, '127.0.0.1')];
for (const attempt of attempts) { try { await attempt(); throw new Error('Network was permitted'); } catch (e) { if (e.code !== 'PARSER_NETWORK_FORBIDDEN') throw e; } }
process.stdout.write('network guards rejected all probes\n');
