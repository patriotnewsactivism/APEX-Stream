import { readFileSync } from 'node:fs';

/**
 * Optional CA bundle for verifying the Postgres server's TLS certificate.
 *
 * Most managed Postgres providers present a certificate chain that already
 * roots in a public CA Node trusts by default, so a custom bundle is opt-in:
 * set `DATABASE_CA_BUNDLE_PATH` to the path of a PEM file only for a
 * provider (or self-hosted instance) whose root is not in Node's default
 * trust store.
 *
 * This used to load a committed AWS RDS-specific bundle unconditionally --
 * correct only because Aurora/RDS roots at Amazon's own CA, which is not in
 * Node's trust store, and `rejectUnauthorized: true` with no `ca` option
 * guarantees "self-signed certificate in certificate chain" against it every
 * time. That assumption does not hold for any other host, so verification
 * now defaults to Node's own trust store and a custom bundle is opt-in.
 */
export function loadDatabaseCaBundle(path: string | undefined): string | undefined {
  if (!path) return undefined;
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    console.error(`DATABASE_CA_BUNDLE_PATH (${path}) could not be read; connecting without a custom CA`, err);
    return undefined;
  }
}
