import type { DatabaseSync } from 'node:sqlite';
import { createId } from './ids.js';

export type MemoryScope = 'global' | 'work_item' | 'sensitive';

export interface MemoryRecallOptions {
  workItemId: string;
  includeGlobal?: boolean;
  includeSensitive?: boolean;
  limit?: number;
}

export interface MemoryEntry {
  id: string;
  kind: 'profile' | 'preference' | 'experience' | 'goal' | 'method';
  content: string;
  source: string;
  confidence: number;
  scope: MemoryScope;
  workItemId: string | null;
  createdAt: string;
  updatedAt: string;
  supersededBy: string | null;
  deletedAt: string | null;
}

export interface MemoryService {
  recall(query: string, options: MemoryRecallOptions): Promise<MemoryEntry[]>;
  write(entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'updatedAt' | 'supersededBy' | 'deletedAt'>): Promise<MemoryEntry>;
  correct(id: string, content: string, source: string): Promise<MemoryEntry>;
  forget(id: string): Promise<boolean>;
}

type MemoryRow = Record<string, unknown>;

function rowToMemory(row: MemoryRow): MemoryEntry {
  return {
    id: String(row.id),
    kind: String(row.kind) as MemoryEntry['kind'],
    content: String(row.content),
    source: String(row.source),
    confidence: Number(row.confidence),
    scope: String(row.scope ?? 'global') as MemoryScope,
    workItemId: row.work_item_id === null || row.work_item_id === undefined ? null : String(row.work_item_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    supersededBy: row.superseded_by === null ? null : String(row.superseded_by),
    deletedAt: row.deleted_at === null ? null : String(row.deleted_at),
  };
}

export class SqliteMemoryService implements MemoryService {
  constructor(private readonly database: DatabaseSync) {
    const columns = database.prepare('PRAGMA table_info(memories)').all() as Array<{ name?: string }>;
    if (!columns.some((column) => column.name === 'scope')) {
      database.exec("ALTER TABLE memories ADD COLUMN scope TEXT NOT NULL DEFAULT 'global'");
    }
    if (!columns.some((column) => column.name === 'work_item_id')) {
      database.exec('ALTER TABLE memories ADD COLUMN work_item_id TEXT');
    }
  }

  async recall(query: string, options: MemoryRecallOptions): Promise<MemoryEntry[]> {
    const includeGlobal = options.includeGlobal ?? true;
    const includeSensitive = options.includeSensitive ?? true;
    const scopes = [
      includeGlobal ? "scope = 'global'" : '',
      "(scope = 'work_item' AND work_item_id = ?)",
      includeSensitive ? "(scope = 'sensitive' AND work_item_id = ?)" : '',
    ].filter(Boolean).join(' OR ');
    const parameters: Array<string | number> = [`%${query.trim()}%`, options.workItemId];
    if (includeSensitive) parameters.push(options.workItemId);
    parameters.push(options.limit ?? 12);
    const rows = this.database.prepare(`
      SELECT * FROM memories
      WHERE deleted_at IS NULL AND superseded_by IS NULL AND content LIKE ? AND (${scopes})
      ORDER BY confidence DESC, updated_at DESC LIMIT ?
    `).all(...parameters) as MemoryRow[];
    return rows.map(rowToMemory);
  }

  async write(entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'updatedAt' | 'supersededBy' | 'deletedAt'>): Promise<MemoryEntry> {
    if (entry.scope !== 'global' && !entry.workItemId) throw new Error('工作项记忆必须绑定 workItemId。');
    if (entry.scope === 'global' && entry.workItemId) throw new Error('全局记忆不能绑定工作项。');
    const now = new Date().toISOString();
    const memory: MemoryEntry = {
      ...entry,
      id: createId('mem'),
      createdAt: now,
      updatedAt: now,
      supersededBy: null,
      deletedAt: null,
    };
    this.database.prepare(`
      INSERT INTO memories (
        id, kind, content, source, confidence, scope, work_item_id,
        created_at, updated_at, superseded_by, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      memory.id,
      memory.kind,
      memory.content,
      memory.source,
      memory.confidence,
      memory.scope,
      memory.workItemId,
      memory.createdAt,
      memory.updatedAt,
      null,
      null,
    );
    return memory;
  }

  async correct(id: string, content: string, source: string): Promise<MemoryEntry> {
    const current = this.database.prepare('SELECT * FROM memories WHERE id = ? AND deleted_at IS NULL').get(id) as MemoryRow | undefined;
    if (!current) throw new Error('找不到需要纠正的记忆。');
    const replacement = await this.write({
      kind: String(current.kind) as MemoryEntry['kind'],
      content,
      source,
      confidence: Number(current.confidence),
      scope: String(current.scope ?? 'global') as MemoryScope,
      workItemId: current.work_item_id === null || current.work_item_id === undefined ? null : String(current.work_item_id),
    });
    this.database.prepare('UPDATE memories SET superseded_by = ?, updated_at = ? WHERE id = ?')
      .run(replacement.id, replacement.updatedAt, id);
    return replacement;
  }

  async forget(id: string): Promise<boolean> {
    const result = this.database.prepare('UPDATE memories SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
      .run(new Date().toISOString(), new Date().toISOString(), id);
    return result.changes > 0;
  }
}
