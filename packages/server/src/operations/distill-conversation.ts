import type { OperationContext } from './context.js';
import { jsonCompletion, type ChatMessage } from '../llm-client.js';
import type { CognitiveNode } from '../nodes/types.js';
import { config } from '../config/index.js';

export interface DistillConversationInput {
  messages?: Array<{ role: string; content: string }>;
  text?: string;
  focus_types?: ('decision' | 'knowledge' | 'risk')[];
}

export interface DistillProposal {
  action: 'create' | 'update';
  node_type: 'decision' | 'knowledge' | 'risk';
  params?: Record<string, unknown>;
  target_id?: string;
  updates?: Record<string, unknown>;
  rationale: string;
  confidence: 'low' | 'medium' | 'high';
  source_excerpt?: string;
}

export interface DistillConversationResponse {
  proposals: DistillProposal[];
  summary: string;
}

interface RawDistillResult {
  proposals: Array<{
    action: 'create' | 'update';
    node_type: 'decision' | 'knowledge' | 'risk';
    params?: Record<string, unknown>;
    target_id?: string;
    updates?: Record<string, unknown>;
    rationale: string;
    confidence: 'low' | 'medium' | 'high';
    source_excerpt?: string;
  }>;
  summary: string;
}

function formatExistingNodes(nodes: CognitiveNode[]): string {
  if (nodes.length === 0) return '无';
  return nodes
    .slice(0, 15)
    .map(n => `- [${n.id.slice(0, 8)}] (${n.type}) ${n.title}`)
    .join('\n');
}

function buildConversationText(input: DistillConversationInput): string {
  if (input.text) return input.text;
  if (input.messages) {
    return input.messages
      .map(m => `[${m.role}]: ${m.content}`)
      .join('\n\n');
  }
  return '';
}

// 防御上限：蒸馏只看最近的上下文，超长输入成本高收益低
const MAX_INPUT_CHARS = 20_000;

export async function distillConversation(
  ctx: OperationContext,
  input: DistillConversationInput,
): Promise<DistillConversationResponse> {
  const rawText = buildConversationText(input);
  const conversationText = rawText.length > MAX_INPUT_CHARS
    ? rawText.slice(-MAX_INPUT_CHARS)
    : rawText;
  if (!conversationText) {
    return { proposals: [], summary: '无对话内容' };
  }

  const focusTypes = input.focus_types ?? ['decision', 'knowledge', 'risk'];

  const decisions = focusTypes.includes('decision')
    ? await ctx.nodes.getByType('decision') : [];
  const knowledge = focusTypes.includes('knowledge')
    ? await ctx.nodes.getByType('knowledge') : [];
  const risks = focusTypes.includes('risk')
    ? await ctx.nodes.getByType('risk') : [];

  const existingContext = [
    focusTypes.includes('decision') ? `已有决策:\n${formatExistingNodes(decisions)}` : '',
    focusTypes.includes('knowledge') ? `已有知识:\n${formatExistingNodes(knowledge)}` : '',
    focusTypes.includes('risk') ? `已有风险:\n${formatExistingNodes(risks)}` : '',
  ].filter(Boolean).join('\n\n');

  const typeSchemas = `
目标节点类型及 params 格式：
${focusTypes.includes('decision') ? `- decision: { title, context, rationale, alternatives_considered?: [{option, reason_rejected}], consequences?: string[], tags?: string[] }` : ''}
${focusTypes.includes('knowledge') ? `- knowledge: { title, description, domain, source, confidence?: "low"|"medium"|"high", scope?: "project"|"domain", tags?: string[] }` : ''}
${focusTypes.includes('risk') ? `- risk: { title, description, likelihood: "low"|"medium"|"high", impact: "low"|"medium"|"high"|"critical", mitigation_strategy?: string, tags?: string[] }` : ''}
`.trim();

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `你是 WHY 知识蒸馏器。从对话中提取有价值的 WHY 信息（决策、知识、风险），输出结构化的图谱变更建议。

规则：
1. 只提取有"偏转"的 WHY——选择了什么/放弃了什么/为什么这样做/踩了什么坑/有什么风险
2. 没有偏转的部分不需要记录（直觉一致、无取舍的部分跳过）
3. 对比现有节点去重：如果某条信息已存在，不要重复提议；如果信息更新了已有节点，提议 update
4. confidence 反映信息在对话中的明确程度：明确讨论=high，推导得出=medium，隐含暗示=low

${typeSchemas}

对于 update 操作，使用 target_id 指定要更新的节点，updates 指定要变更的字段。

输出 JSON:
{
  "proposals": [
    {
      "action": "create" | "update",
      "node_type": "decision" | "knowledge" | "risk",
      "params": { ... },        // create 时必填
      "target_id": "...",       // update 时必填
      "updates": { ... },       // update 时必填
      "rationale": "为什么要记录这条",
      "confidence": "low" | "medium" | "high",
      "source_excerpt": "对话中的相关原文片段"
    }
  ],
  "summary": "一句话总结蒸馏结果"
}

如果没有值得记录的内容，返回 { "proposals": [], "summary": "对话中无需蒸馏的 WHY 信息" }`,
    },
    {
      role: 'user',
      content: `现有图谱上下文:
${existingContext}

对话内容:
${conversationText}`,
    },
  ];

  const result = await jsonCompletion<RawDistillResult>(messages, { model: config.llmFlashModel });

  const validTypes = new Set(focusTypes);
  const proposals = (result.proposals ?? []).filter(
    p => validTypes.has(p.node_type) && (p.action === 'create' || p.action === 'update'),
  );

  return {
    proposals,
    summary: result.summary ?? '',
  };
}
