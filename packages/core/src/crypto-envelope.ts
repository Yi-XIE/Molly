import {
  createCipheriv,
  createDecipheriv,
  createHash,
  diffieHellman,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
  createPrivateKey,
  createPublicKey,
} from 'node:crypto';
import type { EncryptedEnvelope } from '@molly/contracts';

export interface NodeKeyPair {
  publicKey: string;
  privateKey: string;
}

export function generateNodeKeyPair(): NodeKeyPair {
  const pair = generateKeyPairSync('x25519');
  return {
    publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privateKey: pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  };
}

function publicKeyFromBase64(value: string): KeyObject {
  return createPublicKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'spki' });
}

function privateKeyFromBase64(value: string): KeyObject {
  return createPrivateKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'pkcs8' });
}

function deriveKey(privateKey: KeyObject, publicKey: KeyObject): Buffer {
  return createHash('sha256').update(diffieHellman({ privateKey, publicKey })).digest();
}

export function encryptForNode(publicKey: string, plaintext: string): EncryptedEnvelope {
  const ephemeral = generateKeyPairSync('x25519');
  const key = deriveKey(ephemeral.privateKey, publicKeyFromBase64(publicKey));
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    version: 1,
    ephemeralPublicKey: ephemeral.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

export function decryptForNode(privateKey: string, envelope: EncryptedEnvelope): string {
  if (envelope.version !== 1) throw new Error(`Unsupported envelope version: ${envelope.version}`);
  const key = deriveKey(privateKeyFromBase64(privateKey), publicKeyFromBase64(envelope.ephemeralPublicKey));
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}
