import { useCallback, useRef, useState } from 'react';
import { api } from '../api.js';

/**
 * The no-code workflow builder.
 *
 * The canvas emits exactly the JSON the executor consumes — there is no
 * translation layer between "what the operator drew" and "what runs". That
 * constraint is why validation can be honest: the same document is validated,
 * stored and executed.
 *
 * Dry run is deliberately prominent. Automation that fires agents and sends
 * alerts should be testable against real data without doing either.
 */

interface Node {
  id: string;
  label: string;
  position: { x: number; y: number };
  config: { type: string; [key: string]: unknown };
}
interface Edge { id: string; from: string; to: string; label?: string }
interface Issue { severity: string; code: string; message: string; nodeId?: string }

const NODE_W = 168;
const NODE_H = 54;

const PALETTE: Array<{ type: string; label: string; defaults: Record<string, unknown> }> = [
  { type: 'trigger', label: 'Trigger', defaults: { mode: 'manual' } },
  { type: 'source', label: 'Sources', defaults: { sourceIds: [], tagSelector: [], maxItems: 50 } },
  { type: 'filter', label: 'Filter', defaults: { conditions: [{ field: 'score', op: 'gte', value: 50 }] } },
  { type: 'score', label: 'Score', defaults: { profileId: 'apex.default', disabledSignals: [] } },
  { type: 'branch', label: 'Branch', defaults: { cases: [{ label: 'critical', field: 'band', op: 'eq', value: 'critical' }], defaultLabel: 'else' } },
  { type: 'agent_task', label: 'Agent task', defaults: { agent: 'aria', kind: 'analyze', priority: 5, timeoutSeconds: 300, params: {} } },
  { type: 'archive', label: 'Archive', defaults: { retentionDays: 365, includeMedia: true, captureScreenshot: false } },
  { type: 'notify', label: 'Notify', defaults: { channel: 'dashboard', target: 'command-deck', dedupeWindowMinutes: 30 } },
  { type: 'delay', label: 'Delay', defaults: { seconds: 60 } },
  { type: 'transform', label: 'Transform', defaults: { mappings: {} } },
];

const EMPTY: { nodes: Node[]; edges: Edge[] } = {
  nodes: [{ id: 'n1', label: 'Manual start', position: { x: 60, y: 200 }, config: { type: 'trigger', mode: 'manual' } }],
  edges: [],
};

