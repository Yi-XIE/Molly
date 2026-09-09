import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { WorkItem, WorkItemCard, WorkItemStatus } from '@molly/contracts';
import { createId } from './ids.js';

type Row = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

function rowToWorkItem(row: Row): WorkItem {
  return {
    id: text(row.id),
    title: text(row.title),
    goal: text(row.goal),
    status: text(row.status) as WorkItemStatus,
    parentId: row.parent_id === null ? null : text(row.parent_id),
    piSessionPath: row.pi_session_path === null ? null : text(row.pi_session_path),
    workspacePath: text(row.workspace_path),
    currentSummary: text(row.current_summary),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

export class WorkItemRepository {
  constructor(
    private readonly database: DatabaseSync,
    private readonly workspaceRoot: string,
  ) {
    mkdirSync(workspaceRoot, { recursive: true });
    database.exec(`
      CREATE TABLE IF NOT EXISTS work_items (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        goal TEXT NOT NULL,
        status TEXT NOT NULL,
        parent_id TEXT,
        pi_session_path TEXT,
        workspace_path TEXT NOT NULL,
        current_summary TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS work_items_status_idx ON work_items(status, updated_at);
    `);
  }

  create(input: { title: string; goal: string; parentId?: string | null; id?: string }): WorkItem {
    const now = new Date().toISOString();
    const id = input.id ?? createId('work');
    const workspacePath = join(this.workspaceRoot, id);
    mkdirSync(join(workspacePath, 'session'), { recursive: true });
    mkdirSync(join(workspacePath, 'working'), { recursive: true });
    mkdirSync(join(workspacePath, 'artifacts'), { recursive: true });
    const item: WorkItem = {
      id,
      title: input.title.trim(),
      goal: input.goal.trim(),
      status: 'active',
      parentId: input.parentId ?? null,
      piSessionPath: null,
      workspacePath,
      currentSummary: '',
      createdAt: now,
      updatedAt: now,
    };
    this.database.prepare(`
      INSERT INTO work_items (id, title, goal, status, parent_id, pi_session_path, workspace_path, current_summary, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(item.id, item.title, item.goal, item.status, item.parentId, item.piSessionPath, item.workspacePath, item.currentSummary, item.createdAt, item.updatedAt);
    return item;
  }

  get(id: string): WorkItem | null {
    const row = this.database.prepare('SELECT * FROM work_items WHERE id = ?').get(id) as Row | undefined;
    return row ? rowToWorkItem(row) : null;
  }

  list(status?: WorkItemStatus): WorkItem[] {
    const rows = status
      ? this.database.prepare('SELECT * FROM work_items WHERE status = ? ORDER BY updated_at DESC').all(status) as Row[]
      : this.database.prepare('SELECT * FROM work_items ORDER BY updated_at DESC').all() as Row[];
    return rows.map(rowToWorkItem);
  }

  cards(): WorkItemCard[] {
    return this.list('active').map((item) => ({
      id: item.id,
      title: item.title,
      goal: item.goal,
      tags: [],
      recentSummary: item.currentSummary,
      lastActiveAt: item.updatedAt,
    }));
  }

  update(id: string, patch: Partial<Pick<WorkItem, 'title' | 'goal' | 'status' | 'piSessionPath' | 'currentSummary'>>): WorkItem {
    const current = this.get(id);
    if (!current) throw new Error(`找不到工作项：${id}`);
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.database.prepare(`
      UPDATE work_items SET title = ?, goal = ?, status = ?, pi_session_path = ?, current_summary = ?, updated_at = ? WHERE id = ?
    `).run(next.title, next.goal, next.status, next.piSessionPath, next.currentSummary, next.updatedAt, id);
    return next;
  }
}
