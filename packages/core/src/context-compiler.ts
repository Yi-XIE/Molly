import type { ContextCapsule, WorkItem, WorkItemCard } from '@molly/contracts';

export interface ContextCompileInput {
  workItem: WorkItem;
  confirmedRules?: string[];
  confirmedFacts?: string[];
  confirmedDecisions?: string[];
  confirmedMemories?: Array<{ id: string; content: string }>;
  constraints?: string[];
  allowedArtifactIds?: string[];
  openQuestions?: string[];
  referencedArtifacts?: Array<{ id: string; summary: string }>;
}

export class ContextCompiler {
  private readonly versions = new Map<string, number>();

  compile(input: ContextCompileInput): ContextCapsule {
    const version = (this.versions.get(input.workItem.id) ?? 0) + 1;
    this.versions.set(input.workItem.id, version);
    const sources: ContextCapsule['sources'] = [
      ...(input.confirmedRules ?? []).map((id) => ({ type: 'rule' as const, id, reason: '全局确认规则' })),
      ...(input.confirmedMemories ?? []).map((memory) => ({ type: 'memory' as const, id: memory.id, reason: '作用域记忆召回' })),
      ...(input.referencedArtifacts ?? []).map((artifact) => ({ type: 'artifact' as const, id: artifact.id, reason: 'Yi 明确引用' })),
      { type: 'work_item', id: input.workItem.id, reason: '当前焦点' },
    ];
    return {
      version,
      workItemId: input.workItem.id,
      goal: input.workItem.goal,
      currentSummary: input.workItem.currentSummary,
      confirmedFacts: [...(input.confirmedFacts ?? []), ...(input.confirmedMemories ?? []).map((memory) => memory.content)],
      confirmedDecisions: input.confirmedDecisions ?? [],
      constraints: input.constraints ?? [],
      allowedArtifactIds: (input.referencedArtifacts ?? []).map((artifact) => artifact.id),
      openQuestions: input.openQuestions ?? [],
      sources,
      compiledAt: new Date().toISOString(),
    };
  }

  toPrompt(capsule: ContextCapsule, artifacts: Array<{ id: string; summary: string }> = []): string {
    const allowed = new Map(artifacts.map((artifact) => [artifact.id, artifact.summary]));
    const lines = [
      `当前焦点目标：${capsule.goal}`,
      `最近状态：${capsule.currentSummary || '无'}`,
      `已确认事实：${capsule.confirmedFacts.join('；') || '无'}`,
      `已确认决策：${capsule.confirmedDecisions.join('；') || '无'}`,
      `工作约束：${capsule.constraints.join('；') || '无'}`,
      `待解决问题：${capsule.openQuestions.join('；') || '无'}`,
    ];
    const referenced = capsule.allowedArtifactIds.map((id) => allowed.get(id)).filter(Boolean);
    if (referenced.length) lines.push(`允许读取的产物：${referenced.join('；')}`);
    return lines.join('\n');
  }
}

export function scoreWorkItemInput(input: string, card: WorkItemCard): number {
  const normalized = input.toLocaleLowerCase();
  const candidates = [card.title, card.goal, ...card.tags, card.recentSummary]
    .join(' ').toLocaleLowerCase().split(/\s+|[，。！？、,:;]+/).filter((part) => part.length >= 2);
  return candidates.filter((candidate) => normalized.includes(candidate)).length;
}
