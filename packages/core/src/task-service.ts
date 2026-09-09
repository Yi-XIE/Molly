import { EventEmitter } from 'node:events';
import type { ArtifactRef, RouteDecision, Task, TaskInput, TaskSnapshot } from '@molly/contracts';
import { taskInputSchema, taskTitle } from '@molly/contracts';
import { createId } from './ids.js';
import type { RuntimeAdapter, RuntimeUpdate } from './runtime.js';
import { TaskRepository } from './task-repository.js';
import { WorkItemRepository } from './work-item-repository.js';
import { IntentRouter } from './intent-router.js';
import { ContextCompiler } from './context-compiler.js';

export type TaskServiceEvent =
  | { type: 'snapshot'; snapshot: TaskSnapshot }
  | { type: 'runtime'; update: RuntimeUpdate };

export interface CreateTaskOptions {
  taskId?: string;
  workItemId?: string;
  queuedOffline?: boolean;
  autoRun?: boolean;
}

export class TaskService {
  private readonly emitter = new EventEmitter();
  private readonly running = new Set<string>();
  private readonly runtimeUnsubscribe: () => void;
  private readonly router = new IntentRouter();
  private readonly contextCompiler = new ContextCompiler();

  constructor(
    readonly repository: TaskRepository,
    private readonly runtime: RuntimeAdapter,
    private readonly workItems?: WorkItemRepository,
  ) {
    this.runtimeUnsubscribe = runtime.subscribe((update) => this.handleRuntimeUpdate(update));
  }

