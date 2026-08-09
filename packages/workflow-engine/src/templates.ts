import type { Workflow } from './schema.js';

/**
 * Starter workflows shown in the dashboard's template gallery. An empty canvas
 * is the fastest way to make a no-code builder go unused — these give an
 * operator something working to modify on day one.
 */
export const WORKFLOW_TEMPLATES: Workflow[] = [
  {
    id: 'tpl-breaking-news-watch',
    name: 'Breaking news watch',
    description:
      'Polls tagged news feeds every 15 minutes, scores each item, archives anything elevated or above, and emails on critical only.',
    version: 1,
    status: 'draft',
    createdBy: 'system',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    limits: { maxNodesExecuted: 100, maxDurationSeconds: 900, maxCostUsd: 2 },
    nodes: [
      { id: 'n1', label: 'Every 15 minutes', position: { x: 80, y: 200 }, config: { type: 'trigger', mode: 'schedule', schedule: 'rate(15 minutes)' } },
      { id: 'n2', label: 'Pull news feeds', position: { x: 300, y: 200 }, config: { type: 'source', sourceIds: [], tagSelector: ['news'], maxItems: 50 } },
      { id: 'n3', label: 'Score', position: { x: 520, y: 200 }, config: { type: 'score', profileId: 'apex.default', disabledSignals: [] } },
      { id: 'n4', label: 'Route by severity', position: { x: 740, y: 200 }, config: { type: 'branch', cases: [{ label: 'critical', field: 'band', op: 'eq', value: 'critical' }, { label: 'elevated', field: 'band', op: 'eq', value: 'elevated' }], defaultLabel: 'else' } },
      { id: 'n5', label: 'Archive evidence', position: { x: 980, y: 120 }, config: { type: 'archive', retentionDays: 365, includeMedia: true, captureScreenshot: true } },
      { id: 'n6', label: 'Email operator', position: { x: 1200, y: 120 }, config: { type: 'notify', channel: 'email', target: 'operator@example.com', subjectTemplate: 'CRITICAL: {{sourceLabel}} scored {{score}}', bodyTemplate: '{{scoring.explanation}}', dedupeWindowMinutes: 30 } },
      { id: 'n7', label: 'Archive only', position: { x: 980, y: 280 }, config: { type: 'archive', retentionDays: 180, includeMedia: false, captureScreenshot: false } },
    ],
    edges: [
      { id: 'e1', from: 'n1', to: 'n2' },
      { id: 'e2', from: 'n2', to: 'n3' },
      { id: 'e3', from: 'n3', to: 'n4' },
      { id: 'e4', from: 'n4', to: 'n5', label: 'critical' },
      { id: 'e5', from: 'n5', to: 'n6' },
      { id: 'e6', from: 'n4', to: 'n7', label: 'elevated' },
    ],
  },
  {
    id: 'tpl-silent-edit-detector',
    name: 'Silent edit detector',
    description:
      'Re-fetches watched pages hourly via Atlas, compares against the archived fingerprint, and alerts when a page changes without a correction notice.',
    version: 1,
    status: 'draft',
    createdBy: 'system',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    limits: { maxNodesExecuted: 100, maxDurationSeconds: 1800, maxCostUsd: 3 },
    nodes: [
      { id: 'n1', label: 'Hourly', position: { x: 80, y: 200 }, config: { type: 'trigger', mode: 'schedule', schedule: 'rate(1 hour)' } },
      { id: 'n2', label: 'Watched pages', position: { x: 300, y: 200 }, config: { type: 'source', sourceIds: [], tagSelector: ['watch-page'], maxItems: 100 } },
      { id: 'n3', label: 'Atlas: diff against archive', position: { x: 540, y: 200 }, config: { type: 'agent_task', agent: 'atlas', kind: 'diff', priority: 4, timeoutSeconds: 300, params: { compareTo: 'latest_archived' } } },
      { id: 'n4', label: 'Changed only', position: { x: 800, y: 200 }, config: { type: 'filter', conditions: [{ field: 'similarity', op: 'lt', value: 0.98 }] } },
      { id: 'n5', label: 'Score', position: { x: 1020, y: 200 }, config: { type: 'score', profileId: 'apex.default', disabledSignals: ['amplification_asymmetry'] } },
      { id: 'n6', label: 'Archive both versions', position: { x: 1240, y: 200 }, config: { type: 'archive', retentionDays: 730, includeMedia: true, captureScreenshot: true } },
      { id: 'n7', label: 'Notify dashboard', position: { x: 1460, y: 200 }, config: { type: 'notify', channel: 'dashboard', target: 'command-deck', subjectTemplate: 'Page changed: {{sourceLabel}}', bodyTemplate: 'Similarity {{similarity}} — {{scoring.explanation}}', dedupeWindowMinutes: 60 } },
    ],
    edges: [
      { id: 'e1', from: 'n1', to: 'n2' },
      { id: 'e2', from: 'n2', to: 'n3' },
      { id: 'e3', from: 'n3', to: 'n4' },
      { id: 'e4', from: 'n4', to: 'n5' },
      { id: 'e5', from: 'n5', to: 'n6' },
      { id: 'e6', from: 'n6', to: 'n7' },
    ],
  },
  {
    id: 'tpl-live-stream-watch',
    name: 'Live stream watch',
    description:
      'Sentinel transcribes a live stream continuously; watchlist hits are scored, archived with the audio segment, and texted to the operator.',
    version: 1,
    status: 'draft',
    createdBy: 'system',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    limits: { maxNodesExecuted: 200, maxDurationSeconds: 21600, maxCostUsd: 25 },
    nodes: [
      { id: 'n1', label: 'On transcript segment', position: { x: 80, y: 200 }, config: { type: 'trigger', mode: 'event', eventType: 'observation.collected' } },
      { id: 'n2', label: 'Score segment', position: { x: 320, y: 200 }, config: { type: 'score', profileId: 'apex.default', disabledSignals: ['silent_edit', 'temporal_anomaly'] } },
      { id: 'n3', label: 'Elevated or above', position: { x: 560, y: 200 }, config: { type: 'filter', conditions: [{ field: 'score', op: 'gte', value: 50 }] } },
      { id: 'n4', label: 'Archivist: capture segment', position: { x: 820, y: 200 }, config: { type: 'agent_task', agent: 'archivist', kind: 'archive', priority: 1, timeoutSeconds: 600, params: { includeAudio: true, paddingSeconds: 30 } } },
      { id: 'n5', label: 'Text operator', position: { x: 1080, y: 200 }, config: { type: 'notify', channel: 'sms', target: '+10000000000', subjectTemplate: 'APEX {{band}}', bodyTemplate: '{{sourceLabel}}: {{score}}/100. {{scoring.topDrivers.0.label}}', dedupeWindowMinutes: 15 } },
    ],
    edges: [
      { id: 'e1', from: 'n1', to: 'n2' },
      { id: 'e2', from: 'n2', to: 'n3' },
      { id: 'e3', from: 'n3', to: 'n4' },
      { id: 'e4', from: 'n4', to: 'n5' },
    ],
  },
];
