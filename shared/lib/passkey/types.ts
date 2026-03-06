/**
 * Passkey unlock record stored in extension storage (Device Vault).
 * Used for adaptive PRF + userHandle key derivation per ADR.
 */

export type PasskeyDerivationMethod = 'prf' | 'userHandle';

export type PasskeyRecord = {
  /** Base64url-encoded credential ID from WebAuthn */
  credentialId: string;
  /** How k_password_key was derived: PRF extension or userHandle bytes */
  derivationMethod: PasskeyDerivationMethod;
  /** AES-256-GCM ciphertext of the user password (base64) */
  encryptedPassword: string;
  /** 12-byte IV for AES-GCM (base64) */
  iv: string;
  /** PRF salt used for evaluation (base64); only when derivationMethod === 'prf' */
  prfSalt?: string;
};
