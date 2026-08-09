import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateWorkflow, executeWorkflow, WORKFLOW_TEMPLATES, compare, readPath, render, topologicalOrder,
} from '../dist/index.js';

const silentLog = { child: () => silentLog, debug() {}, info() {}, warn() {}, error() {} };

const base = (nodes, edges = []) => ({
  id: 'wf-test', name: 'Test workflow', nodes, edges,
});

const trigger = (id = 'n1') => ({ id, label: 'Start', position: { x: 0, y: 0 }, config: { type: 'trigger', mode: 'manual' } });

test('every shipped template validates cleanly', () => {
  for (const tpl of WORKFLOW_TEMPLATES) {
    const r = validateWorkflow(tpl);
    const errors = r.issues.filter((i) => i.severity === 'error');
    assert.equal(r.valid, true, `${tpl.name}: ${errors.map((e) => e.message).join('; ')}`);
  }
});

test('a workflow needs exactly one trigger', () => {
  assert.match(
    validateWorkflow(base([{ id: 'a', label: 'Filter', position: { x: 0, y: 0 }, config: { type: 'filter', conditions: [{ field: 'x', op: 'eq', value: 1 }] } }])).issues[0].code,
    /NO_TRIGGER/,
  );
  const two = validateWorkflow(base([trigger('n1'), trigger('n2')]));
  assert.equal(two.valid, false);
  assert.ok(two.issues.some((i) => i.code === 'MULTIPLE_TRIGGERS'));
});

test('cycles are rejected with the offending path', () => {
  const r = validateWorkflow(
    base(
      [
        trigger('n1'),
        { id: 'n2', label: 'A', position: { x: 1, y: 0 }, config: { type: 'delay', seconds: 1 } },
        { id: 'n3', label: 'B', position: { x: 2, y: 0 }, config: { type: 'delay', seconds: 1 } },
      ],
      [
        { id: 'e1', from: 'n1', to: 'n2' },
        { id: 'e2', from: 'n2', to: 'n3' },
        { id: 'e3', from: 'n3', to: 'n2' },
      ],
    ),
  );
  assert.equal(r.valid, false);
  const cycle = r.issues.find((i) => i.code === 'CYCLE_DETECTED');
  assert.ok(cycle, 'expected a cycle error');
  assert.match(cycle.message, /loop/);
});

test('edges leaving a branch must carry a known case label', () => {
  const branch = {
    id: 'b', label: 'Route', position: { x: 1, y: 0 },
    config: { type: 'branch', cases: [{ label: 'hot', field: 'score', op: 'gte', value: 75 }], defaultLabel: 'else' },
  };
  const sink = { id: 's', label: 'Wait', position: { x: 2, y: 0 }, config: { type: 'delay', seconds: 1 } };

  const unlabelled = validateWorkflow(base([trigger(), branch, sink], [
    { id: 'e1', from: 'n1', to: 'b' }, { id: 'e2', from: 'b', to: 's' },
  ]));
  assert.ok(unlabelled.issues.some((i) => i.code === 'UNLABELLED_BRANCH_EDGE'));

  const wrong = validateWorkflow(base([trigger(), branch, sink], [
    { id: 'e1', from: 'n1', to: 'b' }, { id: 'e2', from: 'b', to: 's', label: 'nope' },
  ]));
  assert.ok(wrong.issues.some((i) => i.code === 'UNKNOWN_BRANCH_LABEL'));

  const ok = validateWorkflow(base([trigger(), branch, sink], [
    { id: 'e1', from: 'n1', to: 'b' }, { id: 'e2', from: 'b', to: 's', label: 'hot' },
  ]));
  assert.equal(ok.valid, true);
});

test('dangling edges and unreachable nodes are caught', () => {
  const r = validateWorkflow(base([trigger(), { id: 'orphan', label: 'Orphan', position: { x: 5, y: 5 }, config: { type: 'delay', seconds: 1 } }],
    [{ id: 'e1', from: 'n1', to: 'ghost' }]));
  assert.ok(r.issues.some((i) => i.code === 'DANGLING_EDGE'));
  assert.ok(r.issues.some((i) => i.code === 'UNREACHABLE_NODE'));
});

test('notifying without scoring produces a warning but still validates', () => {
  const r = validateWorkflow(base(
    [trigger(), { id: 'n2', label: 'Alert', position: { x: 1, y: 0 }, config: { type: 'notify', channel: 'email', target: 'a@b.c' } }],
    [{ id: 'e1', from: 'n1', to: 'n2' }],
  ));
  assert.equal(r.valid, true, 'warnings must not block publishing');
  assert.ok(r.issues.some((i) => i.code === 'NOTIFY_WITHOUT_SCORE' && i.severity === 'warning'));
});

// --- execution -------------------------------------------------------------

function makeEffects(overrides = {}) {
  const calls = { fetch: 0, dispatch: 0, archive: 0, notify: 0 };
  return {
    calls,
    effects: {
      async fetchSources() {
        calls.fetch++;
        return [
          { id: 'i1', sourceId: 's1', sourceLabel: 'Feed A', headline: 'Officer placed on leave' },
          { id: 'i2', sourceId: 's2', sourceLabel: 'Feed B', headline: 'Quarterly earnings beat' },
        ];
      },
      async collectSignals(item) {
        return item.id === 'i1'
          ? [{ signalId: 'silent_edit', raw: 1, sampleSize: 1, evidence: 'body changed silently' }]
          : [{ signalId: 'content_novelty', raw: 0.05, sampleSize: 3 }];
      },
      async dispatchAgentTask() { calls.dispatch++; return { taskId: 't1', estimatedCostUsd: 0.01 }; },
      async archive() { calls.archive++; return { evidenceId: 'ev1' }; },
      async notify() { calls.notify++; return { sent: true, suppressed: false }; },
      ...overrides,
    },
  };
}