  subscribe(listener: (event: TaskServiceEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }

  private notify(taskId: string): void {
    const snapshot = this.repository.getSnapshot(taskId);
    if (snapshot) this.emitter.emit('event', { type: 'snapshot', snapshot } satisfies TaskServiceEvent);
  }

  private handleRuntimeUpdate(update: RuntimeUpdate): void {
    if (update.type === 'session_ready') {
      this.repository.setPiSession(update.taskId, update.sessionId);
      this.notify(update.taskId);
    } else if (update.type === 'thinking') {
      this.repository.appendEvent(update.taskId, 'progress', update.summary, { progress: 0.18 });
      this.notify(update.taskId);
    } else if (update.type === 'acting') {
      this.repository.appendEvent(update.taskId, 'progress', `正在使用 ${update.toolName}`, { progress: 0.54 });
      this.repository.recordAudit(update.taskId, update.toolName, update.target, 'started', '工具开始执行');
      this.notify(update.taskId);
    } else if (update.type === 'tool_finished') {
      this.repository.recordAudit(
        update.taskId,
        update.toolName,
        update.target,
        update.ok ? 'completed' : 'failed',
        update.ok ? '工具执行完成' : '工具执行失败',
      );
    } else if (update.type === 'protected') {
      this.repository.setStatus(update.taskId, 'waiting_input');
      this.repository.appendEvent(update.taskId, 'waiting_input', update.summary, { progress: null });
      this.notify(update.taskId);
    } else if (update.type === 'compaction_start') {
      this.repository.appendEvent(update.taskId, 'progress', update.summary, { progress: 0.32 });
      this.notify(update.taskId);
    } else if (update.type === 'compaction_end') {
      this.repository.appendEvent(update.taskId, 'progress', update.summary, { progress: 0.38 });
      this.notify(update.taskId);
    } else if (update.type === 'compaction_failed') {
      this.repository.appendEvent(update.taskId, 'progress', update.summary, { progress: null });
      this.notify(update.taskId);
    } else if (update.type === 'artifact') {
      this.repository.addArtifact(update.artifact);
      this.repository.appendEvent(update.taskId, 'artifact', update.artifact.title, { artifacts: [update.artifact] });
      this.notify(update.taskId);
    } else {
      this.emitter.emit('event', { type: 'runtime', update } satisfies TaskServiceEvent);
    }
  }

  route(inputValue: TaskInput, currentWorkItemId: string): RouteDecision {
    const input = taskInputSchema.parse(inputValue);
    const cards = this.workItems?.cards() ?? [];
    const current = cards.find((card) => card.id === currentWorkItemId);
    if (!current) return { action: 'continue', fromWorkItemId: currentWorkItemId, toWorkItemId: null, confidence: 0, reason: '当前工作项不存在，保持当前任务' };
    return this.router.decide(input.text, current, cards);
  }

  taskForWorkItem(workItemId: string): Task | null {
    return this.repository.listTasks().find((task) => task.workItemId === workItemId) ?? null;
  }

  create(inputValue: TaskInput, options: CreateTaskOptions = {}): TaskSnapshot {
    const input = taskInputSchema.parse(inputValue);
    if (this.repository.hasInputEvent(input.eventId)) {
      const existingTaskId = this.repository.findTaskIdByEvent(input.eventId);
      const existing = existingTaskId ? this.repository.getSnapshot(existingTaskId) : null;
      if (existing) return existing;
    }
    const now = new Date().toISOString();
    const workItem = options.workItemId
      ? this.workItems?.get(options.workItemId)
      : this.workItems?.create({ title: taskTitle(input.text), goal: input.text });
    const workItemId = workItem?.id ?? options.workItemId ?? input.taskId ?? createId('work_item');
    const task: Task = {
      id: options.taskId ?? input.taskId ?? createId('task'),
      workItemId,
      interactionStreamId: input.conversationRef ?? createId('stream'),
      title: taskTitle(input.text),
      origin: input.source,
      conversationRef: input.conversationRef,
      piSessionId: null,
      status: options.queuedOffline ? 'queued_offline' : 'queued',
      surface: 'conversation',
      createdAt: now,
      updatedAt: now,
      lastError: null,
      artifacts: [],
    };
    const result = this.repository.createTask(task, input);
    if (result.created) {
      this.repository.appendEvent(
        task.id,
        options.queuedOffline ? 'queued' : 'created',
        options.queuedOffline ? '已排队，等待个人节点上线' : '已收到，准备开始',
        { progress: 0 },
      );
      this.notify(task.id);
      if ((options.autoRun ?? true) && !options.queuedOffline) void this.dispatch(task.id, input, false);
    }
    const snapshot = this.repository.getSnapshot(result.task.id);
    if (!snapshot) throw new Error('任务创建后无法读取。');
    return snapshot;
  }

  steer(taskId: string, inputValue: TaskInput): TaskSnapshot {
    const task = this.repository.getTask(taskId);
    if (!task) throw new Error('找不到要继续的任务。');
    const input = taskInputSchema.parse({ ...inputValue, taskId });
    const appended = this.repository.appendInput(taskId, input);
    if (appended) {
      this.repository.setStatus(taskId, 'queued');
      this.repository.appendEvent(taskId, 'queued', '已收到补充信息', { progress: 0 });
      this.notify(taskId);
      void this.dispatch(taskId, input, true);
    }
    const snapshot = this.repository.getSnapshot(taskId);
    if (!snapshot) throw new Error('任务更新后无法读取。');
    return snapshot;
  }

  async cancel(taskId: string): Promise<TaskSnapshot> {
    const task = this.repository.getTask(taskId);
    if (!task) throw new Error('找不到要停止的任务。');
    await this.runtime.cancelTask(taskId);
    this.repository.setStatus(taskId, 'canceled');
    this.repository.appendEvent(taskId, 'canceled', '任务已停止');
    this.running.delete(taskId);
    this.notify(taskId);
    return this.get(taskId) as TaskSnapshot;
  }

  get(taskId: string): TaskSnapshot | null {
    return this.repository.getSnapshot(taskId);
  }

  list(query = ''): Task[] {
    return this.repository.listTasks(query);
  }

  hasInputEvent(eventId: string): boolean {
    return this.repository.hasInputEvent(eventId);
  }

  private async dispatch(taskId: string, input: TaskInput, steer: boolean): Promise<void> {
    if (this.running.has(taskId) && !steer) return;
    const task = this.repository.getTask(taskId);
    if (!task || task.status === 'canceled') return;
    this.running.add(taskId);
    this.repository.setStatus(taskId, 'running');
    this.repository.appendEvent(taskId, 'started', steer ? '正在吸收补充信息' : 'Molly 开始处理', { progress: 0.08 });
    this.notify(taskId);

    try {
      const workItem = this.workItems?.get(task.workItemId);
      const runtimeTask = workItem
        ? { ...task, contextCapsule: this.contextCompiler.compile({ workItem }) }
        : task;
      const result = steer
        ? await this.runtime.steerTask(runtimeTask, input)
        : await this.runtime.createTask(runtimeTask, input);
      this.repository.setPiSession(taskId, result.sessionId);
      this.repository.appendMessage(taskId, 'assistant', result.summary);
      const storedArtifacts: ArtifactRef[] = [];
      for (const artifact of result.artifacts) storedArtifacts.push(this.repository.addArtifact(artifact));
      const current = this.repository.getTask(taskId);
      if (current?.status !== 'waiting_input' && current?.status !== 'canceled') {
        this.repository.setStatus(taskId, 'completed');
        this.repository.appendEvent(taskId, 'completed', '任务完成', {
          progress: 1,
          artifacts: storedArtifacts,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const current = this.repository.getTask(taskId);
      if (current?.status !== 'canceled' && current?.status !== 'waiting_input') {
        this.repository.setStatus(taskId, 'failed', { error: message });
        this.repository.appendEvent(taskId, 'failed', message);
      }
    } finally {
      this.running.delete(taskId);
      this.notify(taskId);
    }
  }

  async dispose(): Promise<void> {
    this.runtimeUnsubscribe();
    await this.runtime.dispose();
    this.repository.close();
  }
}
