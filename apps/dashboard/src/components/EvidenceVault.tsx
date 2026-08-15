import { Fragment, useState } from 'react';
import type { EvidenceItem } from '../api.js';

export function EvidenceVault({ items, loading }: { items: EvidenceItem[]; loading: boolean }): JSX.Element {
  const [open, setOpen] = useState<string | null>(null);

  if (loading && items.length === 0) return <div className="empty"><span className="spin" /> Loading vault…</div>;
  if (items.length === 0) {
    return <div className="empty">No evidence captured yet. Archivist writes here when an anomaly is detected.</div>;
  }

  return (
    <div>
      <div className="banner banner-ok">
        Every object below is under S3 Object Lock in compliance mode. It cannot be deleted or altered
        before its retention date — not by an administrator, not by the account root, not by this application.
      </div>

      <table>
        <thead>
          <tr>
            <th>Captured</th><th>Object</th><th>SHA-256</th><th>Size</th><th>Locked until</th><th />
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <Fragment key={item.id}>
              <tr>
                <td>{new Date(item.captured_at).toLocaleString()}</td>
                <td className="mono" style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {item.s3_key.split('/').slice(-2).join('/')}
                </td>
                <td className="mono" title={item.sha256}>{item.sha256.slice(0, 12)}…</td>
                <td>{formatBytes(item.bytes)}</td>
                <td>{new Date(item.retain_until).toLocaleDateString()}</td>
                <td>
                  <button onClick={() => setOpen(open === item.id ? null : item.id)}>
                    {open === item.id ? 'Hide' : 'Custody'}
                  </button>
                </td>
              </tr>
              {open === item.id && (
                <tr>
                  <td colSpan={6} style={{ background: '#0d141d' }}>
                    <strong style={{ fontSize: 12 }}>Chain of custody</strong>
                    <div style={{ marginTop: 8 }}>
                      {(item.chain_of_custody ?? []).map((event, index) => (
                        <div key={event.entryHash} className="signal-meta" style={{ marginBottom: 5 }}>
                          <span style={{ color: 'var(--accent)' }}>{index + 1}. {event.action}</span>{' '}
                          — {event.detail}
                          <br />
                          <span style={{ opacity: 0.7 }}>
                            {new Date(event.at).toLocaleString()} by {event.actor} · {event.entryHash.slice(0, 16)}…
                          </span>
                        </div>
                      ))}
                    </div>
                    <div className="signal-meta" style={{ marginTop: 10 }}>
                      manifest {item.manifest_sha256.slice(0, 24)}…
                    </div>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}
