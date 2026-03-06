/**
 * Passkey unlock record persistence in extension local storage.
 * Used only from background (metamask-controller). Readable when vault is locked.
 */

import browser from 'webextension-polyfill';
import type { PasskeyRecord } from '../../../shared/lib/passkey';
import { PASSKEY_STORAGE_KEY } from '../../../shared/lib/passkey';

/**
 * Returns the stored passkey record or null if none.
 */
export async function getPasskeyRecord(): Promise<PasskeyRecord | null> {
  const result = await browser.storage.local.get(PASSKEY_STORAGE_KEY);
  const raw = result[PASSKEY_STORAGE_KEY];
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if (
    typeof record.credentialId !== 'string' ||
    typeof record.derivationMethod !== 'string' ||
    typeof record.encryptedPassword !== 'string' ||
    typeof record.iv !== 'string'
  ) {
    return null;
  }
  if (
    record.derivationMethod !== 'prf' &&
    record.derivationMethod !== 'userHandle'
  ) {
    return null;
  }
  return {
    credentialId: record.credentialId,
    derivationMethod: record.derivationMethod as PasskeyRecord['derivationMethod'],
    encryptedPassword: record.encryptedPassword,
    iv: record.iv,
    prfSalt:
      typeof record.prfSalt === 'string' ? record.prfSalt : undefined,
  };
}

/**
 * Stores the passkey record (overwrites any existing single passkey).
 */
export async function setPasskeyRecord(record: PasskeyRecord): Promise<void> {
  await browser.storage.local.set({
    [PASSKEY_STORAGE_KEY]: {
      credentialId: record.credentialId,
      derivationMethod: record.derivationMethod,
      encryptedPassword: record.encryptedPassword,
      iv: record.iv,
      ...(record.prfSalt !== undefined && { prfSalt: record.prfSalt }),
    },
  });
}

/**
 * Removes the passkey record.
 */
export async function clearPasskeyRecord(): Promise<void> {
  await browser.storage.local.remove(PASSKEY_STORAGE_KEY);
}

/**
 * Returns true if a passkey record exists (quick check for UI).
 */
export async function hasPasskeyRecord(): Promise<boolean> {
  const record = await getPasskeyRecord();
  return record !== null;
}
