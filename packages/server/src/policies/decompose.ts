import { sibs } from '../sibs-client.js';
import { jsonCompletion } from '../llm-client.js';
import type { ChatMessage } from '../llm-client.js';
import type { ApiRequirementNode } from '../api-types.js';

interface DecomposeResult {
  goal: { title: string; description: string };
  sub_goals: { title: string; description: string }[];
}

export async function decomposeRequirement(requirementId: string): Promise<{ goalId: string }> {
  const ctx = await sibs.getNodeContext(requirementId);
  const node = ctx.node as ApiRequirementNode | null;
  if (!node) throw new Error(`需求不存在：${requirementId}`);

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: `你是一个需求分解专家。你的任务是将一个需求分解为一个目标（Goal）和若干子目标。

输出 JSON 格式：
{
  "goal": { "title": "...", "description": "..." },
  "sub_goals": [
    { "title": "...", "description": "..." }
  ]
}

规则：
- Goal 是方案层面的"怎么做"
- sub_goals 是更细粒度的阶段性目标
- 不要超过 5 个子目标`,
    },
    {
      role: "user",
      content: `需求标题: ${node.title}
描述: ${node.description || "无"}`,
    },
  ];

  const result = await jsonCompletion<DecomposeResult>(messages);

  const goalRes: any = await sibs.defineGoal({
    title: result.goal.title,
    description: result.goal.description,
    horizon: "short",
    priority: node.priority ?? "medium",
  });
  const goalId = goalRes.goal.id;

  await sibs.linkNodes({
    sourceId: goalId,
    targetId: requirementId,
    relation: "fulfills",
    annotation: "auto-decomposed from requirement",
  });

  return { goalId };
}
