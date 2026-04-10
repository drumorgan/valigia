/**
 * Shared AES-256-GCM encryption/decryption for API key storage.
 * Requires env var: API_KEY_ENCRYPTION_KEY (base64-encoded 256-bit key)
 *
 * Generate with: openssl rand -base64 32
 */

function getEncryptionKey(): string {
  const key = Deno.env.get('API_KEY_ENCRYPTION_KEY');
  if (!key) throw new Error('Missing API_KEY_ENCRYPTION_KEY env var');
  return key;
}

function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function bytesToBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

async function importKey(rawB64: string): Promise<CryptoKey> {
  const raw = base64ToBytes(rawB64);
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

export async function encryptApiKey(
  plaintext: string,
  keyVersion = 1
): Promise<{ ciphertext: string; iv: string; keyVersion: number }> {
  const rawKey = getEncryptionKey();
  const key = await importKey(rawKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);

  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoded
  );

  return {
    ciphertext: bytesToBase64(new Uint8Array(encrypted)),
    iv: bytesToBase64(iv),
    keyVersion,
  };
}

export async function decryptApiKey(
  ciphertextB64: string,
  ivB64: string,
  _keyVersion = 1
): Promise<string> {
  const rawKey = getEncryptionKey();
  const key = await importKey(rawKey);
  const iv = base64ToBytes(ivB64);
  const ciphertext = base64ToBytes(ciphertextB64);

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext
  );

  return new TextDecoder().decode(decrypted);
}
