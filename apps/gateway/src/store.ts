import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { EncryptedEnvelope, GatewayJob, TaskEvent, TaskStatus } from '@molly/contracts';
import { createId } from '@molly/core';

type Row = Record<string, unknown>;

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface GatewayTaskRecord {
  id: string;
  status: TaskStatus;
  nodeId: string;
  lastSeq: number;
  cardMessageId: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface CreateJobResult {
  job: GatewayJob | null;
  created: boolean;
  taskId: string;
}

export class GatewayStore {
  readonly database: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        public_key TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS gateway_tasks (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        node_id TEXT NOT NULL,
        last_seq INTEGER NOT NULL DEFAULT 0,
        card_message_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        event_id TEXT NOT NULL UNIQUE,
        envelope_json TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS jobs_node_idx ON jobs(node_id, created_at);
      CREATE TABLE IF NOT EXISTS inbound_events (
        event_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS feishu_messages (
        message_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS gateway_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  registerNode(nodeId: string, publicKey: string, token: string): void {
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO nodes (id, public_key, token_hash, created_at, last_seen_at, active)
      VALUES (?, ?, ?, ?, ?, 1)
      ON CONFLICT(id) DO UPDATE SET
        public_key = excluded.public_key,
        token_hash = excluded.token_hash,
        last_seen_at = excluded.last_seen_at,
        active = 1
    `).run(nodeId, publicKey, digest(token), now, now);
  }

  authenticateNode(nodeId: string, token: string): boolean {
    const row = this.database.prepare('SELECT token_hash FROM nodes WHERE id = ? AND active = 1').get(nodeId) as Row | undefined;
    if (!row) return false;
    const incoming = digest(token);
    const stored = String(row.token_hash);
    const valid = safeEqual(incoming, stored);
    if (valid) this.database.prepare('UPDATE nodes SET last_seen_at = ? WHERE id = ?').run(new Date().toISOString(), nodeId);
    return valid;
  }

  getActiveNode(): { id: string; publicKey: string } | null {
    const row = this.database.prepare('SELECT id, public_key FROM nodes WHERE active = 1 ORDER BY last_seen_at DESC LIMIT 1').get() as Row | undefined;
    return row ? { id: String(row.id), publicKey: String(row.public_key) } : null;
  }

  createJob(input: {
    taskId: string;
    nodeId: string;
    eventId: string;
    envelope: EncryptedEnvelope;
    status: TaskStatus;
  }): CreateJobResult {
    const previous = this.database.prepare('SELECT task_id FROM inbound_events WHERE event_id = ?').get(input.eventId) as Row | undefined;
    if (previous) {
      const existing = this.database.prepare('SELECT * FROM jobs WHERE event_id = ?').get(input.eventId) as Row | undefined;
      return { job: existing ? this.rowToJob(existing) : null, created: false, taskId: String(previous.task_id) };
    }
    const existingTask = this.database.prepare('SELECT id FROM gateway_tasks WHERE id = ?').get(input.taskId);
    const now = new Date();
    const expires = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const job: GatewayJob = {
      id: createId('job'),
      taskId: input.taskId,
      eventId: input.eventId,
      envelope: input.envelope,
      expiresAt: expires,
    };
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(`
        INSERT INTO inbound_events (event_id, task_id, created_at, expires_at)
        VALUES (?, ?, ?, ?)
      `).run(input.eventId, input.taskId, now.toISOString(), expires);
      if (!existingTask) {
        this.database.prepare(`
          INSERT INTO gateway_tasks (id, status, node_id, created_at, updated_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(input.taskId, input.status, input.nodeId, now.toISOString(), now.toISOString(), expires);
      } else {
        this.database.prepare('UPDATE gateway_tasks SET status = ?, updated_at = ? WHERE id = ?')
          .run(input.status, now.toISOString(), input.taskId);
      }
      this.database.prepare(`
        INSERT INTO jobs (id, task_id, node_id, event_id, envelope_json, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(job.id, job.taskId, input.nodeId, job.eventId, JSON.stringify(job.envelope), job.expiresAt, now.toISOString());
      this.database.exec('COMMIT');
      return { job, created: true, taskId: input.taskId };
    } catch (error) {
      this.database.exec('ROLLBACK');
      const racedEvent = this.database.prepare('SELECT task_id FROM inbound_events WHERE event_id = ?').get(input.eventId) as Row | undefined;
      if (racedEvent) {
        const racedJob = this.database.prepare('SELECT * FROM jobs WHERE event_id = ?').get(input.eventId) as Row | undefined;
        return {
          job: racedJob ? this.rowToJob(racedJob) : null,
          created: false,
          taskId: String(racedEvent.task_id),
        };
      }
      throw error;
    }
  }

  pendingJobs(nodeId: string): GatewayJob[] {
    const now = new Date().toISOString();
    this.database.prepare('DELETE FROM jobs WHERE expires_at <= ?').run(now);
    const rows = this.database.prepare('SELECT * FROM jobs WHERE node_id = ? ORDER BY created_at ASC').all(nodeId) as Row[];
    return rows.map((row) => this.rowToJob(row));
  }

  acknowledgeJob(jobId: string, taskId: string): boolean {
    const result = this.database.prepare('DELETE FROM jobs WHERE id = ? AND task_id = ?').run(jobId, taskId);
    if (result.changes > 0) this.setTaskStatus(taskId, 'running');
    return result.changes > 0;
  }

  applyTaskEvent(event: TaskEvent): boolean {
    const result = this.database.prepare(`
      UPDATE gateway_tasks SET status = ?, last_seq = ?, updated_at = ?
      WHERE id = ? AND last_seq < ?
    `).run(this.statusForEvent(event), event.seq, event.occurredAt, event.taskId, event.seq);
    return result.changes > 0;
  }

  private statusForEvent(event: TaskEvent): TaskStatus {
    if (event.type === 'completed') return 'completed';
    if (event.type === 'failed') return 'failed';
    if (event.type === 'canceled') return 'canceled';
    if (event.type === 'waiting_input') return 'waiting_input';
    if (event.type === 'queued') return 'queued';
    return 'running';
  }

  setTaskStatus(taskId: string, status: TaskStatus): void {
    this.database.prepare('UPDATE gateway_tasks SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, new Date().toISOString(), taskId);
  }

  cancelTask(taskId: string): void {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare('DELETE FROM jobs WHERE task_id = ?').run(taskId);
      this.setTaskStatus(taskId, 'canceled');
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  getTask(taskId: string): GatewayTaskRecord | null {
    const row = this.database.prepare('SELECT * FROM gateway_tasks WHERE id = ?').get(taskId) as Row | undefined;
    return row ? this.rowToTask(row) : null;
  }

  listTasks(): GatewayTaskRecord[] {
    const rows = this.database.prepare('SELECT * FROM gateway_tasks ORDER BY updated_at DESC').all() as Row[];
    return rows.map((row) => this.rowToTask(row));
  }

  setCardMessage(taskId: string, messageId: string): void {
    const now = new Date().toISOString();
    this.database.prepare('UPDATE gateway_tasks SET card_message_id = ?, updated_at = ? WHERE id = ?')
      .run(messageId, now, taskId);
    this.database.prepare('INSERT OR REPLACE INTO feishu_messages (message_id, task_id, created_at) VALUES (?, ?, ?)')
      .run(messageId, taskId, now);
  }

  rememberMessage(messageId: string, taskId: string): void {
    this.database.prepare('INSERT OR IGNORE INTO feishu_messages (message_id, task_id, created_at) VALUES (?, ?, ?)')
      .run(messageId, taskId, new Date().toISOString());
  }

  findTaskByMessage(messageId: string | null | undefined): string | null {
    if (!messageId) return null;
    const row = this.database.prepare('SELECT task_id FROM feishu_messages WHERE message_id = ?').get(messageId) as Row | undefined;
    return row ? String(row.task_id) : null;
  }

  setPaused(paused: boolean): void {
    this.database.prepare(`
      INSERT INTO gateway_state (key, value) VALUES ('paused', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(paused ? '1' : '0');
  }

  isPaused(): boolean {
    const row = this.database.prepare("SELECT value FROM gateway_state WHERE key = 'paused'").get() as Row | undefined;
    return row?.value === '1';
  }

  cleanup(): void {
    const now = new Date().toISOString();
    this.database.prepare('DELETE FROM jobs WHERE expires_at <= ?').run(now);
    this.database.prepare('DELETE FROM inbound_events WHERE expires_at <= ?').run(now);
    this.database.prepare('DELETE FROM gateway_tasks WHERE expires_at <= ? AND status IN (\'completed\', \'failed\', \'canceled\')').run(now);
  }

  private rowToJob(row: Row): GatewayJob {
    return {
      id: String(row.id),
      taskId: String(row.task_id),
      eventId: String(row.event_id),
      envelope: JSON.parse(String(row.envelope_json)) as EncryptedEnvelope,
      expiresAt: String(row.expires_at),
    };
  }

  private rowToTask(row: Row): GatewayTaskRecord {
    return {
      id: String(row.id),
      status: String(row.status) as TaskStatus,
      nodeId: String(row.node_id),
      lastSeq: Number(row.last_seq),
      cardMessageId: row.card_message_id === null ? null : String(row.card_message_id),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      expiresAt: String(row.expires_at),
    };
  }

  close(): void {
    this.database.close();
  }
}
