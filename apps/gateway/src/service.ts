import { randomBytes } from 'node:crypto';
import type { GatewayJob, NodeOutboundFrame, TaskEvent, TaskInput, TaskStatus } from '@molly/contracts';
import { nodeOutboundFrameSchema } from '@molly/contracts';
import { createId, encryptForNode } from '@molly/core';
import type { WebSocket } from 'ws';
import { buildTaskCard, type FeishuClient, type ParsedFeishuMessage } from './feishu.js';
import { GatewayStore } from './store.js';

interface NodeConnection {
  socket: WebSocket;
  ready: boolean;
}

export interface EnqueueResult {
  taskId: string;
  created: boolean;
  status: TaskStatus;
}

export class MollyGatewayService {
  private readonly connections = new Map<string, NodeConnection>();

  constructor(
    readonly store: GatewayStore,
    private readonly feishu: FeishuClient,
  ) {}

  pairNode(nodeId: string, publicKey: string): { nodeId: string; nodeToken: string } {
    const nodeToken = randomBytes(32).toString('base64url');
    this.store.registerNode(nodeId, publicKey, nodeToken);
    return { nodeId, nodeToken };
  }

  authenticateNode(nodeId: string, token: string): boolean {
    return this.store.authenticateNode(nodeId, token);
  }

  health(): { paired: boolean; connected: boolean; paused: boolean } {
    const node = this.store.getActiveNode();
    return {
      paired: Boolean(node),
      connected: Boolean(node && this.isNodeReady(node.id)),
      paused: this.store.isPaused(),
    };
  }

  async enqueueFeishu(message: ParsedFeishuMessage): Promise<EnqueueResult> {
    const node = this.store.getActiveNode();
    if (!node) throw new Error('Molly 还没有完成个人节点配对。');

    const replyTaskId = message.replyMessageIds
      .map((messageId) => this.store.findTaskByMessage(messageId))
      .find((taskId): taskId is string => Boolean(taskId));
    const taskId = replyTaskId ?? createId('task');
    const input: TaskInput = { ...message.input, taskId };
    const connected = this.isNodeReady(node.id) && !this.store.isPaused();
    const status: TaskStatus = connected ? 'queued' : 'queued_offline';
    const envelope = encryptForNode(node.publicKey, JSON.stringify(input));
    const result = this.store.createJob({
      taskId,
      nodeId: node.id,
      eventId: input.eventId,
      envelope,
      status,
    });
    this.store.rememberMessage(message.messageId, result.taskId);

    const storedTask = this.store.getTask(result.taskId);
    if (result.created || !storedTask?.cardMessageId) {
      await this.updateFeishuCard(result.taskId, status, message.receiveId, '任务已进入 Molly 的统一任务中心。');
    }

    if (result.job && connected) this.sendJob(node.id, result.job);
    return { taskId: result.taskId, created: result.created, status };
  }

  attachNode(nodeId: string, socket: WebSocket): void {
    const previous = this.connections.get(nodeId);
    if (previous && previous.socket !== socket) previous.socket.close(4001, 'replaced');
    this.connections.set(nodeId, { socket, ready: false });

    socket.on('message', (data) => {
      try {
        const parsed = nodeOutboundFrameSchema.parse(JSON.parse(data.toString())) as NodeOutboundFrame;
        void this.handleNodeFrame(nodeId, parsed);
      } catch {
        socket.close(1003, 'invalid frame');
      }
    });
    socket.on('close', () => {
      if (this.connections.get(nodeId)?.socket === socket) this.connections.delete(nodeId);
    });
    socket.on('error', () => {
      if (this.connections.get(nodeId)?.socket === socket) this.connections.delete(nodeId);
    });
  }

  private async handleNodeFrame(nodeId: string, frame: NodeOutboundFrame): Promise<void> {
    if (frame.type === 'ready') {
      if (frame.nodeId !== nodeId) return;
      const connection = this.connections.get(nodeId);
      if (!connection) return;
      connection.ready = true;
      this.deliverPending(nodeId);
      return;
    }
    if (frame.type === 'heartbeat') {
      return;
    }
    if (frame.type === 'job_ack') {
      this.store.acknowledgeJob(frame.jobId, frame.taskId);
      return;
    }
    if (frame.type === 'task_event') {
      await this.applyTaskEvent(frame.event);
      return;
    }
    if (frame.type === 'task_result') {
      const task = this.store.getTask(frame.taskId);
      if (!task) return;
      const status = task.status === 'failed' || task.status === 'canceled' ? task.status : 'completed';
      this.store.setTaskStatus(frame.taskId, status);
      await this.updateFeishuCard(frame.taskId, status, null, frame.summary, frame.artifacts);
    }
  }

  private async applyTaskEvent(event: TaskEvent): Promise<void> {
    if (!this.store.applyTaskEvent(event)) return;
    const task = this.store.getTask(event.taskId);
    if (!task) return;
    await this.updateFeishuCard(event.taskId, task.status, null, event.summary, event.artifacts);
  }

  async cancelTask(taskId: string): Promise<boolean> {
    const task = this.store.getTask(taskId);
    if (!task) return false;
    this.store.cancelTask(taskId);
    this.send(task.nodeId, { type: 'cancel', taskId });
    await this.updateFeishuCard(taskId, 'canceled', null, 'Yi 已停止这个任务。');
    return true;
  }

  async setPaused(paused: boolean): Promise<void> {
    this.store.setPaused(paused);
    for (const [nodeId] of this.connections) this.send(nodeId, { type: 'pause', paused });
    await Promise.all(this.store.listTasks().filter((task) => task.cardMessageId).map(async (task) => {
      try {
        await this.updateFeishuCard(
          task.id,
          task.status,
          null,
          paused ? 'Molly 已暂停，已有任务会在恢复后继续。' : 'Molly 已恢复，任务可以继续执行。',
        );
      } catch {
        // The persisted pause state remains authoritative; a later task event retries the card update.
      }
    }));
    if (!paused) {
      for (const [nodeId, connection] of this.connections) {
        if (connection.ready) this.deliverPending(nodeId);
      }
    }
  }

  private deliverPending(nodeId: string): void {
    if (this.store.isPaused()) return;
    for (const job of this.store.pendingJobs(nodeId)) this.sendJob(nodeId, job);
  }

  private sendJob(nodeId: string, job: GatewayJob): void {
    this.send(nodeId, { type: 'job', job });
  }

  private send(nodeId: string, frame: unknown): void {
    const connection = this.connections.get(nodeId);
    if (!connection || connection.socket.readyState !== 1) return;
    connection.socket.send(JSON.stringify(frame));
  }

  private isNodeReady(nodeId: string): boolean {
    const connection = this.connections.get(nodeId);
    return Boolean(connection?.ready && connection.socket.readyState === 1);
  }

  private async updateFeishuCard(
    taskId: string,
    status: TaskStatus,
    receiveId: string | null,
    summary: string,
    artifacts = [] as Parameters<typeof buildTaskCard>[0]['artifacts'],
  ): Promise<void> {
    const task = this.store.getTask(taskId);
    if (!task) return;
    const card = buildTaskCard({ taskId, status, summary, artifacts, paused: this.store.isPaused() });
    if (task.cardMessageId) {
      await this.feishu.updateTaskCard(task.cardMessageId, card);
      return;
    }
    if (!receiveId) return;
    const messageId = await this.feishu.sendTaskCard(receiveId, card);
    this.store.setCardMessage(taskId, messageId);
  }

  close(): void {
    for (const connection of this.connections.values()) connection.socket.close(1001, 'shutdown');
    this.connections.clear();
    this.store.close();
  }
}
