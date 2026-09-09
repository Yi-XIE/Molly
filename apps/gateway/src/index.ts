import 'dotenv/config';
import { serve } from '@hono/node-server';
import { WebSocketServer } from 'ws';
import { createGatewayApp } from './app.js';
import { loadGatewayConfig } from './config.js';
import { FeishuClient } from './feishu.js';
import { MollyGatewayService } from './service.js';
import { GatewayStore } from './store.js';

const config = loadGatewayConfig();
const store = new GatewayStore(config.databasePath);
const feishu = new FeishuClient(config.feishu);
const service = new MollyGatewayService(store, feishu);
const app = createGatewayApp(config, service);

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`[molly-gateway] listening on port ${info.port}`);
});
const websocketServer = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url ?? '/', config.publicBaseUrl);
  if (url.pathname !== '/v1/nodes/connect') {
    socket.destroy();
    return;
  }
  const nodeId = url.searchParams.get('nodeId') ?? '';
  const token = request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1] ?? '';
  if (!nodeId || !token || !service.authenticateNode(nodeId, token)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  websocketServer.handleUpgrade(request, socket, head, (websocket) => service.attachNode(nodeId, websocket));
});

const cleanupTimer = setInterval(() => store.cleanup(), 60 * 60 * 1000);
cleanupTimer.unref();

function shutdown(): void {
  clearInterval(cleanupTimer);
  websocketServer.close();
  server.close(() => {
    service.close();
    process.exit(0);
  });
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
