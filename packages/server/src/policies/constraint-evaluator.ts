import type { OperationContext } from '@sibeaver/core';
import type {
  Constraint,
  ConstraintResult,
  EvidenceInput,
  Condition,
  MetricCondition,
  CodePatternCondition,
  TestResultCondition,
  SibsQueryCondition,
} from '@sibeaver/core';

const NODE_TYPE_MAP: Record<string, string> = {
  goals: 'goal',
  tasks: 'task',
  decisions: 'decision',
  knowledge: 'knowledge',
  requirements: 'requirement',
  risks: 'risk',
  explorations: 'exploration',
  tech_debts: 'tech_debt',
};

export async function evaluateConstraint(
  constraint: Constraint,
  evidence: EvidenceInput,
  ctx?: OperationContext,
): Promise<ConstraintResult> {
  const base = {
    constraint_id: constraint.id,
    title: constraint.title,
    dimension: constraint.dimension,
    severity: constraint.severity,
  };

  const result = await evaluateCondition(constraint, constraint.condition, evidence, ctx);

  return { ...base, ...result };
}

export async function evaluateConstraints(
  constraints: Constraint[],
  evidence: EvidenceInput,
  ctx?: OperationContext,
): Promise<ConstraintResult[]> {
  const results: ConstraintResult[] = [];
  for (const c of constraints) {
    results.push(await evaluateConstraint(c, evidence, ctx));
  }
  return results;
}

export function summarizeResults(results: ConstraintResult[]) {
  return {
    total: results.length,
    satisfied: results.filter(r => r.satisfied === true).length,
    violated: results.filter(r => r.satisfied === false).length,
    no_evidence: results.filter(r => r.satisfied === null).length,
  };
}

// ── Per-type evaluators ─────────────────────────────────────

async function evaluateCondition(
  constraint: Constraint,
  condition: Condition,
  evidence: EvidenceInput,
  ctx?: OperationContext,
): Promise<Pick<ConstraintResult, 'satisfied' | 'actual_value' | 'expected' | 'message'>> {
  switch (condition.evidence_type) {
    case 'metric':
      return evaluateMetric(constraint, condition, evidence);
    case 'test_result':
      return evaluateTestResult(constraint, condition, evidence);
    case 'code_pattern':
      return evaluateCodePattern(constraint, condition, evidence);
    case 'sibs_query':
      return evaluateSibsQuery(constraint, condition, ctx);
  }
}

function compareOperator(operator: string, actual: number, threshold: number): boolean {
  switch (operator) {
    case 'lt': return actual < threshold;
    case 'lte': return actual <= threshold;
    case 'gt': return actual > threshold;
    case 'gte': return actual >= threshold;
    case 'eq': return actual === threshold;
    case 'neq': return actual !== threshold;
    default: return false;
  }
}

function operatorSymbol(operator: string): string {
  return { lt: '<', lte: '≤', gt: '>', gte: '≥', eq: '=', neq: '≠' }[operator] ?? operator;
}

function evaluateMetric(
  constraint: Constraint,
  cond: MetricCondition,
  evidence: EvidenceInput,
): Pick<ConstraintResult, 'satisfied' | 'actual_value' | 'expected' | 'message'> {
  const expected = `${cond.metric} ${operatorSymbol(cond.operator)} ${cond.threshold}${cond.unit ?? ''}`;
  const actual = evidence.metrics?.[cond.metric];

  if (actual === undefined) {
    return { satisfied: null, actual_value: null, expected, message: `no evidence for metric '${cond.metric}'` };
  }

  const pass = compareOperator(cond.operator, actual, cond.threshold);
  return {
    satisfied: pass,
    actual_value: actual,
    expected,
    message: `${cond.metric} = ${actual}${cond.unit ?? ''} ${pass ? '✓' : `✗ (expected ${operatorSymbol(cond.operator)} ${cond.threshold}${cond.unit ?? ''})`}`,
  };
}

