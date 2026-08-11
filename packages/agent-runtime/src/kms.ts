import { DecryptCommand, GenerateDataKeyCommand, KMSClient } from '@aws-sdk/client-kms';
import type { DataKeyProvider } from '@apex/core';

/**
 * KMS-backed `DataKeyProvider`.
 *
 * `packages/core` defines the envelope format and deliberately does not import
 * the AWS SDK — it stays testable and dependency-light, and the provider is
 * injected. This is the concrete provider the services use.
 *
 * Data keys are minted per encryption and never cached. A cached data key is a
 * plaintext key sitting in process memory for the life of the container, which
 * is precisely what envelope encryption exists to avoid; the KMS call is cheap
 * next to what it protects.
 */
export class KmsDataKeyProvider implements DataKeyProvider {
  private readonly kms: KMSClient;

  constructor(
    private readonly keyId: string = process.env.KMS_KEY_ID ?? '',
    client?: KMSClient,
  ) {
    if (!this.keyId) throw new Error('KMS_KEY_ID is required to encrypt or decrypt stored secrets');
    this.kms = client ?? new KMSClient({});
  }

  async generateDataKey(): Promise<{ plaintext: Buffer; ciphertext: Buffer }> {
    const res = await this.kms.send(
      new GenerateDataKeyCommand({ KeyId: this.keyId, KeySpec: 'AES_256' }),
    );
    if (!res.Plaintext || !res.CiphertextBlob) throw new Error('KMS returned an incomplete data key');
    return {
      plaintext: Buffer.from(res.Plaintext),
      ciphertext: Buffer.from(res.CiphertextBlob),
    };
  }

  async decryptDataKey(ciphertext: Buffer): Promise<Buffer> {
    const res = await this.kms.send(
      new DecryptCommand({ KeyId: this.keyId, CiphertextBlob: ciphertext }),
    );
    if (!res.Plaintext) throw new Error('KMS returned no plaintext for the wrapped data key');
    return Buffer.from(res.Plaintext);
  }
}
