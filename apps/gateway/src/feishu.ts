import { createHash, timingSafeEqual } from 'node:crypto';
import type { ArtifactRef, TaskEvent, TaskInput, TaskStatus } from '@molly/contracts';
import type { GatewayConfig } from './config.js';

type JsonRecord = Record<string, unknown>;
type FetchLike = typeof fetch;

export interface ParsedFeishuMessage {
  input: TaskInput;
  messageId: string;
  replyMessageIds: string[];
  receiveId: string;
}

export type ParsedFeishuEvent =
  | { kind: 'challenge'; challenge: string }
  | { kind: 'message'; message: ParsedFeishuMessage }
  | { kind: 'ignored'; reason: string };

export interface ParsedCardAction {
  action: 'cancel' | 'pause' | 'resume';
  taskId: string | null;
  operatorOpenId: string;
}

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' ? value as JsonRecord : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function eventTime(value: string): string {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    const millis = value.length <= 10 ? numeric * 1000 : numeric;
    return new Date(millis).toISOString();
  }
  return new Date().toISOString();
}

export function verifyFeishuSignature(
  rawBody: string,
  headers: Pick<Headers, 'get'>,
  encryptKey: string,
): boolean {
  const signature = headers.get('x-lark-signature') ?? '';
  if (!signature) return !encryptKey;
  if (!encryptKey) return false;
  const timestamp = headers.get('x-lark-request-timestamp') ?? '';
  const nonce = headers.get('x-lark-request-nonce') ?? '';
  if (!timestamp || !nonce) return false;
  const expected = createHash('sha256').update(`${timestamp}${nonce}${encryptKey}${rawBody}`).digest('hex');
  return constantTimeEqual(expected, signature);
}

function parseTextContent(content: unknown): string {
  try {
    const parsed = typeof content === 'string' ? JSON.parse(content) as JsonRecord : record(content);
    return text(parsed.text).trim();
  } catch {
    return '';
  }
}

export function parseFeishuEvent(body: unknown, config: GatewayConfig): ParsedFeishuEvent {
  const payload = record(body);
  const challenge = text(payload.challenge);
  if (challenge) {
    const token = text(payload.token);
    if (config.feishu.verificationToken && token !== config.feishu.verificationToken) {
      return { kind: 'ignored', reason: 'verification_token_mismatch' };
    }
    return { kind: 'challenge', challenge };
  }

  const header = record(payload.header);
  if (config.feishu.verificationToken && text(header.token) !== config.feishu.verificationToken) {
    return { kind: 'ignored', reason: 'verification_token_mismatch' };
  }
  if (text(header.event_type) !== 'im.message.receive_v1') {
    return { kind: 'ignored', reason: 'unsupported_event' };
  }

  const event = record(payload.event);
  const sender = record(event.sender);
  const senderId = record(sender.sender_id);
  const openId = text(senderId.open_id);
  const message = record(event.message);
  if (text(message.chat_type) !== 'p2p') return { kind: 'ignored', reason: 'group_disabled' };
  if (!config.ownerOpenId || openId !== config.ownerOpenId) return { kind: 'ignored', reason: 'owner_only' };
  if (text(message.message_type) !== 'text') return { kind: 'ignored', reason: 'text_only' };

  const content = parseTextContent(message.content);
  const messageId = text(message.message_id);
  const chatId = text(message.chat_id);
  const eventId = text(header.event_id);
  if (!content || !messageId || !chatId || !eventId) return { kind: 'ignored', reason: 'invalid_message' };

  const replyMessageIds = [text(message.parent_id), text(message.root_id)].filter((value, index, all) => value && all.indexOf(value) === index);
  return {
    kind: 'message',
    message: {
      input: {
        eventId,
        source: 'feishu',
        senderId: openId,
        text: content,
        attachments: [],
        replyToMessageId: replyMessageIds[0] ?? null,
        conversationRef: chatId,
        receivedAt: eventTime(text(header.create_time)),
      },
      messageId,
      replyMessageIds,
      receiveId: openId,
    },
  };
}

export function parseCardAction(body: unknown, config: GatewayConfig): ParsedCardAction | null {
  const payload = record(body);
  const header = record(payload.header);
  if (config.feishu.verificationToken && text(header.token) !== config.feishu.verificationToken) return null;
  const event = record(payload.event);
  const operator = record(event.operator);
  const operatorId = record(operator.operator_id);
  const operatorOpenId = text(operatorId.open_id);
  if (!config.ownerOpenId || operatorOpenId !== config.ownerOpenId) return null;
  const action = record(event.action);
  const value = record(action.value);
  const name = text(value.action);
  if (name !== 'cancel' && name !== 'pause' && name !== 'resume') return null;
  return { action: name, taskId: text(value.taskId) || null, operatorOpenId };
}