function evaluateTestResult(
  constraint: Constraint,
  cond: TestResultCondition,
  evidence: EvidenceInput,
): Pick<ConstraintResult, 'satisfied' | 'actual_value' | 'expected' | 'message'> {
  const expected = `${cond.metric} ${operatorSymbol(cond.operator)} ${cond.threshold}${cond.unit ?? ''}`;
  const actual = evidence.metrics?.[cond.metric];

  if (actual === undefined) {
    return { satisfied: null, actual_value: null, expected, message: `no test evidence for '${cond.metric}'` };
  }

  const pass = compareOperator(cond.operator, actual, cond.threshold);
  return {
    satisfied: pass,
    actual_value: actual,
    expected,
    message: `${cond.metric} = ${actual}${cond.unit ?? ''} ${pass ? '✓' : `✗ (expected ${operatorSymbol(cond.operator)} ${cond.threshold}${cond.unit ?? ''})`}`,
  };
}

function evaluateCodePattern(
  constraint: Constraint,
  cond: CodePatternCondition,
  evidence: EvidenceInput,
): Pick<ConstraintResult, 'satisfied' | 'actual_value' | 'expected' | 'message'> {
  const expected = `${cond.operator}: /${cond.pattern}/ in ${cond.scope}`;
  const result = evidence.pattern_results?.[constraint.id];

  if (result === undefined) {
    return { satisfied: null, actual_value: null, expected, message: `no pattern evidence for '${constraint.id}'` };
  }

  const { matched, total } = result;
  let pass = false;
  switch (cond.operator) {
    case 'present': pass = matched > 0; break;
    case 'present_in_any': pass = matched > 0; break;
    case 'present_in_all': pass = total > 0 && matched === total; break;
    case 'absent': pass = matched === 0; break;
  }

  return {
    satisfied: pass,
    actual_value: `${matched}/${total} files`,
    expected,
    message: `${matched}/${total} files matched ${pass ? '✓' : '✗'}`,
  };
}

async function evaluateSibsQuery(
  constraint: Constraint,
  cond: SibsQueryCondition,
  ctx?: OperationContext,
): Promise<Pick<ConstraintResult, 'satisfied' | 'actual_value' | 'expected' | 'message'>> {
  const expected = `${cond.operator}: ${cond.query}`;

  if (!ctx) {
    return { satisfied: null, actual_value: null, expected, message: 'no sibs context available' };
  }

  const parsed = parseSibsUri(cond.query);
  if (!parsed) {
    return { satisfied: null, actual_value: null, expected, message: `cannot parse sibs URI: ${cond.query}` };
  }

  const nodeType = NODE_TYPE_MAP[parsed.nodeType];
  if (!nodeType) {
    return { satisfied: null, actual_value: null, expected, message: `unknown node type: ${parsed.nodeType}` };
  }

  let nodes;
  try {
    nodes = await ctx.nodes.getByType(nodeType as any);
  } catch {
    return { satisfied: null, actual_value: null, expected, message: `query failed: ${cond.query}` };
  }

  let filtered = nodes;
  if (parsed.tag) {
    filtered = nodes.filter((n: any) => n.tags?.includes(parsed.tag));
  }

  const count = filtered.length;

  switch (cond.operator) {
    case 'present':
      return {
        satisfied: count > 0,
        actual_value: count,
        expected,
        message: `${count} results ${count > 0 ? '✓' : '✗'}`,
      };
    case 'absent':
      return {
        satisfied: count === 0,
        actual_value: count,
        expected,
        message: `${count} results ${count === 0 ? '✓' : '✗'}`,
      };
    case 'match_count': {
      const threshold = cond.threshold ?? 0;
      const op = cond.count_operator ?? 'gte';
      const pass = compareOperator(op, count, threshold);
      return {
        satisfied: pass,
        actual_value: count,
        expected: `${op} ${threshold}`,
        message: `${count} results ${pass ? '✓' : '✗'} (expected ${operatorSymbol(op)} ${threshold})`,
      };
    }
    default:
      return { satisfied: null, actual_value: null, expected, message: `unknown operator: ${cond.operator}` };
  }
}

function parseSibsUri(uri: string): { nodeType: string; tag?: string } | null {
  // sibs://project/{project}/{node_type}?tag={tag}
  // URL parses as: protocol='sibs:', host='project', pathname='/{project}/{node_type}'
  try {
    const u = new URL(uri);
    const parts = u.pathname.split('/').filter(Boolean);
    // parts: ['{project}', '{node_type}']
    if (parts.length < 2) return null;
    const nodeType = parts[1];
    const tag = u.searchParams.get('tag') ?? undefined;
    return { nodeType, tag };
  } catch {
    return null;
  }
}