export function WorkflowCanvas({ canEdit }: { canEdit: boolean }): JSX.Element {
  const [name, setName] = useState('Untitled workflow');
  const [nodes, setNodes] = useState<Node[]>(EMPTY.nodes);
  const [edges, setEdges] = useState<Edge[]>(EMPTY.edges);
  const [selected, setSelected] = useState<string | null>(null);
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [valid, setValid] = useState<boolean | null>(null);
  const [runResult, setRunResult] = useState<{ status: string; steps: Array<{ label: string; type: string; status: string; itemsIn: number; itemsOut: number }>; haltReason: string | null } | null>(null);
  const [busy, setBusy] = useState(false);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<{ id: string; dx: number; dy: number } | null>(null);

  const workflow = useCallback(
    () => ({
      id: `wf-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) || 'untitled'}`,
      name,
      description: '',
      version: 1,
      status: 'draft',
      nodes,
      edges,
      limits: { maxNodesExecuted: 100, maxDurationSeconds: 900, maxCostUsd: 5 },
    }),
    [name, nodes, edges],
  );

  const toSvgPoint = (event: React.MouseEvent): { x: number; y: number } => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const addNode = (entry: (typeof PALETTE)[number]): void => {
    const id = `n${Date.now().toString(36)}`;
    setNodes((current) => [
      ...current,
      {
        id,
        label: entry.label,
        position: { x: 120 + (current.length % 5) * 190, y: 90 + Math.floor(current.length / 5) * 110 },
        config: { type: entry.type, ...entry.defaults },
      },
    ]);
    setSelected(id);
  };

  const deleteSelected = (): void => {
    if (!selected) return;
    setNodes((current) => current.filter((n) => n.id !== selected));
    setEdges((current) => current.filter((e) => e.from !== selected && e.to !== selected));
    setSelected(null);
  };

  const onNodeMouseDown = (event: React.MouseEvent, node: Node): void => {
    if (!canEdit) return;
    event.stopPropagation();
    const point = toSvgPoint(event);
    if (connectFrom && connectFrom !== node.id) {
      const label = window.prompt('Edge label (required when leaving a Branch node, otherwise leave blank)') ?? '';
      setEdges((current) => [
        ...current,
        { id: `e${Date.now().toString(36)}`, from: connectFrom, to: node.id, ...(label ? { label } : {}) },
      ]);
      setConnectFrom(null);
      return;
    }
    setSelected(node.id);
    dragRef.current = { id: node.id, dx: point.x - node.position.x, dy: point.y - node.position.y };
  };

  const onMouseMove = (event: React.MouseEvent): void => {
    const drag = dragRef.current;
    if (!drag) return;
    const point = toSvgPoint(event);
    setNodes((current) =>
      current.map((n) =>
        n.id === drag.id
          ? { ...n, position: { x: Math.max(10, point.x - drag.dx), y: Math.max(10, point.y - drag.dy) } }
          : n,
      ),
    );
  };

  const validate = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await api.validateWorkflow(workflow());
      setIssues(result.issues);
      setValid(result.valid);
    } finally {
      setBusy(false);
    }
  };

  const saveAndDryRun = async (): Promise<void> => {
    setBusy(true);
    setRunResult(null);
    try {
      const wf = workflow();
      const saved = await api.saveWorkflow(wf);
      setIssues((saved.issues as Issue[]) ?? []);
      const result = await api.executeWorkflow(wf.id, true);
      setRunResult(result);
      setValid(true);
    } catch (err) {
      setIssues([{ severity: 'error', code: 'SAVE_FAILED', message: err instanceof Error ? err.message : String(err) }]);
      setValid(false);
    } finally {
      setBusy(false);
    }
  };

  const nodeIssues = new Set(issues.filter((i) => i.severity === 'error' && i.nodeId).map((i) => i.nodeId));
  const byId = new Map(nodes.map((n) => [n.id, n]));

  return (
    <div>
      <div className="row wrap" style={{ marginBottom: 12 }}>
        <input style={{ maxWidth: 300 }} value={name} onChange={(e) => setName(e.target.value)} disabled={!canEdit} />
        <div className="spacer" />
        <button onClick={validate} disabled={busy}>Validate</button>
        <button className="primary" onClick={saveAndDryRun} disabled={busy || !canEdit}>
          {busy ? 'Working…' : 'Save & dry run'}
        </button>
      </div>

      {canEdit && (
        <div className="palette">
          {PALETTE.map((entry) => (
            <button key={entry.type} onClick={() => addNode(entry)}>+ {entry.label}</button>
          ))}
          <div className="spacer" />
          <button
            onClick={() => setConnectFrom(selected)}
            disabled={!selected}
            title="Click a node, press Connect, then click the target node"
          >
            {connectFrom ? 'Click the target node…' : 'Connect from selected'}
          </button>
          <button className="danger" onClick={deleteSelected} disabled={!selected}>Delete</button>
        </div>
      )}

      <div className="canvas-wrap">
        <svg
          ref={svgRef}
          onMouseMove={onMouseMove}
          onMouseUp={() => { dragRef.current = null; }}
          onMouseLeave={() => { dragRef.current = null; }}
          onClick={() => { setSelected(null); setConnectFrom(null); }}
        >
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#33455e" />
            </marker>
          </defs>

          {edges.map((edge) => {
            const from = byId.get(edge.from);
            const to = byId.get(edge.to);
            if (!from || !to) return null;
            const x1 = from.position.x + NODE_W;
            const y1 = from.position.y + NODE_H / 2;
            const x2 = to.position.x;
            const y2 = to.position.y + NODE_H / 2;
            const mid = (x1 + x2) / 2;
            return (
              <g key={edge.id}>
                <path className="wf-edge" d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`} />
                {edge.label && (
                  <text className="wf-edge-label" x={mid} y={(y1 + y2) / 2 - 6} textAnchor="middle">
                    {edge.label}
                  </text>
                )}
              </g>
            );
          })}

          {nodes.map((node) => (
            <g
              key={node.id}
              className={`wf-node ${selected === node.id ? 'selected' : ''} ${nodeIssues.has(node.id) ? 'invalid' : ''}`}
              transform={`translate(${node.position.x}, ${node.position.y})`}
              onMouseDown={(e) => onNodeMouseDown(e, node)}
              onClick={(e) => e.stopPropagation()}
            >
              <rect width={NODE_W} height={NODE_H} rx={9} />
              <text className="type" x={12} y={19}>{String(node.config.type).replace('_', ' ')}</text>
              <text x={12} y={39}>{truncate(node.label, 22)}</text>
            </g>
          ))}
        </svg>
      </div>

      {valid !== null && (
        <div className={`banner ${valid ? 'banner-ok' : 'banner-error'}`} style={{ marginTop: 14 }}>
          {valid
            ? `Valid${issues.length ? ` — ${issues.length} advisory note${issues.length === 1 ? '' : 's'} below` : '. Ready to publish.'}`
            : 'This workflow cannot be published until the errors below are resolved.'}
        </div>
      )}

      {issues.length > 0 && (
        <div style={{ marginTop: 12 }}>
          {issues.map((issue, index) => (
            <div key={`${issue.code}-${index}`} className={`issue issue-${issue.severity}`}>
              <code>{issue.code}</code>
              {issue.message}
            </div>
          ))}
        </div>
      )}

      {runResult && (
        <div className="panel" style={{ marginTop: 14 }}>
          <h4 style={{ marginTop: 0 }}>Dry run — {runResult.status}</h4>
          <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
            Real sources were read; no agents were dispatched, nothing was archived, no alerts were sent.
          </p>
          <table>
            <thead><tr><th>Step</th><th>Type</th><th>In</th><th>Out</th><th>Status</th></tr></thead>
            <tbody>
              {runResult.steps.map((step, index) => (
                <tr key={index}>
                  <td>{step.label}</td>
                  <td className="mono">{step.type}</td>
                  <td>{step.itemsIn}</td>
                  <td>{step.itemsOut}</td>
                  <td>{step.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {runResult.haltReason && <div className="banner banner-warn" style={{ marginTop: 12 }}>{runResult.haltReason}</div>}
        </div>
      )}
    </div>
  );
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
