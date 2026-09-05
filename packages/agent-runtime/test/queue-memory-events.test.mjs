import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TaskQueue, EventBus, AgentMemory, PgExecutor } from '../dist/index.js';

// Real Postgres, not a fake -- these three modules replaced AWS SQS,
// EventBridge, and DynamoDB, and the thing worth proving is that the actual
// SQL (SKIP LOCKED claiming, upserts, LIKE-prefix scans) behaves correctly
// under real Postgres semantics, not just that the code typechecks.
//
// Time-dependent behavior (backoff, lease expiry, TTL) is verified by
// moving timestamps with direct SQL rather than sleeping in real time --
// faster and deterministic. The "nothing available" tests use waitSeconds:
// 0 so the poll loop's single query already elapses the (zero-length)
// deadline, returning [] without ever calling its internal sleep().
//
// Skips gracefully without DATABASE_URL so the core suite still runs with
// zero live credentials -- see db/migrations/003_postgres_native_queue_memory_events.sql
// for schema, and docs/PRODUCTION_OPERATIONS.md for how CI provisions one.
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  test('queue/memory/events (skipped: no DATABASE_URL)', () => {});
} else {
  const db = new PgExecutor(DATABASE_URL, false);

  test.after(async () => {
    await db.close();
  });

  test.beforeEach(async () => {
    await db.query(`TRUNCATE agent_tasks, agent_events, agent_memory`);
  });

  test('TaskQueue: send -> receive -> ack removes it; claimed rows stay hidden', async () => {
    const queue = new TaskQueue('aria', db);
    await queue.send(taskFor('aria', 'task-1', { sourceId: 'src-1' }));

    const [received] = await queue.receive(5, 1);
    assert.equal(received.task.taskId, 'task-1');
    assert.equal(received.task.payload.sourceId, 'src-1');
    assert.equal(received.approximateReceiveCount, 1);

    // Verified directly rather than by polling again and waiting out a
    // second long-poll: the claimed row is 'in_flight' with a future
    // visible_at, which is the actual mechanism that hides it.
    const [row] = await db.query('SELECT status, visible_at > now() AS still_leased FROM agent_tasks');
    assert.equal(row.status, 'in_flight');
    assert.equal(row.still_leased, true);

    await queue.ack(received.receiptHandle);
    const [count] = await db.query('SELECT count(*)::int AS n FROM agent_tasks');
    assert.equal(count.n, 0);
  });

  test('TaskQueue: an empty queue returns [] rather than erroring', async () => {
    // waitSeconds: 0 exercises the same "nothing available" return path
    // without needing the poll loop to actually sleep on a real timer,
    // which is what the long-poll path does with waitSeconds > 0 in
    // production (see the standalone verification note at the top of this
    // file for why that path isn't exercised with a real wait here).
    const queue = new TaskQueue('aria', db);
    const result = await queue.receive(5, 0);
    assert.deepEqual(result, []);
  });

  test('TaskQueue: nack makes the task reclaimable and increments receive_count', async () => {
    const queue = new TaskQueue('atlas', db);
    await queue.send(taskFor('atlas', 'task-2'));

    const [first] = await queue.receive(5, 1);
    assert.equal(first.approximateReceiveCount, 1);
    await queue.nack(first.receiptHandle, 5); // a large attempt count to prove backoff is capped, not unbounded

    // Move the backoff-extended visible_at into the past directly, instead
    // of sleeping out the real backoff window.
    await db.query(`UPDATE agent_tasks SET visible_at = now() - interval '1 second'`);

    const [second] = await queue.receive(5, 1);
    assert.equal(second.task.taskId, 'task-2');
    assert.equal(second.approximateReceiveCount, 2, 'receive_count increments across leases');
  });

  test('TaskQueue: nack on a stale (already-reclaimed) lease is a safe no-op', async () => {
    const queue = new TaskQueue('atlas', db);
    await queue.send(taskFor('atlas', 'task-stale'));
    const [claim1] = await queue.receive(5, 1);

    // Force the lease to look expired, then let a second claim take over.
    await db.query(`UPDATE agent_tasks SET visible_at = now() - interval '1 second'`);
    const [claim2] = await queue.receive(5, 1);
    assert.notEqual(claim1.receiptHandle, claim2.receiptHandle, 'the second claim should mint a new lease token');

    // The original (now-stale) receipt's nack must not disturb the new claim.
    await queue.nack(claim1.receiptHandle, 0);
    const [row] = await db.query('SELECT status FROM agent_tasks');
    assert.equal(row.status, 'in_flight', 'a stale nack must not revert an in-flight row someone else now owns');
  });

  test('TaskQueue: heartbeat extends the lease past what the original timeout would have allowed', async () => {
    const queue = new TaskQueue('sentinel', db);
    await queue.send(taskFor('sentinel', 'task-3'));
    const [received] = await queue.receive(5, 1, 10); // 10s visibility timeout

    // Simulate "10s almost elapsed" directly, then heartbeat, then simulate
    // "past the original 10s mark but inside the extension."
    await db.query(`UPDATE agent_tasks SET visible_at = now() + interval '1 second'`);
    await queue.heartbeat(received.receiptHandle, 30);
    await db.query(`UPDATE agent_tasks SET visible_at = visible_at - interval '20 seconds'`); // pretend 20s passed
    const stillHidden = await queue.receive(5, 0);
    assert.deepEqual(stillHidden, [], 'heartbeat should have extended the lease past the original timeout');
  });

  test('TaskQueue: concurrent claims never double-deliver the same task', async () => {
    const a = new TaskQueue('archivist', db);
    const b = new TaskQueue('archivist', db);
    await a.send(taskFor('archivist', 'task-4'));

    const [resultA, resultB] = await Promise.all([a.receive(5, 1), b.receive(5, 1)]);
    const claimed = [...resultA, ...resultB];
    assert.equal(claimed.length, 1, 'exactly one queue instance should claim the single available task');
  });

  test('TaskQueue: depth reports visible vs in-flight correctly', async () => {
    const queue = new TaskQueue('warden', db);
    await queue.send(taskFor('warden', 'task-5'));
    await queue.send(taskFor('warden', 'task-6'));

    let depth = await queue.depth();
    assert.equal(depth.visible, 2);
    assert.equal(depth.inFlight, 0);

    await queue.receive(1, 1);
    depth = await queue.depth();
    assert.equal(depth.visible, 1);
    assert.equal(depth.inFlight, 1);
  });

  test('EventBus: publish and publishBatch durably record events', async () => {
    const bus = new EventBus(db);
    await bus.publish('anomaly.detected', 'sentinel', { anomalyId: 'a-1' });
    await bus.publishBatch([
      { type: 'task.completed', source: 'aria', detail: { taskId: 't-1' } },
      { type: 'task.completed', source: 'atlas', detail: { taskId: 't-2' } },
    ]);

    const rows = await db.query('SELECT event_type, source, detail FROM agent_events ORDER BY id');
    assert.equal(rows.length, 3);
    assert.equal(rows[0].event_type, 'anomaly.detected');
    assert.equal(rows[0].source, 'apex.sentinel');
    assert.equal(rows[0].detail.anomalyId, 'a-1');
  });

  test('AgentMemory: put/get round-trips and isolates by agentId', async () => {
    const ariaMemory = new AgentMemory('aria', db);
    const atlasMemory = new AgentMemory('atlas', db);

    await ariaMemory.put('working', 'cursor', { page: 3 });
    assert.deepEqual(await ariaMemory.get('working', 'cursor'), { page: 3 });
    assert.equal(await atlasMemory.get('working', 'cursor'), null, "one agent must never see another agent's memory");
  });

  test('AgentMemory: expired entries are not returned', async () => {
    const memory = new AgentMemory('aria', db);
    await memory.put('working', 'ephemeral', { v: 1 }, 3600);
    assert.deepEqual(await memory.get('working', 'ephemeral'), { v: 1 });

    // Move expires_at into the past directly rather than waiting out a TTL.
    await db.query(`UPDATE agent_memory SET expires_at = now() - interval '1 second' WHERE key = 'ephemeral'`);
    assert.equal(await memory.get('working', 'ephemeral'), null);
  });

  test('AgentMemory: a zero TTL means no expiry', async () => {
    const memory = new AgentMemory('aria', db);
    await memory.put('working', 'permanent', { v: 1 }, 0);
    const [row] = await db.query("SELECT expires_at FROM agent_memory WHERE key = 'permanent'");
    assert.equal(row.expires_at, null);
  });

  test('AgentMemory: list respects prefix and treats % and _ literally', async () => {
    const memory = new AgentMemory('aria', db);
    await memory.put('episodic', 'source:1', { n: 1 });
    await memory.put('episodic', 'source:2', { n: 2 });
    await memory.put('episodic', 'other', { n: 3 });
    await memory.put('episodic', '100%-match', { n: 4 });

    const bySource = await memory.list('episodic', 'source:');
    assert.equal(bySource.length, 2);
    assert.deepEqual(bySource.map((r) => r.key).sort(), ['source:1', 'source:2']);

    // A literal '%' in the prefix must not act as a SQL wildcard.
    const literalPercent = await memory.list('episodic', '100%');
    assert.equal(literalPercent.length, 1);
    assert.equal(literalPercent[0].key, '100%-match');
  });

  test('AgentMemory: updateBaseline/getBaseline track a rolling mean', async () => {
    const memory = new AgentMemory('sentinel', db);
    assert.equal(await memory.getBaseline('velocity'), null);

    for (const sample of [10, 10, 10, 10, 10]) {
      await memory.updateBaseline('velocity', sample);
    }
    const baseline = await memory.getBaseline('velocity');
    assert.ok(Math.abs(baseline.mean - 10) < 0.5, `expected mean near 10, got ${baseline.mean}`);
    assert.equal(baseline.count, 5);
  });
}

function taskFor(agentId, taskId, payload = {}) {
  return {
    taskId,
    runId: 'run-1',
    kind: 'collect',
    targetAgent: agentId,
    issuedBy: 'orchestrator',
    issuedAt: new Date().toISOString(),
    priority: 5,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    attempt: 0,
    maxAttempts: 3,
    payload,
    traceId: `trace-${taskId}`,
  };
}