test('a full pipeline scores, branches and only alerts on critical', async () => {
  const wf = validateWorkflow(WORKFLOW_TEMPLATES[0]).workflow;
  const { effects, calls } = makeEffects();
  const r = await executeWorkflow(wf, effects, { triggeredBy: 'test', log: silentLog });

  assert.equal(r.status, 'completed');
  assert.equal(calls.fetch, 1);
  assert.equal(calls.notify, 1, 'only the critical item should notify');
  assert.equal(r.anomalies.length, 1);
  assert.equal(r.anomalies[0].score.band, 'critical');
});

test('dry run performs no side effects but still reports what would happen', async () => {
  const wf = validateWorkflow(WORKFLOW_TEMPLATES[0]).workflow;
  const { effects, calls } = makeEffects();
  const r = await executeWorkflow(wf, effects, { triggeredBy: 'test', log: silentLog, dryRun: true });

  assert.equal(r.dryRun, true);
  assert.equal(calls.archive, 0);
  assert.equal(calls.notify, 0);
  const archiveStep = r.steps.find((s) => s.type === 'archive');
  assert.equal(archiveStep.status, 'skipped');
  assert.equal(archiveStep.detail.wouldArchive, 1);
});

test('execution halts when the node budget is exhausted', async () => {
  const nodes = [trigger()];
  const edges = [];
  for (let i = 2; i <= 12; i++) {
    nodes.push({ id: `n${i}`, label: `Step ${i}`, position: { x: i, y: 0 }, config: { type: 'transform', mappings: { step: String(i) } } });
    edges.push({ id: `e${i}`, from: `n${i - 1}`, to: `n${i}` });
  }
  const wf = validateWorkflow({ ...base(nodes, edges), limits: { maxNodesExecuted: 5, maxDurationSeconds: 900, maxCostUsd: 5 } }).workflow;
  const { effects } = makeEffects();
  const r = await executeWorkflow(wf, effects, { triggeredBy: 'test', log: silentLog });

  assert.equal(r.status, 'halted_limits');
  assert.match(r.haltReason, /node budget/);
  assert.equal(r.nodesExecuted, 5);
});

test('execution halts when the cost budget is exhausted', async () => {
  const wf = validateWorkflow({
    ...base(
      [trigger(), { id: 'n2', label: 'Dispatch', position: { x: 1, y: 0 }, config: { type: 'source', tagSelector: ['x'] } },
       { id: 'n3', label: 'Agent', position: { x: 2, y: 0 }, config: { type: 'agent_task', agent: 'aria', kind: 'analyze' } },
       { id: 'n4', label: 'Agent2', position: { x: 3, y: 0 }, config: { type: 'agent_task', agent: 'aria', kind: 'analyze' } }],
      [{ id: 'e1', from: 'n1', to: 'n2' }, { id: 'e2', from: 'n2', to: 'n3' }, { id: 'e3', from: 'n3', to: 'n4' }],
    ),
    limits: { maxNodesExecuted: 100, maxDurationSeconds: 900, maxCostUsd: 0.015 },
  }).workflow;
  const { effects } = makeEffects();
  const r = await executeWorkflow(wf, effects, { triggeredBy: 'test', log: silentLog });
  assert.equal(r.status, 'halted_limits');
  assert.match(r.haltReason, /cost budget/);
});

test('a failing node fails the execution and records the error', async () => {
  const wf = validateWorkflow(base(
    [trigger(), { id: 'n2', label: 'Pull', position: { x: 1, y: 0 }, config: { type: 'source', tagSelector: ['x'] } }],
    [{ id: 'e1', from: 'n1', to: 'n2' }],
  )).workflow;
  const { effects } = makeEffects({ async fetchSources() { throw new Error('upstream 503'); } });
  const r = await executeWorkflow(wf, effects, { triggeredBy: 'test', log: silentLog });
  assert.equal(r.status, 'failed');
  assert.match(r.haltReason, /upstream 503/);
  assert.equal(r.steps.at(-1).status, 'failed');
});

// --- helpers ---------------------------------------------------------------

test('comparators behave', () => {
  assert.equal(compare(5, 'gte', 5), true);
  assert.equal(compare('Hello World', 'contains', 'world'), true);
  assert.equal(compare('abc123', 'matches', '^[a-z]+\\d+$'), true);
  assert.equal(compare('x', 'in', ['x', 'y']), true);
  assert.equal(compare('5', 'gt', 3), false, 'string vs number must not coerce');
  assert.equal(compare('x', 'matches', '([a-'), false, 'invalid regex must not throw');
});

test('readPath walks nested objects safely', () => {
  assert.equal(readPath({ a: { b: { c: 42 } } }, 'a.b.c'), 42);
  assert.equal(readPath({ a: null }, 'a.b.c'), undefined);
  assert.equal(readPath(undefined, 'a'), undefined);
});

test('templates render placeholders and tolerate missing fields', () => {
  assert.equal(render('{{band}} at {{score}}', { band: 'critical', score: 88 }), 'critical at 88');
  assert.equal(render('[{{nope}}]', {}), '[]');
  assert.equal(render('{{scoring.topDrivers.0.label}}', { scoring: { topDrivers: [{ label: 'Silent edit' }] } }), 'Silent edit');
});

test('topological order starts at the trigger', () => {
  const wf = validateWorkflow(WORKFLOW_TEMPLATES[1]).workflow;
  const order = topologicalOrder(wf);
  assert.equal(order[0].config.type, 'trigger');
  assert.equal(order.length, wf.nodes.length);
});
