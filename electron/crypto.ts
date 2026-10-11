import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scrypt } from 'node:crypto';

export const PRIVATE_HEADER = 'BLACK-COBBLE-PRIVATE';
export const MAX_PRIVATE_BYTES = 16 * 1024 * 1024;
export const KDF = { name: 'scrypt', N: 131072, r: 8, p: 1 } as const;
type Sealed = { nonce: string; tag: string; ciphertext: string };
export type PrivateEnvelope = Sealed & { version: 1; purpose: 'note' | 'draft'; vaultId: string; noteId: string };
export type PrivateMetadata = { version: 1; vaultId: string; kdf: typeof KDF; salt: string; wrappedKey: Sealed };
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function invalid(): never { throw new Error('El formato de cifrado está dañado o no es compatible.'); }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(); return value as Record<string, unknown>; }
function exact(value: Record<string, unknown>, fields: string[]): void { if (Object.keys(value).sort().join(',') !== fields.sort().join(',')) invalid(); }
export function decodeBase64(value: unknown, length?: number): Buffer {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_PRIVATE_BYTES / 3) * 4 || (length !== undefined && value.length !== Math.ceil(length / 3) * 4) || /[^A-Za-z0-9+/=]/.test(value)) invalid();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || (length !== undefined && bytes.length !== length)) invalid();
  return bytes;
}
function validateSealed(value: Record<string, unknown>): void { decodeBase64(value.nonce, 12); decodeBase64(value.tag, 16); if (decodeBase64(value.ciphertext).length > MAX_PRIVATE_BYTES) invalid(); }
function aad(purpose: string, vaultId: string, noteId = ''): Buffer { return Buffer.from(JSON.stringify([PRIVATE_HEADER, 1, purpose, vaultId, noteId])); }
function seal(key: Buffer, bytes: Buffer, authenticated: Buffer): Sealed {
  if (key.length !== 32 || bytes.length > MAX_PRIVATE_BYTES) invalid();
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(authenticated);
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return { nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
}
function unseal(key: Buffer, value: Sealed, authenticated: Buffer): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, decodeBase64(value.nonce, 12));
  decipher.setAAD(authenticated); decipher.setAuthTag(decodeBase64(value.tag, 16));
  let pending: Buffer | undefined;
  try { pending = decipher.update(decodeBase64(value.ciphertext)); return Buffer.concat([pending, decipher.final()]); }
  catch { throw new Error('Contraseña incorrecta o datos cifrados dañados.'); }
  finally { pending?.fill(0); }
}
export function isPrivateBytes(bytes: Uint8Array): boolean { return Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 48)).toString('utf8').replace(/^\ufeff/, '').startsWith('BLACK-COBBLE-PRIV'); }
export function parseEnvelope(bytes: Uint8Array): PrivateEnvelope {
  if (bytes.length > MAX_PRIVATE_BYTES * 2) invalid();
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (!text.startsWith(`${PRIVATE_HEADER}\n`)) invalid();
  let value: Record<string, unknown>;
  try { value = object(JSON.parse(text.slice(PRIVATE_HEADER.length + 1))); } catch { invalid(); }
  exact(value, ['version', 'purpose', 'vaultId', 'noteId', 'nonce', 'tag', 'ciphertext']);
  if (value.version !== 1 || !['note', 'draft'].includes(String(value.purpose)) || typeof value.vaultId !== 'string' || !uuidPattern.test(value.vaultId) || typeof value.noteId !== 'string' || !uuidPattern.test(value.noteId)) invalid();
  validateSealed(value); return value as PrivateEnvelope;
}
export function encryptEnvelope(key: Buffer, vaultId: string, noteId: string, content: string, purpose: 'note' | 'draft' = 'note'): Buffer {
  if (typeof content !== 'string') invalid();
  if (Buffer.byteLength(content, 'utf8') > MAX_PRIVATE_BYTES) throw new Error('Una nota cifrada admite hasta 16 MiB de texto.');
  const bytes = Buffer.from(content, 'utf8'); if (bytes.toString('utf8') !== content) invalid();
  try { return Buffer.from(`${PRIVATE_HEADER}\n${JSON.stringify({ version: 1, purpose, vaultId, noteId, ...seal(key, bytes, aad(purpose, vaultId, noteId)) })}\n`); }
  finally { bytes.fill(0); }
}
export function decryptEnvelope(key: Buffer, envelope: PrivateEnvelope, vaultId: string, purpose: 'note' | 'draft' = 'note'): string {
  if (envelope.vaultId !== vaultId || envelope.purpose !== purpose) invalid();
  const bytes = unseal(key, envelope, aad(purpose, vaultId, envelope.noteId));
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } finally { bytes.fill(0); }
}
export function parseMetadata(bytes: Uint8Array): PrivateMetadata {
  if (bytes.length > 4096) invalid();
  let value: Record<string, unknown>;
  try { value = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); } catch { invalid(); }
  exact(value, ['version', 'vaultId', 'kdf', 'salt', 'wrappedKey']);
  if (value.version !== 1 || typeof value.vaultId !== 'string' || !uuidPattern.test(value.vaultId)) invalid();
  const kdf = object(value.kdf); exact(kdf, ['name', 'N', 'r', 'p']);
  if (kdf.name !== KDF.name || kdf.N !== KDF.N || kdf.r !== KDF.r || kdf.p !== KDF.p) invalid();
  decodeBase64(value.salt, 32);
  const wrapped = object(value.wrappedKey); exact(wrapped, ['nonce', 'tag', 'ciphertext']); validateSealed(wrapped); decodeBase64(wrapped.ciphertext, 32);
  return value as PrivateMetadata;
}
function derive(password: string, salt: Buffer): Promise<Buffer> {
  if (typeof password !== 'string' || !password || Buffer.byteLength(password) > 4096) throw new Error('Contraseña no válida.');
  return new Promise((resolve, reject) => scrypt(password, salt, 32, { N: KDF.N, r: KDF.r, p: KDF.p, maxmem: 256 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)));
}
export async function wrapKey(password: string, key: Buffer, vaultId: string = randomUUID()): Promise<PrivateMetadata> {
  const salt = randomBytes(32); const wrapping = await derive(password, salt);
  try { return { version: 1, vaultId, kdf: KDF, salt: salt.toString('base64'), wrappedKey: seal(wrapping, key, aad('vault-key', vaultId)) }; }
  finally { wrapping.fill(0); }
}
export async function unwrapKey(password: string, metadata: PrivateMetadata): Promise<Buffer> {
  const checked = parseMetadata(Buffer.from(JSON.stringify(metadata)));
  const wrapping = await derive(password, decodeBase64(checked.salt, 32));
  try { return unseal(wrapping, checked.wrappedKey, aad('vault-key', checked.vaultId)); } finally { wrapping.fill(0); }
}
