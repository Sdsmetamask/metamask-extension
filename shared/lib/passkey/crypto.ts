/**
 * Passkey key derivation and password encryption/decryption per ADR.
 * Uses Web Crypto (HKDF, AES-256-GCM). Safe to run in popup or any document context.
 */

import { PASSKEY_HKDF_INFO } from './constants';

const HKDF_KEY_LENGTH = 256; // 32 bytes for AES-256

/**
 * Derives k_password_key (32 bytes) from IKM (PRF output or userHandle bytes)
 * using HKDF-SHA256 with credentialId as salt. Per ADR.
 *
 * @param ikm - Input key material (PRF result or userHandle; 32+ bytes)
 * @param credentialId - Credential ID bytes (used as HKDF salt)
 * @returns CryptoKey for AES-256-GCM
 */
export async function deriveKPasswordKey(
  ikm: ArrayBuffer,
  credentialId: ArrayBuffer,
): Promise<CryptoKey> {
  const key = await crypto.subtle.importKey(
    'raw',
    ikm,
    { name: 'HKDF' },
    false,
    ['deriveBits'],
  );

  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: credentialId,
      info: new TextEncoder().encode(PASSKEY_HKDF_INFO),
    },
    key,
    HKDF_KEY_LENGTH,
  );

  return crypto.subtle.importKey(
    'raw',
    bits,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Encrypts password with k_password_key using AES-256-GCM. Generates a fresh 12-byte IV.
 *
 * @param password - Plain password (UTF-8)
 * @param key - CryptoKey from deriveKPasswordKey
 * @returns Object with base64-encoded ciphertext and iv
 */
export async function encryptPassword(
  password: string,
  key: CryptoKey,
): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(password);

  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
      tagLength: 128,
    },
    key,
    encoded,
  );

  return {
    ciphertext: arrayBufferToBase64(ciphertext),
    iv: arrayBufferToBase64(iv),
  };
}

/**
 * Decrypts password from ciphertext + iv using k_password_key.
 *
 * @param ciphertext - Base64-encoded ciphertext (including auth tag)
 * @param ivBase64 - Base64-encoded 12-byte IV
 * @param key - CryptoKey from deriveKPasswordKey
 * @returns Decrypted password string
 */
export async function decryptPassword(
  ciphertext: string,
  ivBase64: string,
  key: CryptoKey,
): Promise<string> {
  const iv = base64ToArrayBuffer(ivBase64);
  const data = base64ToArrayBuffer(ciphertext);

  const decrypted = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv,
      tagLength: 128,
    },
    key,
    data,
  );

  return new TextDecoder().decode(decrypted);
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/** Decode base64 string to Uint8Array (e.g. for prf salt in WebAuthn get). */
export function base64ToArrayBufferExport(base64: string): ArrayBuffer {
  return base64ToArrayBuffer(base64);
}

/**
 * Encodes ArrayBuffer to base64url (for credentialId in WebAuthn).
 */
export function arrayBufferToBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Decodes base64url to Uint8Array.
 */
export function base64UrlToArrayBuffer(base64url: string): Uint8Array {
  let base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const pad = base64.length % 4;
  if (pad) {
    base64 += '='.repeat(4 - pad);
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
