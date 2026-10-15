import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import dgram from 'node:dgram';
import { syncBuiltinESMExports } from 'node:module';
import { fail } from './common.js';
/** Defense in depth in our non-executing parser worker; not a hostile-code sandbox. */
export function disableParserNetwork() {
  const deny = () => fail('PARSER_NETWORK_FORBIDDEN', '本地解析禁止网络访问');
  http.request = deny; http.get = deny; https.request = deny; https.get = deny;
  http2.connect = deny; net.connect = deny; net.createConnection = deny;
  net.Socket.prototype.connect = deny; tls.connect = deny;
  dns.lookup = deny as unknown as typeof dns.lookup; dns.resolve = deny as unknown as typeof dns.resolve; dns.promises.lookup = deny; dns.promises.resolve = deny;
  dgram.createSocket = deny; globalThis.fetch = deny;
  globalThis.WebSocket = class { constructor() { deny(); } } as unknown as typeof WebSocket;
  syncBuiltinESMExports();
}
