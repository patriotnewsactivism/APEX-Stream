import { workflowSchema, type Workflow, type WorkflowNode } from './schema.js';

export interface ValidationIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
}

export interface ValidationResult {
  valid: boolean;
  workflow: Workflow | null;
  issues: ValidationIssue[];
}

/**
 * Validates a workflow before it can be published.
 *
 * The canvas lets an operator build anything; this is what decides whether it
 * is safe to run. Errors block publishing. Warnings are surfaced in the UI but
 * do not block, because "you built something unusual" is not the same as "you
 * built something broken" — and a tool that refuses to run anything unfamiliar
 * gets worked around rather than used.
 */
export function validateWorkflow(input: unknown): ValidationResult {
  const parsed = workflowSchema.safeParse(input);
  if (!parsed.success) {
    return {
      valid: false,
      workflow: null,
      issues: parsed.error.issues.map((i) => ({
        severity: 'error' as const,
        code: 'SCHEMA_INVALID',
        message: `${i.path.join('.') || '(root)'}: ${i.message}`,
      })),
    };
  }

  const wf = parsed.data;
  const issues: ValidationIssue[] = [];
  const byId = new Map(wf.nodes.map((n) => [n.id, n]));

  if (byId.size !== wf.nodes.length) {
    issues.push({ severity: 'error', code: 'DUPLICATE_NODE_ID', message: 'Two nodes share the same id.' });
  }

  const triggers = wf.nodes.filter((n) => n.config.type === 'trigger');
  if (triggers.length === 0) {
    issues.push({ severity: 'error', code: 'NO_TRIGGER', message: 'A workflow needs exactly one trigger node.' });
  } else if (triggers.length > 1) {
    issues.push({
      severity: 'error',
      code: 'MULTIPLE_TRIGGERS',
      message: `Found ${triggers.length} trigger nodes; a workflow must have exactly one entry point.`,
    });
  }

  for (const t of triggers) {
    if (t.config.type !== 'trigger') continue;
    if (t.config.mode === 'schedule' && !t.config.schedule) {
      issues.push({ severity: 'error', code: 'MISSING_SCHEDULE', nodeId: t.id, message: 'Scheduled trigger has no schedule expression.' });
    }
    if (t.config.mode === 'event' && !t.config.eventType) {
      issues.push({ severity: 'error', code: 'MISSING_EVENT_TYPE', nodeId: t.id, message: 'Event trigger has no event type.' });
    }
  }

  // Edge integrity
  for (const e of wf.edges) {
    if (!byId.has(e.from)) {
      issues.push({ severity: 'error', code: 'DANGLING_EDGE', edgeId: e.id, message: `Edge starts at unknown node "${e.from}".` });
    }
    if (!byId.has(e.to)) {
      issues.push({ severity: 'error', code: 'DANGLING_EDGE', edgeId: e.id, message: `Edge ends at unknown node "${e.to}".` });
    }
    if (e.from === e.to) {
      issues.push({ severity: 'error', code: 'SELF_LOOP', edgeId: e.id, message: 'A node cannot connect to itself.' });
    }
  }

  // Branch edges must be labelled with a known case
  for (const node of wf.nodes) {
    if (node.config.type !== 'branch') continue;
    const labels = new Set([...node.config.cases.map((c) => c.label), node.config.defaultLabel]);
    const outgoing = wf.edges.filter((e) => e.from === node.id);
    if (outgoing.length === 0) {
      issues.push({ severity: 'warning', code: 'BRANCH_DEAD_END', nodeId: node.id, message: 'Branch node has no outgoing edges — every path ends here.' });
    }
    for (const e of outgoing) {
      if (!e.label) {
        issues.push({ severity: 'error', code: 'UNLABELLED_BRANCH_EDGE', edgeId: e.id, message: `Edge out of branch "${node.label}" needs a case label.` });
      } else if (!labels.has(e.label)) {
        issues.push({
          severity: 'error',
          code: 'UNKNOWN_BRANCH_LABEL',
          edgeId: e.id,
          message: `Edge label "${e.label}" does not match any case on "${node.label}".`,
        });
      }
    }
    const covered = new Set(outgoing.map((e) => e.label));
    for (const c of node.config.cases) {
      if (!covered.has(c.label)) {
        issues.push({ severity: 'warning', code: 'UNCONNECTED_CASE', nodeId: node.id, message: `Case "${c.label}" has no outgoing edge; matches will stop there.` });
      }
    }
  }

  // Cycles
  const cycle = findCycle(wf);
  if (cycle) {
    issues.push({
      severity: 'error',
      code: 'CYCLE_DETECTED',
      message: `Workflow contains a loop: ${cycle.join(' → ')}. Loops would run forever; use a scheduled trigger instead.`,
    });
  }

  // Reachability
  if (triggers.length === 1) {
    const trigger = triggers[0];
    if (trigger) {
      const reachable = reachableFrom(wf, trigger.id);
      for (const node of wf.nodes) {
        if (!reachable.has(node.id)) {
          issues.push({ severity: 'warning', code: 'UNREACHABLE_NODE', nodeId: node.id, message: `"${node.label}" is not connected to the trigger and will never run.` });
        }
      }
    }
  }

  // Semantic guidance
  const hasScore = wf.nodes.some((n) => n.config.type === 'score');
  const hasNotify = wf.nodes.some((n) => n.config.type === 'notify');
  const hasArchive = wf.nodes.some((n) => n.config.type === 'archive');
  if (hasNotify && !hasScore) {
    issues.push({ severity: 'warning', code: 'NOTIFY_WITHOUT_SCORE', message: 'This workflow notifies without scoring, so every item will alert. Add a score and branch to cut noise.' });
  }
  if (hasScore && !hasArchive) {
    issues.push({ severity: 'warning', code: 'SCORE_WITHOUT_ARCHIVE', message: 'Anomalies are detected but nothing is archived. Evidence that was never captured cannot be reviewed later.' });
  }
  for (const node of wf.nodes) {
    if (node.config.type === 'notify' && node.config.dedupeWindowMinutes === 0) {
      issues.push({ severity: 'warning', code: 'NO_DEDUPE', nodeId: node.id, message: 'Deduplication is off — a burst on one source will send a message per item.' });
    }
  }

  return { valid: !issues.some((i) => i.severity === 'error'), workflow: wf, issues };
}

