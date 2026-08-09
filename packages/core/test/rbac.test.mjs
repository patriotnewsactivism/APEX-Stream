import { test } from 'node:test';
import assert from 'node:assert/strict';
import { can, decide, ROLES } from '../dist/index.js';

test('owner has broad access', () => {
  assert.equal(can(['owner'], 'config:write'), true);
  assert.equal(can(['owner'], 'billing:read'), true);
});

test('nobody can delete evidence — not even the owner', () => {
  for (const role of ROLES) {
    assert.equal(can([role], 'evidence:delete'), false, `${role} must not delete evidence`);
  }
});

test('deny beats grant regardless of role order', () => {
  const d = decide(['viewer', 'owner'], 'evidence:read');
  assert.equal(d.allowed, false, 'viewer explicitly denies evidence:*');
  assert.match(d.matchedRule, /viewer:deny/);
});

test('operator can trigger beast mode, analyst cannot', () => {
  assert.equal(can(['operator'], 'agent:beast_mode'), true);
  assert.equal(can(['analyst'], 'agent:beast_mode'), false);
});

test('wildcards match one segment only', () => {
  assert.equal(can(['admin'], 'agent:start'), true);
  assert.equal(can(['admin'], 'billing:read'), false);
});

test('decisions carry a human-readable reason for the audit log', () => {
  const d = decide(['viewer'], 'run:cancel');
  assert.equal(d.allowed, false);
  assert.match(d.reason, /no role in \[viewer\]/);
});
