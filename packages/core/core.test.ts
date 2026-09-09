import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextCompiler, decryptForNode, encryptForNode, generateNodeKeyPair, IntentRouter, PreviewRuntimeAdapter, SqliteMemoryService, TaskRepository, TaskService, WorkItemRepository, evaluateToolCall } from './src/index.js';
import { taskInputSchema, taskEventSchema, type TaskInput } from '@molly/contracts';

function input(eventId: string, text = '整理今天的想法'): TaskInput {
  return {
    eventId,
    source: 'desktop',
    senderId: 'yi-test',
    text,
    attachments: [],
    replyToMessageId: null,
    conversationRef: 'test',
    receivedAt: new Date().toISOString(),
  };
}

describe('Molly core', () => {
  it('isolates work item storage and creates its workspace layout', () => {
    const directory = mkdtempSync(join(tmpdir(), 'molly-work-'));
    const database = new DatabaseSync(':memory:');
    const repository = new WorkItemRepository(database, directory);
    const item = repository.create({ title: '产品方案', goal: '把灵感整理成可评审方案' });
    expect(repository.get(item.id)?.workspacePath).toBe(item.workspacePath);
    expect(repository.cards()[0]?.id).toBe(item.id);
    expect(() => repository.update('missing', { title: 'x' })).toThrow();
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('compiles a traceable, allowlisted context capsule', () => {
    const item = { id: 'work-1', title: '产品方案', goal: '形成方案', status: 'active' as const, parentId: null, piSessionPath: null, workspacePath: 'C:/work-1', currentSummary: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const compiler = new ContextCompiler();
    const capsule = compiler.compile({ workItem: item, confirmedRules: ['WM-001'], confirmedFacts: ['Yi 是产品经理'], referencedArtifacts: [{ id: 'artifact-1', summary: '已确认的方案摘要' }] });
    expect(capsule.workItemId).toBe('work-1');
    expect(capsule.allowedArtifactIds).toEqual(['artifact-1']);
    expect(compiler.toPrompt(capsule, [{ id: 'artifact-1', summary: '已确认的方案摘要' }])).toContain('已确认的方案摘要');
  });

  it('routes explicit focus changes and asks when confidence is ambiguous', () => {
    const current = { id: 'product', title: '产品方案', goal: '整理产品想法', tags: ['产品'], recentSummary: '', lastActiveAt: '' };
    const career = { id: 'career', title: '职业规划', goal: '整理职业方向', tags: ['职业'], recentSummary: '', lastActiveAt: '' };
    const router = new IntentRouter();
    expect(router.decide('切到职业规划', current, [current, career]).action).toBe('switch');
    expect(router.decide('这个方向也要想想', current, [current, career]).action).toBe('continue');
  });

  it('exposes focus routing without reading sibling conversations', () => {
    const database = new DatabaseSync(':memory:');
    const directory = mkdtempSync(join(tmpdir(), 'molly-route-'));
    const taskRepository = new TaskRepository(':memory:');
    const workItems = new WorkItemRepository(database, directory);
    const product = workItems.create({ title: '产品方案', goal: '整理产品方案' });
    workItems.create({ title: '职业规划', goal: '整理职业方向' });
    const service = new TaskService(taskRepository, new PreviewRuntimeAdapter(), workItems);
    const decision = service.route(input('route-event', '切到职业规划继续'), product.id);
    expect(decision.action).toBe('switch');
    expect(decision.toWorkItemId).not.toBe(product.id);
    void service.dispose();
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('injects a compiled capsule before runtime execution', async () => {
    const database = new DatabaseSync(':memory:');
    const directory = mkdtempSync(join(tmpdir(), 'molly-capsule-'));
    const taskRepository = new TaskRepository(':memory:');
    const workItems = new WorkItemRepository(database, directory);
    let received: any = null;
    const runtime = {
      subscribe: () => () => undefined,
      createTask: async (task: any) => { received = task.contextCapsule; return { sessionId: 's', summary: 'ok', artifacts: [] }; },
      steerTask: async (task: any) => { received = task.contextCapsule; return { sessionId: 's', summary: 'ok', artifacts: [] }; },
      cancelTask: async () => undefined,
      dispose: async () => undefined,
    } as any;
    const service = new TaskService(taskRepository, runtime, workItems);
    service.create(input('capsule-event'), { autoRun: true });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(received?.version).toBe(1);
    expect(received?.workItemId).toBeTruthy();
    await service.dispose();
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('increments artifact versions within a work item', () => {
    const repository = new TaskRepository(':memory:');
    const now = new Date().toISOString();
    repository.createTask({ id: 'task-artifact', workItemId: 'work-artifact', interactionStreamId: 'stream-artifact', title: '方案', origin: 'desktop', conversationRef: null, piSessionId: null, status: 'queued', surface: 'conversation', createdAt: now, updatedAt: now, lastError: null, artifacts: [] }, input('artifact-event'));
    const base = { taskId: 'task-artifact', workItemId: 'work-artifact', kind: 'text' as const, title: '方案', mimeType: 'text/plain', localRef: null, shareRef: null, previewText: 'v', createdAt: new Date().toISOString() };
    expect(repository.addArtifact({ ...base, id: 'a1', version: 1 }).version).toBe(1);
    expect(repository.addArtifact({ ...base, id: 'a2', version: 1 }).version).toBe(2);
    repository.close();
  });
  it('validates transport payloads before they enter the task service', () => {
    expect(() => taskInputSchema.parse({ eventId: 'e', source: 'desktop', senderId: 'yi', text: '', receivedAt: new Date().toISOString() })).toThrow();
    expect(() => taskEventSchema.parse({ id: 'e', taskId: 't', seq: 1, type: 'progress', summary: 'ok', progress: 2, artifacts: [], occurredAt: new Date().toISOString() })).toThrow();
  });
  it('encrypts and authenticates a node envelope', () => {
    const keys = generateNodeKeyPair();
    const envelope = encryptForNode(keys.publicKey, 'molly-private-message');
    expect(decryptForNode(keys.privateKey, envelope)).toBe('molly-private-message');
    envelope.ciphertext = `${envelope.ciphertext.slice(0, -2)}aa`;
    expect(() => decryptForNode(keys.privateKey, envelope)).toThrow();
  });

  it('deduplicates repository inputs by event id', () => {
    const repository = new TaskRepository(':memory:');
    const task = {
      id: 'task_test', workItemId: 'work_test', interactionStreamId: 'stream_test', title: '测试任务', origin: 'desktop' as const, conversationRef: null,
      piSessionId: null, status: 'queued' as const, surface: 'conversation' as const,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastError: null, artifacts: [],
    };
    expect(repository.createTask(task, input('same-event')).created).toBe(true);
    expect(repository.createTask({ ...task, id: 'other-task' }, input('same-event')).created).toBe(false);
    expect(repository.listTasks()).toHaveLength(1);
    repository.close();
  });

  it('does not create a second work item for a duplicate event', () => {
    const database = new DatabaseSync(':memory:');
    const directory = mkdtempSync(join(tmpdir(), 'molly-dedupe-'));
    const repository = new TaskRepository(':memory:');
    const workItems = new WorkItemRepository(database, directory);
    const service = new TaskService(repository, new PreviewRuntimeAdapter(), workItems);
    const first = service.create(input('work-event'), { autoRun: false });
    const second = service.create(input('work-event'), { autoRun: false });
    expect(second.task.id).toBe(first.task.id);
    expect(workItems.list()).toHaveLength(1);
    void service.dispose();
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('runs preview tasks through completed state', async () => {
    const repository = new TaskRepository(':memory:');
    const service = new TaskService(repository, new PreviewRuntimeAdapter());
    const snapshot = service.create(input('preview-event'));
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(service.get(snapshot.task.id)?.task.status).toBe('completed');
    expect(service.get(snapshot.task.id)?.task.artifacts.length).toBeGreaterThan(0);
    await service.dispose();
  });

  it('keeps a protected task waiting for confirmation', async () => {
    const repository = new TaskRepository(':memory:');
    const listeners = new Set<(update: any) => void>();
    const protectedRuntime = {
      createTask: async (task: any) => {
        for (const listener of listeners) listener({ type: 'protected', taskId: task.id, summary: '需要确认' });
        throw new Error('受保护操作');
      },
      steerTask: async (task: any) => {
        for (const listener of listeners) listener({ type: 'protected', taskId: task.id, summary: '需要确认' });
        throw new Error('受保护操作');
      },
      cancelTask: async () => undefined,
      subscribe: (listener: (update: any) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
      dispose: async () => undefined,
    } as any;
    const service = new TaskService(repository, protectedRuntime);
    const snapshot = service.create(input('protected-event'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(service.get(snapshot.task.id)?.task.status).toBe('waiting_input');
    expect((repository.database.prepare('SELECT COUNT(*) AS count FROM audit_log WHERE task_id = ? AND outcome = ?').get(snapshot.task.id, 'blocked') as { count: number }).count).toBe(1);
    await service.dispose();
  });

  it('persists task state across repository restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'molly-core-'));
    const path = join(directory, 'molly.db');
    const first = new TaskRepository(path);
    const task = {
      id: 'task_persist', workItemId: 'work_persist', interactionStreamId: 'stream_persist', title: '持久化任务', origin: 'desktop' as const, conversationRef: null,
      piSessionId: 'session-1', status: 'completed' as const, surface: 'conversation' as const,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastError: null, artifacts: [],
    };
    first.createTask(task, input('persist-event'));
    first.appendEvent(task.id, 'completed', '已完成');
    first.close();
    const second = new TaskRepository(path);
    expect(second.getSnapshot(task.id)?.task.piSessionId).toBe('session-1');
    expect(second.getSnapshot(task.id)?.events.at(-1)?.type).toBe('completed');
    second.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('blocks protected tools and allows ordinary file work', () => {
    expect(evaluateToolCall('payment', { amount: 1 }).protected).toBe(true);
    expect(evaluateToolCall('powershell', { command: 'Get-ChildItem C:\\work' }).allowed).toBe(true);
    expect(evaluateToolCall('read_file', { path: 'C:\\outside\\secret.txt' }, { workspaceRoot: 'C:\\work-item' }).allowed).toBe(false);
    expect(evaluateToolCall('read_file', { path: 'C:\\work-item\\notes.txt' }, { workspaceRoot: 'C:\\work-item' }).allowed).toBe(true);
  });

  it('supports memory correction and soft deletion', async () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE memories (id TEXT PRIMARY KEY, kind TEXT, content TEXT, source TEXT, confidence REAL, created_at TEXT, updated_at TEXT, superseded_by TEXT, deleted_at TEXT)');
    const memory = new SqliteMemoryService(db);
    const first = await memory.write({ kind: 'preference', content: '喜欢早上复盘', source: 'test', confidence: 0.9 });
    const replacement = await memory.correct(first.id, '喜欢晚上复盘', 'test-correction');
    expect(await memory.recall('早上')).toHaveLength(0);
    expect((await memory.recall('晚上'))[0]?.id).toBe(replacement.id);
    expect(await memory.forget(replacement.id)).toBe(true);
    expect(await memory.recall('晚上')).toHaveLength(0);
    db.close();
  });
});