function reachableFrom(wf: Workflow, startId: string): Set<string> {
  const adjacency = buildAdjacency(wf);
  const seen = new Set<string>([startId]);
  const stack = [startId];
  while (stack.length) {
    const current = stack.pop();
    if (current === undefined) break;
    for (const next of adjacency.get(current) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return seen;
}

function buildAdjacency(wf: Workflow): Map<string, string[]> {
  const adjacency = new Map<string, string[]>();
  for (const n of wf.nodes) adjacency.set(n.id, []);
  for (const e of wf.edges) {
    if (adjacency.has(e.from)) adjacency.get(e.from)?.push(e.to);
  }
  return adjacency;
}

/** Returns the node ids forming a cycle, or null. Iterative DFS with colours. */
function findCycle(wf: Workflow): string[] | null {
  const adjacency = buildAdjacency(wf);
  const colour = new Map<string, 0 | 1 | 2>(); // 0 unvisited, 1 in-stack, 2 done
  const parent = new Map<string, string>();

  for (const start of adjacency.keys()) {
    if (colour.get(start)) continue;
    const stack: Array<{ id: string; iter: number }> = [{ id: start, iter: 0 }];
    colour.set(start, 1);

    while (stack.length) {
      const frame = stack[stack.length - 1];
      if (!frame) break;
      const neighbours = adjacency.get(frame.id) ?? [];
      if (frame.iter >= neighbours.length) {
        colour.set(frame.id, 2);
        stack.pop();
        continue;
      }
      const next = neighbours[frame.iter++];
      if (next === undefined) continue;
      const state = colour.get(next) ?? 0;
      if (state === 1) {
        const path = [next];
        let cursor: string | undefined = frame.id;
        while (cursor && cursor !== next) {
          path.unshift(cursor);
          cursor = parent.get(cursor);
        }
        path.unshift(next);
        return path;
      }
      if (state === 0) {
        colour.set(next, 1);
        parent.set(next, frame.id);
        stack.push({ id: next, iter: 0 });
      }
    }
  }
  return null;
}

/** Execution order for the linear portion of a workflow. */
export function topologicalOrder(wf: Workflow): WorkflowNode[] {
  const adjacency = buildAdjacency(wf);
  const indegree = new Map<string, number>();
  for (const n of wf.nodes) indegree.set(n.id, 0);
  for (const e of wf.edges) indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);

  const queue = [...indegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  const byId = new Map(wf.nodes.map((n) => [n.id, n]));
  const order: WorkflowNode[] = [];

  while (queue.length) {
    const id = queue.shift();
    if (id === undefined) break;
    const node = byId.get(id);
    if (node) order.push(node);
    for (const next of adjacency.get(id) ?? []) {
      const d = (indegree.get(next) ?? 1) - 1;
      indegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  return order;
}