function statusCopy(status: TaskStatus): { title: string; template: string; detail: string } {
  if (status === 'queued_offline') return { title: 'Molly 已收下', template: 'grey', detail: '已排队，等待个人节点上线。' };
  if (status === 'queued') return { title: 'Molly 已收下', template: 'blue', detail: '个人节点在线，任务即将开始。' };
  if (status === 'running') return { title: 'Molly 正在处理', template: 'blue', detail: '任务正在个人节点上安全执行。' };
  if (status === 'waiting_input') return { title: 'Molly 需要你确认', template: 'orange', detail: '任务遇到受保护操作，请回到任务继续确认。' };
  if (status === 'completed') return { title: 'Molly 已完成', template: 'green', detail: '任务已经完成。' };
  if (status === 'failed') return { title: 'Molly 需要恢复', template: 'red', detail: '任务执行失败，可以补充信息后重试。' };
  if (status === 'canceled') return { title: 'Molly 已停止', template: 'grey', detail: '任务已停止。' };
  return { title: 'Molly 已收下', template: 'blue', detail: '任务已进入队列。' };
}

function safeCardText(value: string, limit = 3600): string {
  return value.replace(/[<>]/g, '').slice(0, limit);
}

export function buildTaskCard(input: {
  taskId: string;
  status: TaskStatus;
  summary?: string;
  artifacts?: ArtifactRef[];
  event?: TaskEvent;
  paused?: boolean;
}): JsonRecord {
  const copy = statusCopy(input.status);
  const summary = safeCardText(input.summary || input.event?.summary || copy.detail);
  const artifactLines = (input.artifacts ?? []).filter((item) => item.shareRef).slice(0, 5).map((item) => `- [${safeCardText(item.title, 80)}](${item.shareRef})`);
  const markdown = [`**${copy.detail}**`, '', summary, '', `任务编号：${input.taskId}`, ...artifactLines].join('\n').trim();
  const actions: JsonRecord[] = [];
  if (!['completed', 'failed', 'canceled'].includes(input.status)) {
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '停止任务' },
      type: 'danger',
      value: { action: 'cancel', taskId: input.taskId },
    });
  }
  actions.push({
    tag: 'button',
    text: { tag: 'plain_text', content: input.paused ? '恢复 Molly' : '暂停 Molly' },
    type: 'default',
    value: { action: input.paused ? 'resume' : 'pause', taskId: input.taskId },
  });
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      title: { tag: 'plain_text', content: copy.title },
      template: copy.template,
    },
    body: {
      elements: [
        { tag: 'markdown', content: markdown },
        { tag: 'action', actions },
      ],
    },
  };
}

export class FeishuClient {
  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;

  constructor(
    private readonly config: GatewayConfig['feishu'],
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private async tenantToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt) return this.accessToken;
    if (!this.config.appId || !this.config.appSecret) throw new Error('飞书应用凭据尚未配置。');
    const response = await this.fetchImpl('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app_id: this.config.appId, app_secret: this.config.appSecret }),
    });
    const payload = await response.json() as JsonRecord;
    if (!response.ok || Number(payload.code ?? 0) !== 0 || !text(payload.tenant_access_token)) {
      throw new Error(`飞书凭据交换失败，状态码 ${response.status}。`);
    }
    this.accessToken = text(payload.tenant_access_token);
    const expires = Number(payload.expire ?? 7200);
    this.accessTokenExpiresAt = Date.now() + Math.max(60, expires - 120) * 1000;
    return this.accessToken;
  }

  private async request(path: string, init: RequestInit): Promise<JsonRecord> {
    const token = await this.tenantToken();
    const response = await this.fetchImpl(`https://open.feishu.cn${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...init.headers },
    });
    const payload = await response.json() as JsonRecord;
    if (!response.ok || Number(payload.code ?? 0) !== 0) {
      throw new Error(`飞书消息操作失败，状态码 ${response.status}，业务码 ${String(payload.code ?? '')}。`);
    }
    return payload;
  }

  async sendTaskCard(receiveId: string, card: JsonRecord): Promise<string> {
    const payload = await this.request('/open-apis/im/v1/messages?receive_id_type=open_id', {
      method: 'POST',
      body: JSON.stringify({ receive_id: receiveId, msg_type: 'interactive', content: JSON.stringify(card) }),
    });
    const data = record(payload.data);
    const messageId = text(data.message_id);
    if (!messageId) throw new Error('飞书没有返回卡片消息编号。');
    return messageId;
  }

  async updateTaskCard(messageId: string, card: JsonRecord): Promise<void> {
    await this.request(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, {
      method: 'PUT',
      body: JSON.stringify({ msg_type: 'interactive', content: JSON.stringify(card) }),
    });
  }
}
