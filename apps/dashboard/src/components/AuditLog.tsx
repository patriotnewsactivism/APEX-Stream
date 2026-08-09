import { useState } from 'react';
import { api, type AuditEntry, type ChainVerification } from '../api.js';

export function AuditLog({ entries, loading }: { entries: AuditEntry[]; loading: boolean }): JSX.Element {
  const [verification, setVerification] = useState<ChainVerification | null>(null);
  const [verifying, setVerifying] = useState(false);

  const verify = async (): Promise<void> => {
    setVerifying(true);
    try {
      setVerification(await api.verifyAudit(0));
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div>
      <div className="row" style={{ marginBottom: 14 }}>
        <button onClick={verify} disabled={verifying}>
          {verifying ? 'Verifying…' : 'Verify chain integrity'}
        </button>
        <span className="muted" style={{ fontSize: 12 }}>
          Recomputes every hash and checks each entry against its predecessor.
        </span>
      </div>

      {verification && (
        <div className={`banner ${verification.valid ? 'banner-ok' : 'banner-error'}`}>
          {verification.valid ? (
            <>
              <strong>Chain intact.</strong> {verification.entriesChecked} entries verified — no entry has been
              modified, reordered or removed since it was written.
            </>
          ) : (
            <>
              <strong>Chain broken at entry {verification.brokenAtSequence}.</strong> {verification.reason}
            </>
          )}
        </div>
      )}

      {loading && entries.length === 0 ? (
        <div className="empty"><span className="spin" /> Loading audit log…</div>
      ) : entries.length === 0 ? (
        <div className="empty">No audit entries yet.</div>
      ) : (
        <table>
          <thead>
            <tr><th>#</th><th>When</th><th>Actor</th><th>Action</th><th>Resource</th><th>Result</th><th>Hash</th></tr>
          </thead>
          <tbody>
            {entries
              .slice()
              .reverse()
              .map((entry) => (
                <tr key={entry.entryHash}>
                  <td className="mono">{entry.sequence}</td>
                  <td>{new Date(entry.recordedAt).toLocaleString()}</td>
                  <td>{entry.actor}<div className="signal-meta">{entry.actorType}</div></td>
                  <td className="mono">{entry.action}</td>
                  <td className="mono" style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {entry.resourceType}{entry.resourceId ? ` · ${entry.resourceId.slice(0, 8)}` : ''}
                  </td>
                  <td>
                    <span className={`band band-${entry.outcome === 'allowed' ? 'info' : 'critical'}`}>
                      {entry.outcome}
                    </span>
                  </td>
                  <td className="mono" title={entry.entryHash}>{entry.entryHash.slice(0, 10)}…</td>
                </tr>
              ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
