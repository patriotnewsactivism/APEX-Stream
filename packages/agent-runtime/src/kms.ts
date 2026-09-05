import { randomBytes } from 'node:crypto';
import { KeyManagementServiceClient } from '@google-cloud/kms';
import type { DataKeyProvider } from '@apex/core';

/**
 * Cloud KMS-backed `DataKeyProvider`.
 *
 * `packages/core` defines the envelope format and deliberately does not
 * import a cloud SDK — it stays testable and dependency-light, and the
 * provider is injected. This is the concrete provider the services use.
 *
 * Cloud KMS has no direct equivalent of AWS KMS's GenerateDataKey (mint a
 * random key and return a wrapped copy in one call): its `encrypt` API only
 * wraps plaintext you already have. So the data key is generated locally
 * (32 random bytes for AES-256) and wrapped with one `encrypt` call — the
 * external contract (`{plaintext, ciphertext}`, never cached) is identical.
 *
 * Data keys are minted per encryption and never cached. A cached data key is
 * a plaintext key sitting in process memory for the life of the container,
 * which is precisely what envelope encryption exists to avoid; the KMS call
 * is cheap next to what it protects.
 */
export class KmsDataKeyProvider implements DataKeyProvider {
  private readonly kms: KeyManagementServiceClient;

  constructor(
    /** Full Cloud KMS key resource name, e.g. projects/P/locations/L/keyRings/R/cryptoKeys/K. */
    private readonly keyName: string = process.env.GCP_KMS_KEY_NAME ?? '',
    client?: KeyManagementServiceClient,
  ) {
    if (!this.keyName) throw new Error('GCP_KMS_KEY_NAME is required to encrypt or decrypt stored secrets');
    this.kms = client ?? new KeyManagementServiceClient();
  }

  async generateDataKey(): Promise<{ plaintext: Buffer; ciphertext: Buffer }> {
    const plaintext = randomBytes(32); // AES-256
    const [res] = await this.kms.encrypt({ name: this.keyName, plaintext });
    if (!res.ciphertext) throw new Error('Cloud KMS returned no ciphertext for the wrapped data key');
    return { plaintext, ciphertext: Buffer.from(res.ciphertext) };
  }

  async decryptDataKey(ciphertext: Buffer): Promise<Buffer> {
    const [res] = await this.kms.decrypt({ name: this.keyName, ciphertext });
    if (!res.plaintext) throw new Error('Cloud KMS returned no plaintext for the wrapped data key');
    return Buffer.from(res.plaintext);
  }
}
