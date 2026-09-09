import type { ArtifactRef, Task, TaskInput } from '@molly/contracts';
import { createId } from './ids.js';
import type { RuntimeAdapter, RuntimeListener, RuntimeResult } from './runtime.js';

export class PreviewRuntimeAdapter implements RuntimeAdapter {
  private readonly listeners = new Set<RuntimeListener>();
  private readonly canceled = new Set<string>();

  subscribe(listener: RuntimeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(update: Parameters<RuntimeListener>[0]): void {
    for (const listener of this.listeners) listener(update);
  }

  private async run(task: Task, input: TaskInput): Promise<RuntimeResult> {
    const sessionId = task.piSessionId ?? createId('preview_session');
    this.emit({ type: 'session_ready', taskId: task.id, sessionId });
    this.emit({ type: 'thinking', taskId: task.id, summary: '正在整理目标与下一步' });
    await new Promise((resolve) => setTimeout(resolve, 180));
    if (this.canceled.has(task.id)) throw new Error('任务已停止');
    this.emit({ type: 'acting', taskId: task.id, toolName: 'molly_preview', target: '本地预览产物' });
    await new Promise((resolve) => setTimeout(resolve, 220));
    if (this.canceled.has(task.id)) throw new Error('任务已停止');
    this.emit({ type: 'tool_finished', taskId: task.id, toolName: 'molly_preview', ok: true, target: '本地预览产物' });
    const productInput = /产品|方案|需求|功能|用户|助手|agent|molly/i.test(input.text);
    const summary = productInput
      ? [
          '# 产品方案草案',
          '',
          `## 当前想法\n${input.text}`,
          '',
          '## 首版目标',
          '把这段想法收敛成一个可以验证的用户价值和最小行动闭环。',
          '',
          '## 建议先做',
          '1. 明确目标用户与触发场景。',
          '2. 定义一个可交付的首版产物。',
          '3. 用一次真实任务验证结果是否可用。',
          '',
          '## 待确认',
          '- 用户最希望 Molly 先替他完成哪一件事？',
          '- 完成后什么结果会让他愿意继续使用？',
          '',
          '当前处于预览运行模式。连接 Pi 模型凭据后，这里会继续追问、研究并修改真实文档。',
        ].join('\n')
      : [
          '我已经把这件事整理成一份可以继续推进的行动卡。',
          '',
          `你交给我的任务是：“${input.text}”`,
          '',
          '当前处于预览运行模式。连接 Pi 模型凭据后，这里会显示真实研究、文档修改与工具执行结果。',
        ].join('\n');
    const artifact: ArtifactRef = {
      id: createId('artifact'),
      taskId: task.id,
      workItemId: task.workItemId,
      kind: productInput ? 'document' : 'note',
      title: productInput ? '产品方案草案' : '任务行动卡',
      mimeType: 'text/markdown',
      localRef: null,
      shareRef: null,
      previewText: summary,
      createdAt: new Date().toISOString(),
      version: 1,
    };
    return { sessionId, summary, artifacts: [artifact] };
  }

  createTask(task: Task, input: TaskInput): Promise<RuntimeResult> {
    return this.run(task, input);
  }

  steerTask(task: Task, input: TaskInput): Promise<RuntimeResult> {
    this.canceled.delete(task.id);
    return this.run(task, input);
  }

  async cancelTask(taskId: string): Promise<void> {
    this.canceled.add(taskId);
  }

  async dispose(): Promise<void> {
    this.listeners.clear();
  }
}
