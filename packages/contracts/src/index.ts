import { z } from 'zod';

export const TASK_STATUSES = [
  'queued_offline',
  'queued',
  'running',
  'waiting_input',
  'completed',
  'failed',
  'canceled',
] as const;

export const INTERACTION_SURFACES = ['conversation', 'summon'] as const;

export const SUMMON_STATES = [
  'idle',
  'listening',
  'transcribing',
  'queued',
  'thinking',
  'acting',
  'needs_attention',
  'completed',
  'failed',
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type InteractionSurface = (typeof INTERACTION_SURFACES)[number];
export type SummonState = (typeof SUMMON_STATES)[number];
export type TaskOrigin = 'desktop' | 'feishu';
export type ArtifactKind = 'document' | 'web' | 'todo' | 'file' | 'note' | 'text';
export type MessageRole = 'user' | 'assistant' | 'system';

export type WorkItemStatus = 'active' | 'paused' | 'completed' | 'archived';

export interface WorkItem {
  id: string;
  title: string;
  goal: string;
  status: WorkItemStatus;
  parentId: string | null;
  piSessionPath: string | null;
  workspacePath: string;
  currentSummary: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkItemCard {
  id: string;
  title: string;
  goal: string;
  tags: string[];
  recentSummary: string;
  lastActiveAt: string;
}

export interface RouteDecision {
  action: 'continue' | 'switch' | 'ask';
  fromWorkItemId: string;
  toWorkItemId: string | null;
  confidence: number;
  reason: string;
}

export interface ContextCapsule {
  version: number;
  workItemId: string;
  goal: string;
  confirmedFacts: string[];
  confirmedDecisions: string[];
  constraints: string[];
  allowedArtifactIds: string[];
  openQuestions: string[];
  sources: Array<{ type: 'rule' | 'memory' | 'artifact' | 'work_item'; id: string; reason: string }>;
  compiledAt: string;
}

export interface ArtifactRef {
  id: string;
  taskId: string;
  workItemId: string;
  kind: ArtifactKind;
  title: string;
  mimeType: string | null;
  localRef: string | null;
  shareRef: string | null;
  previewText: string | null;
  createdAt: string;
}

export interface Task {
  id: string;
  workItemId: string;
  interactionStreamId: string;
  title: string;
  origin: TaskOrigin;
  conversationRef: string | null;
  piSessionId: string | null;
  status: TaskStatus;
  surface: InteractionSurface;
  createdAt: string;
  updatedAt: string;
  lastError: string | null;
  artifacts: ArtifactRef[];
}

export interface TaskAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  sourceRef: string;
}

export interface TaskInput {
  eventId: string;
  taskId?: string;
  source: TaskOrigin;
  senderId: string;
  text: string;
  attachments: TaskAttachment[];
  replyToMessageId: string | null;
  conversationRef: string | null;
  receivedAt: string;
}

export type TaskEventType =
  | 'created'
  | 'queued'
  | 'started'
  | 'progress'
  | 'message'
  | 'artifact'
  | 'waiting_input'
  | 'completed'
  | 'failed'
  | 'canceled';

export interface TaskEvent {
  id: string;
  taskId: string;
  workItemId: string;
  seq: number;
  type: TaskEventType;
  summary: string;
  progress: number | null;
  artifacts: ArtifactRef[];
  occurredAt: string;
}

export interface TaskMessage {
  id: string;
  taskId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
}

export interface TaskSnapshot {
  task: Task;
  events: TaskEvent[];
  messages: TaskMessage[];
}

export interface EncryptedEnvelope {
  version: 1;
  ephemeralPublicKey: string;
  iv: string;
  ciphertext: string;
  authTag: string;
}

export interface GatewayJob {
  id: string;
  taskId: string;
  eventId: string;
  envelope: EncryptedEnvelope;
  expiresAt: string;
}

export type NodeInboundFrame =
  | { type: 'job'; job: GatewayJob }
  | { type: 'cancel'; taskId: string }
  | { type: 'pause'; paused: boolean };

export type NodeOutboundFrame =
  | { type: 'ready'; nodeId: string }
  | { type: 'job_ack'; jobId: string; taskId: string }
  | { type: 'task_event'; event: TaskEvent }
  | { type: 'task_result'; taskId: string; summary: string; artifacts: ArtifactRef[] }
  | { type: 'heartbeat'; occurredAt: string };

export const taskInputSchema = z.object({
  eventId: z.string().min(1),
  taskId: z.string().min(1).optional(),
  source: z.enum(['desktop', 'feishu']),
  senderId: z.string().min(1),
  text: z.string().trim().min(1),
  attachments: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    mimeType: z.string().min(1),
    size: z.number().int().nonnegative(),
    sourceRef: z.string().min(1),
  })).default([]),
  replyToMessageId: z.string().nullable().default(null),
  conversationRef: z.string().nullable().default(null),
  receivedAt: z.string().datetime(),
});

export const artifactRefSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  workItemId: z.string().min(1),
  kind: z.enum(['document', 'web', 'todo', 'file', 'note', 'text']),
  title: z.string().min(1),
  mimeType: z.string().nullable(),
  localRef: z.string().nullable(),
  shareRef: z.string().nullable(),
  previewText: z.string().nullable(),
  createdAt: z.string().datetime(),
}) satisfies z.ZodType<ArtifactRef>;

export const taskEventSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  workItemId: z.string().min(1),
  seq: z.number().int().positive(),
  type: z.enum(['created', 'queued', 'started', 'progress', 'message', 'artifact', 'waiting_input', 'completed', 'failed', 'canceled']),
  summary: z.string(),
  progress: z.number().min(0).max(1).nullable(),
  artifacts: z.array(artifactRefSchema),
  occurredAt: z.string().datetime(),
}) satisfies z.ZodType<TaskEvent>;

export const nodeOutboundFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), nodeId: z.string().min(1) }),
  z.object({ type: z.literal('job_ack'), jobId: z.string().min(1), taskId: z.string().min(1) }),
  z.object({ type: z.literal('task_event'), event: taskEventSchema }),
  z.object({
    type: z.literal('task_result'),
    taskId: z.string().min(1),
    summary: z.string(),
    artifacts: z.array(artifactRefSchema),
  }),
  z.object({ type: z.literal('heartbeat'), occurredAt: z.string().datetime() }),
]);

const encryptedEnvelopeSchema = z.object({
  version: z.literal(1),
  ephemeralPublicKey: z.string().min(1),
  iv: z.string().min(1),
  ciphertext: z.string().min(1),
  authTag: z.string().min(1),
});

export const nodeInboundFrameSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('job'),
    job: z.object({
      id: z.string().min(1),
      taskId: z.string().min(1),
      eventId: z.string().min(1),
      envelope: encryptedEnvelopeSchema,
      expiresAt: z.string().datetime(),
    }),
  }),
  z.object({ type: z.literal('cancel'), taskId: z.string().min(1) }),
  z.object({ type: z.literal('pause'), paused: z.boolean() }),
]);

export function taskTitle(text: string, maxLength = 42): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}
