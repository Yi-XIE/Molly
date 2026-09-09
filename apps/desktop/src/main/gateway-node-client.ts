import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { safeStorage } from 'electron';
import { nodeInboundFrameSchema, taskInputSchema, type NodeInboundFrame, type NodeOutboundFrame, type TaskSnapshot } from '@molly/contracts';
import { createId, decryptForNode, generateNodeKeyPair, type TaskService, type TaskServiceEvent } from '@molly/core';
import WebSocket from 'ws';

interface StoredCredentials {
  nodeId: string;
  publicKey: string;
  encryptedPrivateKey: string;
  encryptedNodeToken: string | null;
  websocketUrl: string | null;
}

interface GatewayNodeClientOptions {
  service: TaskService;
  credentialsPath: string;
  gatewayUrl: string;
  pairingToken: string;
}

export class GatewayNodeClient {
  private credentials: StoredCredentials | null = null;
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempt = 0;
  private stopped = false;
  private paused = false;
  private readonly remoteTasks = new Set<string>();
  private readonly sentSeq = new Map<string, number>();
  private readonly sentResults = new Map<string, string>();
  private readonly unsubscribe: () => void;

  constructor(private readonly options: GatewayNodeClientOptions) {
    for (const task of options.service.list()) {
      if (task.origin === 'feishu') this.remoteTasks.add(task.id);
    }
    this.unsubscribe = options.service.subscribe((event) => this.handleTaskServiceEvent(event));
  }

