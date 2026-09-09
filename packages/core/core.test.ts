import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decryptForNode, encryptForNode, generateNodeKeyPair, PreviewRuntimeAdapter, SqliteMemoryService, TaskRepository, TaskService, evaluateToolCall } from './src/index.js';
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
      id: 'task_test', title: '测试任务', origin: 'desktop' as const, conversationRef: null,
      piSessionId: null, status: 'queued' as const, surface: 'conversation' as const,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastError: null, artifacts: [],
    };
    expect(repository.createTask(task, input('same-event')).created).toBe(true);
    expect(repository.createTask({ ...task, id: 'other-task' }, input('same-event')).created).toBe(false);
    expect(repository.listTasks()).toHaveLength(1);
    repository.close();
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
    await service.dispose();
  });

  it('persists task state across repository restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'molly-core-'));
    const path = join(directory, 'molly.db');
    const first = new TaskRepository(path);
    const task = {
      id: 'task_persist', title: '持久化任务', origin: 'desktop' as const, conversationRef: null,
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
