import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import type { GatewayConfig } from './config.js';
import { parseCardAction, parseFeishuEvent, verifyFeishuSignature } from './feishu.js';
import type { MollyGatewayService } from './service.js';

function safeSecretEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return Boolean(a.length && a.length === b.length && timingSafeEqual(a, b));
}

function bearer(value: string | undefined): string {
  return value?.match(/^Bearer\s+(.+)$/i)?.[1] ?? '';
}

export function createGatewayApp(config: GatewayConfig, service: MollyGatewayService): Hono {
  const app = new Hono();

  app.get('/healthz', (context) => context.json({ ok: true, ...service.health() }));

  app.post('/v1/nodes/pair', async (context) => {
    if (!config.pairingToken || !safeSecretEqual(bearer(context.req.header('authorization')), config.pairingToken)) {
      return context.json({ error: 'unauthorized' }, 401);
    }
    const body = await context.req.json().catch(() => null) as { nodeId?: unknown; publicKey?: unknown } | null;
    if (!body || typeof body.nodeId !== 'string' || !body.nodeId.trim() || typeof body.publicKey !== 'string' || !body.publicKey.trim()) {
      return context.json({ error: 'invalid_node' }, 400);
    }
    const paired = service.pairNode(body.nodeId.trim(), body.publicKey.trim());
    const websocketUrl = new URL('/v1/nodes/connect', config.publicBaseUrl);
    websocketUrl.protocol = websocketUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    websocketUrl.searchParams.set('nodeId', paired.nodeId);
    return context.json({ ...paired, websocketUrl: websocketUrl.toString() });
  });

  app.post('/v1/feishu/events', async (context) => {
    const rawBody = await context.req.text();
    if (!verifyFeishuSignature(rawBody, context.req.raw.headers, config.feishu.encryptKey)) {
      return context.json({ error: 'invalid_signature' }, 401);
    }
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return context.json({ error: 'invalid_json' }, 400);
    }
    const parsed = parseFeishuEvent(body, config);
    if (parsed.kind === 'challenge') return context.json({ challenge: parsed.challenge });
    if (parsed.kind === 'ignored') return context.json({ ok: true, ignored: parsed.reason });
    try {
      const result = await service.enqueueFeishu(parsed.message);
      return context.json({ ok: true, taskId: result.taskId, duplicate: !result.created });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'gateway_error';
      return context.json({ error: message }, 503);
    }
  });

  app.post('/v1/feishu/card-actions', async (context) => {
    const rawBody = await context.req.text();
    if (!verifyFeishuSignature(rawBody, context.req.raw.headers, config.feishu.encryptKey)) {
      return context.json({ error: 'invalid_signature' }, 401);
    }
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return context.json({ error: 'invalid_json' }, 400);
    }
    const action = parseCardAction(body, config);
    if (!action) return context.json({ error: 'forbidden' }, 403);
    if (action.action === 'cancel') {
      if (!action.taskId || !(await service.cancelTask(action.taskId))) {
        return context.json({ toast: { type: 'warning', content: '没有找到这个任务。' } });
      }
      return context.json({ toast: { type: 'success', content: '任务已经停止。' } });
    }
    const paused = action.action === 'pause';
    service.setPaused(paused);
    return context.json({
      toast: {
        type: 'success',
        content: paused ? 'Molly 已暂停，新任务会留在队列中。' : 'Molly 已恢复，正在领取队列。',
      },
    });
  });

  return app;
}
