import { describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { PRIVATE_HEADER, decryptEnvelope, encryptEnvelope, isPrivateBytes, parseEnvelope, parseMetadata, unwrapKey, wrapKey } from '../electron/crypto';

describe('private crypto format', () => {
  it('round-trips Unicode and BOM with fresh nonces and authenticates purpose and identity', () => {
    const key = randomBytes(32); const vault = randomUUID(); const note = randomUUID();
    const content = '\ufeff# Prueba 日本語 🙂\n\nSynthetic secret 1823';
    const first = encryptEnvelope(key, vault, note, content);
    const second = encryptEnvelope(key, vault, note, content);
    expect(first.equals(second)).toBe(false);
    expect(first.toString()).not.toContain('Synthetic secret');
    const envelope = parseEnvelope(first);
    expect(decryptEnvelope(key, envelope, vault)).toBe(content);
    expect(() => decryptEnvelope(key, { ...envelope, noteId: randomUUID() }, vault)).toThrow();
    expect(() => decryptEnvelope(key, envelope, randomUUID())).toThrow();
    expect(() => decryptEnvelope(key, { ...envelope, purpose: 'draft' }, vault, 'draft')).toThrow();
  });
  it('rejects changed ciphertext/tag and malformed or future envelopes', () => {
    const key = randomBytes(32); const vault = randomUUID();
    const envelope = parseEnvelope(encryptEnvelope(key, vault, randomUUID(), 'Synthetic content'));
    const tag = Buffer.from(envelope.tag, 'base64'); tag[0] ^= 1;
    expect(() => decryptEnvelope(key, { ...envelope, tag: tag.toString('base64') }, vault)).toThrow();
    const data = Buffer.from(envelope.ciphertext, 'base64'); data[0] ^= 1;
    expect(() => decryptEnvelope(key, { ...envelope, ciphertext: data.toString('base64') }, vault)).toThrow();
    for (const patch of [{ version: 2 }, { nonce: 'AAA=' }, { tag: `${envelope.tag}\n` }, { ciphertext: '?' }, { extra: 1 }]) {
      expect(() => parseEnvelope(Buffer.from(`${PRIVATE_HEADER}\n${JSON.stringify({ ...envelope, ...patch })}`))).toThrow();
    }
    expect(isPrivateBytes(Buffer.from(`${PRIVATE_HEADER}-broken`))).toBe(true);
    expect(() => parseEnvelope(Buffer.from(`${PRIVATE_HEADER}-broken`))).toThrow();
  });
  it('wraps only the key, rejects wrong password and untrusted KDF cost', async () => {
    const key = randomBytes(32); const metadata = await wrapKey('synthetic password', key);
    expect((await unwrapKey('synthetic password', metadata)).equals(key)).toBe(true);
    await expect(unwrapKey('wrong password', metadata)).rejects.toThrow();
    expect(JSON.stringify(metadata)).not.toContain(key.toString('base64'));
    expect(() => parseMetadata(Buffer.from(JSON.stringify({ ...metadata, kdf: { ...metadata.kdf, N: 2 ** 30 } })))).toThrow();
    expect(() => parseMetadata(Buffer.from(JSON.stringify({ ...metadata, salt: 'AA==' })))).toThrow();
  });
});
