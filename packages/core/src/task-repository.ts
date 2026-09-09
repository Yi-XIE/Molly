import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  ArtifactRef,
  Task,
  TaskEvent,
  TaskEventType,
  TaskInput,
  TaskMessage,
  TaskSnapshot,
  TaskStatus,
} from '@molly/contracts';
import { createId } from './ids.js';

type Row = Record<string, unknown>;

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

export class TaskRepository {
  readonly database: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        work_item_id TEXT NOT NULL DEFAULT '',
        interaction_stream_id TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL,
        origin TEXT NOT NULL,
        conversation_ref TEXT,
        pi_session_id TEXT,
        status TEXT NOT NULL,
        surface TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS task_inputs (
        event_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        text TEXT NOT NULL,
        attachments_json TEXT NOT NULL,
        reply_to_message_id TEXT,
        conversation_ref TEXT,
        received_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS task_inputs_task_idx ON task_inputs(task_id, received_at);
      CREATE TABLE IF NOT EXISTS task_events (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        summary TEXT NOT NULL,
        progress REAL,
        artifacts_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        UNIQUE(task_id, seq)
      );
      CREATE TABLE IF NOT EXISTS task_messages (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS task_messages_task_idx ON task_messages(task_id, created_at);
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        work_item_id TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        mime_type TEXT,
        local_ref TEXT,
        share_ref TEXT,
        preview_text TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        tool_name TEXT NOT NULL,
        target TEXT,
        outcome TEXT NOT NULL,
        detail TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        source TEXT NOT NULL,
        confidence REAL NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        superseded_by TEXT,
        deleted_at TEXT
      );
    `);
    const taskColumns = this.database.prepare('PRAGMA table_info(tasks)').all() as Row[];
    if (!taskColumns.some((column) => column.name === 'work_item_id')) this.database.exec("ALTER TABLE tasks ADD COLUMN work_item_id TEXT NOT NULL DEFAULT ''");
    if (!taskColumns.some((column) => column.name === 'interaction_stream_id')) this.database.exec("ALTER TABLE tasks ADD COLUMN interaction_stream_id TEXT NOT NULL DEFAULT ''");
    const artifactColumns = this.database.prepare('PRAGMA table_info(artifacts)').all() as Row[];
    if (!artifactColumns.some((column) => column.name === 'work_item_id')) this.database.exec("ALTER TABLE artifacts ADD COLUMN work_item_id TEXT NOT NULL DEFAULT ''");
  }

  createTask(task: Task, input: TaskInput): { task: Task; created: boolean } {
    const existingTaskId = this.findTaskIdByEvent(input.eventId);
    if (existingTaskId) {
      const existing = this.getTask(existingTaskId);
      if (!existing) throw new Error(`Task missing for event ${input.eventId}`);
      return { task: existing, created: false };
    }

    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(`
        INSERT INTO tasks (
          id, work_item_id, interaction_stream_id, title, origin, conversation_ref, pi_session_id, status, surface,
          created_at, updated_at, last_error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        task.id,
        task.workItemId,
        task.interactionStreamId,
        task.title,
        task.origin,
        task.conversationRef,
        task.piSessionId,
        task.status,
        task.surface,
        task.createdAt,
        task.updatedAt,
        task.lastError,
      );
      this.insertInput(input, task.id);
      this.insertMessage({
        id: createId('msg'),
        taskId: task.id,
        role: 'user',
        content: input.text,
        createdAt: input.receivedAt,
      });
      this.database.exec('COMMIT');
      return { task: this.getTask(task.id) as Task, created: true };
    } catch (error) {
      this.database.exec('ROLLBACK');
      const racedTaskId = this.findTaskIdByEvent(input.eventId);
      if (racedTaskId) return { task: this.getTask(racedTaskId) as Task, created: false };
      throw error;
    }
  }

  appendInput(taskId: string, input: TaskInput): boolean {
    if (this.findTaskIdByEvent(input.eventId)) return false;
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.insertInput(input, taskId);
      this.insertMessage({
        id: createId('msg'),
        taskId,
        role: 'user',
        content: input.text,
        createdAt: input.receivedAt,
      });
      this.database.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(input.receivedAt, taskId);
      this.database.exec('COMMIT');
      return true;
    } catch (error) {
      this.database.exec('ROLLBACK');
      if (this.findTaskIdByEvent(input.eventId)) return false;
      throw error;
    }
  }

  private insertInput(input: TaskInput, taskId: string): void {
    this.database.prepare(`
      INSERT INTO task_inputs (
        event_id, task_id, source, sender_id, text, attachments_json,
        reply_to_message_id, conversation_ref, received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.eventId,
      taskId,
      input.source,
      input.senderId,
      input.text,
      JSON.stringify(input.attachments),
      input.replyToMessageId,
      input.conversationRef,
      input.receivedAt,
    );
  }

  private insertMessage(message: TaskMessage): void {
    this.database.prepare(`
      INSERT INTO task_messages (id, task_id, role, content, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(message.id, message.taskId, message.role, message.content, message.createdAt);
  }

  appendMessage(taskId: string, role: TaskMessage['role'], content: string, createdAt = new Date().toISOString()): TaskMessage {
    const message: TaskMessage = { id: createId('msg'), taskId, role, content, createdAt };
    this.insertMessage(message);
    this.database.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(createdAt, taskId);
    return message;
  }

  appendEvent(
    taskId: string,
    type: TaskEventType,
    summary: string,
    options: { progress?: number | null; artifacts?: ArtifactRef[]; occurredAt?: string } = {},
  ): TaskEvent {
    const row = this.database.prepare('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM task_events WHERE task_id = ?').get(taskId) as Row;
    const event: TaskEvent = {
      id: createId('evt'),
      taskId,
      workItemId: this.getTask(taskId)?.workItemId ?? taskId,
      seq: Number(row.max_seq ?? 0) + 1,
      type,
      summary,
      progress: options.progress ?? null,
      artifacts: options.artifacts ?? [],
      occurredAt: options.occurredAt ?? new Date().toISOString(),
    };
    this.database.prepare(`
      INSERT INTO task_events (id, task_id, seq, type, summary, progress, artifacts_json, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      taskId,
      event.seq,
      event.type,
      event.summary,
      event.progress,
      JSON.stringify(event.artifacts),
      event.occurredAt,
    );
    return event;
  }

  addArtifact(artifact: ArtifactRef): ArtifactRef {
    this.database.prepare(`
      INSERT OR REPLACE INTO artifacts (
        id, task_id, work_item_id, kind, title, mime_type, local_ref, share_ref, preview_text, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      artifact.id,
      artifact.taskId,
      artifact.workItemId,
      artifact.kind,
      artifact.title,
      artifact.mimeType,
      artifact.localRef,
      artifact.shareRef,
      artifact.previewText,
      artifact.createdAt,
    );
    return artifact;
  }

  setStatus(taskId: string, status: TaskStatus, options: { error?: string | null; updatedAt?: string } = {}): void {
    this.database.prepare(`
      UPDATE tasks SET status = ?, last_error = ?, updated_at = ? WHERE id = ?
    `).run(status, options.error ?? null, options.updatedAt ?? new Date().toISOString(), taskId);
  }

  setPiSession(taskId: string, sessionId: string): void {
    this.database.prepare('UPDATE tasks SET pi_session_id = ?, updated_at = ? WHERE id = ?')
      .run(sessionId, new Date().toISOString(), taskId);
  }

  recordAudit(taskId: string, toolName: string, target: string | null, outcome: string, detail: string): void {
    this.database.prepare(`
      INSERT INTO audit_log (id, task_id, tool_name, target, outcome, detail, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(createId('audit'), taskId, toolName, target, outcome, detail, new Date().toISOString());
  }

  findTaskIdByEvent(eventId: string): string | null {
    const row = this.database.prepare('SELECT task_id FROM task_inputs WHERE event_id = ?').get(eventId) as Row | undefined;
    return row ? asString(row.task_id) : null;
  }

  hasInputEvent(eventId: string): boolean {
    return this.findTaskIdByEvent(eventId) !== null;
  }

  getTask(taskId: string): Task | null {
    const row = this.database.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Row | undefined;
    return row ? this.rowToTask(row) : null;
  }

  listTasks(query = '', limit = 100): Task[] {
    const normalized = query.trim();
    const rows = normalized
      ? this.database.prepare(`
          SELECT * FROM tasks
          WHERE title LIKE ? OR id LIKE ?
          ORDER BY updated_at DESC LIMIT ?
        `).all(`%${normalized}%`, `%${normalized}%`, limit) as Row[]
      : this.database.prepare('SELECT * FROM tasks ORDER BY updated_at DESC LIMIT ?').all(limit) as Row[];
    return rows.map((row) => this.rowToTask(row));
  }

  getSnapshot(taskId: string): TaskSnapshot | null {
    const task = this.getTask(taskId);
    if (!task) return null;
    const eventRows = this.database.prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY seq ASC').all(taskId) as Row[];
    const messageRows = this.database.prepare('SELECT * FROM task_messages WHERE task_id = ? ORDER BY created_at ASC, rowid ASC').all(taskId) as Row[];
    return {
      task,
      events: eventRows.map((row) => ({
        id: asString(row.id),
        taskId: asString(row.task_id),
        workItemId: task.workItemId,
        seq: Number(row.seq),
        type: asString(row.type) as TaskEventType,
        summary: asString(row.summary),
        progress: row.progress === null ? null : Number(row.progress),
        artifacts: parseJson<ArtifactRef[]>(row.artifacts_json, []),
        occurredAt: asString(row.occurred_at),
      })),
      messages: messageRows.map((row) => ({
        id: asString(row.id),
        taskId: asString(row.task_id),
        role: asString(row.role) as TaskMessage['role'],
        content: asString(row.content),
        createdAt: asString(row.created_at),
      })),
    };
  }

  private rowToTask(row: Row): Task {
    const artifactRows = this.database.prepare('SELECT * FROM artifacts WHERE task_id = ? ORDER BY created_at DESC').all(asString(row.id)) as Row[];
    return {
      id: asString(row.id),
      workItemId: asString(row.work_item_id) || asString(row.id),
      interactionStreamId: asString(row.interaction_stream_id) || asString(row.conversation_ref) || asString(row.id),
      title: asString(row.title),
      origin: asString(row.origin) as Task['origin'],
      conversationRef: row.conversation_ref === null ? null : asString(row.conversation_ref),
      piSessionId: row.pi_session_id === null ? null : asString(row.pi_session_id),
      status: asString(row.status) as TaskStatus,
      surface: asString(row.surface) as Task['surface'],
      createdAt: asString(row.created_at),
      updatedAt: asString(row.updated_at),
      lastError: row.last_error === null ? null : asString(row.last_error),
      artifacts: artifactRows.map((artifact) => ({
        id: asString(artifact.id),
        taskId: asString(artifact.task_id),
        workItemId: asString(artifact.work_item_id) || asString(row.work_item_id) || asString(row.id),
        kind: asString(artifact.kind) as ArtifactRef['kind'],
        title: asString(artifact.title),
        mimeType: artifact.mime_type === null ? null : asString(artifact.mime_type),
        localRef: artifact.local_ref === null ? null : asString(artifact.local_ref),
        shareRef: artifact.share_ref === null ? null : asString(artifact.share_ref),
        previewText: artifact.preview_text === null ? null : asString(artifact.preview_text),
        createdAt: asString(artifact.created_at),
      })),
    };
  }

  close(): void {
    this.database.close();
  }
}