  async start(): Promise<void> {
    if (!this.options.gatewayUrl) return;
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Windows 安全凭据存储当前不可用，飞书个人节点没有启动。');
    }
    this.credentials = this.loadOrCreateCredentials();
    if (!this.credentials.encryptedNodeToken || !this.credentials.websocketUrl) await this.pair();
    this.connect();
  }

  private loadOrCreateCredentials(): StoredCredentials {
    if (existsSync(this.options.credentialsPath)) {
      const parsed = JSON.parse(readFileSync(this.options.credentialsPath, 'utf8')) as StoredCredentials;
      if (parsed.nodeId && parsed.publicKey && parsed.encryptedPrivateKey) return parsed;
    }
    const keys = generateNodeKeyPair();
    const created: StoredCredentials = {
      nodeId: createId('node'),
      publicKey: keys.publicKey,
      encryptedPrivateKey: safeStorage.encryptString(keys.privateKey).toString('base64'),
      encryptedNodeToken: null,
      websocketUrl: null,
    };
    this.saveCredentials(created);
    return created;
  }

  private saveCredentials(credentials: StoredCredentials): void {
    mkdirSync(dirname(this.options.credentialsPath), { recursive: true });
    writeFileSync(this.options.credentialsPath, JSON.stringify(credentials, null, 2), { encoding: 'utf8', mode: 0o600 });
  }

  private decryptSecret(value: string): string {
    return safeStorage.decryptString(Buffer.from(value, 'base64'));
  }

  private async pair(): Promise<void> {
    if (!this.credentials) throw new Error('个人节点密钥尚未创建。');
    if (!this.options.pairingToken) throw new Error('缺少 MOLLY_PAIRING_TOKEN，个人节点无法首次配对。');
    const response = await fetch(new URL('/v1/nodes/pair', this.options.gatewayUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.options.pairingToken}`,
      },
      body: JSON.stringify({ nodeId: this.credentials.nodeId, publicKey: this.credentials.publicKey }),
    });
    const payload = await response.json() as { nodeToken?: unknown; websocketUrl?: unknown; error?: unknown };
    if (!response.ok || typeof payload.nodeToken !== 'string' || typeof payload.websocketUrl !== 'string') {
      throw new Error(`个人节点配对失败，状态码 ${response.status}。`);
    }
    this.credentials.encryptedNodeToken = safeStorage.encryptString(payload.nodeToken).toString('base64');
    this.credentials.websocketUrl = payload.websocketUrl;
    this.saveCredentials(this.credentials);
  }

  private connect(): void {
    if (this.stopped || !this.credentials?.encryptedNodeToken || !this.credentials.websocketUrl) return;
    const token = this.decryptSecret(this.credentials.encryptedNodeToken);
    const socket = new WebSocket(this.credentials.websocketUrl, { headers: { authorization: `Bearer ${token}` } });
    this.socket = socket;
    socket.on('open', () => {
      this.reconnectAttempt = 0;
      this.sentSeq.clear();
      this.sentResults.clear();
      this.send({ type: 'ready', nodeId: this.credentials?.nodeId ?? '' });
      this.startHeartbeat();
      this.replayRemoteState();
    });
    socket.on('message', (data) => {
      try {
        const frame = nodeInboundFrameSchema.parse(JSON.parse(data.toString())) as NodeInboundFrame;
        void this.handleFrame(frame);
      } catch {
        socket.close(1003, 'invalid frame');
      }
    });
    socket.on('close', () => this.scheduleReconnect(socket));
    socket.on('error', () => this.scheduleReconnect(socket));
  }

  private async handleFrame(frame: NodeInboundFrame): Promise<void> {
    if (frame.type === 'pause') {
      this.paused = frame.paused;
      return;
    }
    if (frame.type === 'cancel') {
      if (this.options.service.get(frame.taskId)) await this.options.service.cancel(frame.taskId);
      return;
    }
    if (this.paused || !this.credentials) return;
    const privateKey = this.decryptSecret(this.credentials.encryptedPrivateKey);
    const input = taskInputSchema.parse(JSON.parse(decryptForNode(privateKey, frame.job.envelope)));
    if (input.source !== 'feishu' || input.taskId !== frame.job.taskId) throw new Error('网关任务来源或编号不匹配。');
    this.remoteTasks.add(frame.job.taskId);
    const snapshot = this.options.service.hasInputEvent(input.eventId)
      ? this.options.service.get(frame.job.taskId)
      : this.options.service.get(frame.job.taskId)
        ? this.options.service.steer(frame.job.taskId, input)
        : this.options.service.create(input, { taskId: frame.job.taskId, autoRun: true });
    if (!snapshot) throw new Error('本地任务状态不存在，无法确认网关任务。');
    this.send({ type: 'job_ack', jobId: frame.job.id, taskId: frame.job.taskId });
    this.publishSnapshot(snapshot);
  }

  private handleTaskServiceEvent(event: TaskServiceEvent): void {
    if (event.type !== 'snapshot' || !this.remoteTasks.has(event.snapshot.task.id)) return;
    this.publishSnapshot(event.snapshot);
  }

  private replayRemoteState(): void {
    for (const taskId of this.remoteTasks) {
      const snapshot = this.options.service.get(taskId);
      if (snapshot) this.publishSnapshot(snapshot);
    }
  }

  private publishSnapshot(snapshot: TaskSnapshot): void {
    const lastSent = this.sentSeq.get(snapshot.task.id) ?? 0;
    for (const event of snapshot.events) {
      if (event.seq <= lastSent) continue;
      if (!this.send({ type: 'task_event', event })) return;
      this.sentSeq.set(snapshot.task.id, event.seq);
    }
    if (!['completed', 'failed', 'canceled'].includes(snapshot.task.status)) return;
    if (this.sentResults.get(snapshot.task.id) === snapshot.task.status) return;
    const summary = [...snapshot.messages].reverse().find((message) => message.role === 'assistant')?.content
      ?? snapshot.events.at(-1)?.summary
      ?? '任务已结束。';
    if (this.send({ type: 'task_result', taskId: snapshot.task.id, summary, artifacts: snapshot.task.artifacts })) {
      this.sentResults.set(snapshot.task.id, snapshot.task.status);
    }
  }

  private send(frame: NodeOutboundFrame): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(frame));
    return true;
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: 'heartbeat', occurredAt: new Date().toISOString() });
    }, 20_000);
  }

  private scheduleReconnect(socket: WebSocket): void {
    if (this.socket !== socket || this.stopped) return;
    this.socket = null;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    if (this.reconnectTimer) return;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.reconnectAttempt++, 5));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  async dispose(): Promise<void> {
    this.stopped = true;
    this.unsubscribe();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.socket?.close(1000, 'shutdown');
    this.socket = null;
  }
}
