import type { RouteDecision, WorkItemCard } from '@molly/contracts';
import { scoreWorkItemInput } from './context-compiler.js';

export class IntentRouter {
  constructor(private readonly switchMargin = 2) {}

  decide(input: string, current: WorkItemCard, candidates: WorkItemCard[]): RouteDecision {
    const normalized = input.trim().toLocaleLowerCase();
    const explicit = candidates.find((card) => normalized.includes(card.title.toLocaleLowerCase()));
    if (explicit && explicit.id !== current.id) {
      return { action: 'switch', fromWorkItemId: current.id, toWorkItemId: explicit.id, confidence: 1, reason: '明确提到工作项名称' };
    }
    const currentScore = scoreWorkItemInput(normalized, current);
    const ranked = candidates
      .filter((card) => card.id !== current.id)
      .map((card) => ({ card, score: scoreWorkItemInput(normalized, card) }))
      .sort((a, b) => b.score - a.score);
    const best = ranked[0];
    if (!best || best.score === 0 || best.score <= currentScore) {
      return { action: 'continue', fromWorkItemId: current.id, toWorkItemId: null, confidence: currentScore > 0 ? 0.8 : 0.4, reason: '当前焦点仍是最合适的归属' };
    }
    const margin = best.score - currentScore;
    if (margin >= this.switchMargin && best.score >= 2) {
      return { action: 'switch', fromWorkItemId: current.id, toWorkItemId: best.card.id, confidence: Math.min(0.99, 0.6 + margin * 0.1), reason: '目标工作项相关度明显更高' };
    }
    return { action: 'ask', fromWorkItemId: current.id, toWorkItemId: best.card.id, confidence: 0.5, reason: '两个工作项都可能相关' };
  }
}
