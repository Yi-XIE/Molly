import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { encryptForNode, generateNodeKeyPair } from '@molly/core';
import { loadGatewayConfig } from './src/config.js';
import { parseFeishuEvent, verifyFeishuSignature } from './src/feishu.js';
import { GatewayStore } from './src/store.js';
import { createGatewayApp } from './src/app.js';

function config() {
  return loadGatewayConfig({
    MOLLY_OWNER_OPEN_ID: 'ou_owner',
    FEISHU_VERIFICATION_TOKEN: 'verify',
    MOLLY_PUBLIC_BASE_URL: 'https://molly.example',
  });
}

describe('Molly gateway boundaries', () => {
  it('accepts the Feishu challenge and filters non-owner/group events', () => {
    expect(parseFeishuEvent({ challenge: 'abc', token: 'verify', type: 'url_verification' }, config())).toEqual({ kind: 'challenge', challenge: 'abc' });
    const base = {
      header: { event_id: 'evt-1', event_type: 'im.message.receive_v1', token: 'verify' },
      event: {
        sender: { sender_id: { open_id: 'ou_other' } },
        message: { message_id: 'msg-1', chat_id: 'chat-1', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text: 'hello' }) },
      },
    };
    expect(parseFeishuEvent(base, config())).toEqual({ kind: 'ignored', reason: 'owner_only' });
    expect(parseFeishuEvent({ ...base, event: { ...base.event, sender: { sender_id: { open_id: 'ou_owner' } }, message: { ...base.event.message, chat_type: 'group' } } }, config())).toEqual({ kind: 'ignored', reason: 'group_disabled' });
  });

  it('routes a reply message to its parent task and validates signatures', () => {
    const parsed = parseFeishuEvent({
      header: { event_id: 'evt-2', event_type: 'im.message.receive_v1', token: 'verify', create_time: '1720000000' },
      event: {
        sender: { sender_id: { open_id: 'ou_owner' } },
        message: { message_id: 'msg-2', parent_id: 'card-1', root_id: 'card-1', chat_id: 'chat-1', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text: '补充一下' }) },
      },
    }, config());
    expect(parsed.kind).toBe('message');
    if (parsed.kind === 'message') {
      expect(parsed.message.input.replyToMessageId).toBe('card-1');
      expect(parsed.message.replyMessageIds).toEqual(['card-1']);
    }
    const raw = '{"ok":true}';
    const timestamp = '1720000000';
    const nonce = 'nonce';
    const signature = createHash('sha256').update(`${timestamp}${nonce}encrypt${raw}`).digest('hex');
    const headers = new Headers({ 'x-lark-signature': signature, 'x-lark-request-timestamp': timestamp, 'x-lark-request-nonce': nonce });
    expect(verifyFeishuSignature(raw, headers, 'encrypt')).toBe(true);
    expect(verifyFeishuSignature(raw, headers, 'wrong')).toBe(false);
    expect(verifyFeishuSignature(raw, new Headers(), 'encrypt')).toBe(false);
    expect(verifyFeishuSignature(raw, new Headers(), '')).toBe(true);
  });

  it('keeps duplicate event identity after a job is acknowledged', () => {
    const store = new GatewayStore(':memory:');
    const keys = generateNodeKeyPair();
    store.registerNode('node-1', keys.publicKey, 'node-token');
    const envelope = encryptForNode(keys.publicKey, JSON.stringify({ eventId: 'evt-1' }));
    const first = store.createJob({ taskId: 'task-1', nodeId: 'node-1', eventId: 'evt-1', envelope, status: 'queued' });
    expect(first.created).toBe(true);
    expect(first.job).not.toBeNull();
    const storedJson = String(store.database.prepare('SELECT envelope_json FROM jobs WHERE id = ?').get(first.job!.id)?.envelope_json ?? '');
    expect(storedJson).not.toContain('molly-private-message');
    expect(store.acknowledgeJob(first.job!.id, 'task-1')).toBe(true);
    const duplicate = store.createJob({ taskId: 'task-new', nodeId: 'node-1', eventId: 'evt-1', envelope, status: 'queued' });
    expect(duplicate.created).toBe(false);
    expect(duplicate.taskId).toBe('task-1');
    expect(duplicate.job).toBeNull();
    store.close();
  });

  it('rejects out-of-order task events', () => {
    const store = new GatewayStore(':memory:');
    const keys = generateNodeKeyPair();
    store.registerNode('node-1', keys.publicKey, 'node-token');
    const envelope = encryptForNode(keys.publicKey, '{}');
    store.createJob({ taskId: 'task-1', nodeId: 'node-1', eventId: 'evt-1', envelope, status: 'queued' });
    const at = new Date().toISOString();
    const event = (seq: number) => ({ id: `event-${seq}`, taskId: 'task-1', seq, type: 'progress' as const, summary: 'stage', progress: null, artifacts: [], occurredAt: at });
    expect(store.applyTaskEvent(event(2))).toBe(true);
    expect(store.applyTaskEvent(event(1))).toBe(false);
    expect(store.getTask('task-1')?.lastSeq).toBe(2);
    store.close();
  });

  it('serves health and rejects unauthenticated pairing', async () => {
    const gatewayConfig = loadGatewayConfig({
      MOLLY_OWNER_OPEN_ID: 'ou_owner',
      MOLLY_PAIRING_TOKEN: 'pair-secret',
      MOLLY_PUBLIC_BASE_URL: 'https://molly.example',
    });
    const store = new GatewayStore(':memory:');
    const fakeService = {
      health: () => ({ paired: false, connected: false, paused: false }),
      pairNode: () => ({ nodeId: 'node-1', nodeToken: 'token' }),
    } as never;
    const app = createGatewayApp(gatewayConfig, fakeService);
    expect((await app.request('http://gateway.test/healthz')).status).toBe(200);
    expect((await app.request('http://gateway.test/v1/nodes/pair', { method: 'POST', body: '{}' })).status).toBe(401);
    store.close();
  });
});
