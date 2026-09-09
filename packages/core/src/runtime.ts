import type { ArtifactRef, Task, TaskInput } from '@molly/contracts';

export type RuntimeUpdate =
  | { type: 'session_ready'; taskId: string; sessionId: string }
  | { type: 'thinking'; taskId: string; summary: string }
  | { type: 'acting'; taskId: string; toolName: string; target: string | null }
  | { type: 'tool_finished'; taskId: string; toolName: string; ok: boolean; target: string | null }
  | { type: 'assistant_delta'; taskId: string; delta: string }
  | { type: 'protected'; taskId: string; summary: string }
  | { type: 'artifact'; taskId: string; artifact: ArtifactRef };

export interface RuntimeResult {
  sessionId: string;
  summary: string;
  artifacts: ArtifactRef[];
}

export type RuntimeListener = (update: RuntimeUpdate) => void;

export interface RuntimeAdapter {
  createTask(task: Task, input: TaskInput): Promise<RuntimeResult>;
  steerTask(task: Task, input: TaskInput): Promise<RuntimeResult>;
  cancelTask(taskId: string): Promise<void>;
  subscribe(listener: RuntimeListener): () => void;
  dispose(): Promise<void>;
}
