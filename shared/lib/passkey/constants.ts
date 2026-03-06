/**
 * Domain-specific info string for HKDF when deriving k_password_key from
 * PRF output or userHandle. Per ADR: "MetaMask-passkey-password-encryption-v1"
 */
export const PASSKEY_HKDF_INFO = 'MetaMask-passkey-password-encryption-v1';

/** Storage key for the single passkey record in extension local storage */
export const PASSKEY_STORAGE_KEY = 'passkeyUnlockData';
