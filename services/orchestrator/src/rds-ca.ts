import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * AWS RDS's TLS cert chain roots at Amazon's own RDS CA, which is not in
 * Node's default trust store -- `rejectUnauthorized: true` with no `ca`
 * option guarantees "self-signed certificate in certificate chain" on every
 * connection, always (confirmed live: this was silently breaking every DB
 * call from this service). The bundle is a small, public, permanent AWS file
 * (https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem),
 * committed at packages/core/certs/ (shipped into every service image
 * since Dockerfiles COPY the whole `packages` dir) so real cert validation
 * can actually succeed instead of being silently disabled.
 */
export function loadRdsCaBundle(): string | undefined {
  try {
    return readFileSync(join(process.cwd(), 'packages/core/certs/rds-global-bundle.pem'), 'utf8');
  } catch (err) {
    // Fail loud in logs but don't crash the process over a missing cert file
    // -- fall back to encrypted-but-unverified rather than no TLS at all.
    console.error('rds ca bundle missing, falling back to rejectUnauthorized:false', err);
    return undefined;
  }
}
