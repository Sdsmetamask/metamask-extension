/**
 * WebAuthn passkey creation for SRP accounts. Runs in document context (popup/full page).
 * Per ADR: 64-byte user.id, PRF extension with eval salt; derive k_password_key from PRF or userHandle.
 */

import type { PasskeyRecord, PasskeyDerivationMethod } from './types';
import {
  deriveKPasswordKey,
  encryptPassword,
  arrayBufferToBase64Url,
} from './crypto';

const PRF_SALT_LENGTH = 32;

/**
 * Creates a passkey and returns the record to store (encrypted password, credentialId, etc.).
 * Call setPasskeyData(record) after this.
 *
 * @param password - User password (will be encrypted under k_password_key)
 * @returns PasskeyRecord to persist via setPasskeyData
 */
export async function createPasskey(password: string): Promise<PasskeyRecord> {
  const userHandle = crypto.getRandomValues(new Uint8Array(64));
  const prfSalt = crypto.getRandomValues(new Uint8Array(PRF_SALT_LENGTH));

  const createOptions: CredentialCreationOptions = {
    publicKey: {
      rp: {
        name: 'MetaMask',
        id: window.location.hostname || undefined,
      },
      user: {
        id: userHandle,
        name: 'MetaMask User',
        displayName: 'MetaMask',
      },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [
        { alg: -7, type: 'public-key' },
        { alg: -257, type: 'public-key' },
      ],
      authenticatorSelection: {
        residentKey: 'discouraged',
        userVerification: 'required',
        authenticatorAttachment: 'platform',
      },
      extensions: {
        prf: {
          eval: {
            first: prfSalt,
          },
        },
      },
    },
  };

  const credential = await navigator.credentials.create(createOptions);
  if (!credential || !(credential instanceof PublicKeyCredential)) {
    throw new Error('Passkey creation failed or was cancelled');
  }

  const clientExtensionResults = credential.getClientExtensionResults() as {
    prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } };
  };

  const credentialIdBytes = new Uint8Array(credential.rawId);
  const derivationMethod: PasskeyDerivationMethod =
    clientExtensionResults?.prf?.enabled === true &&
    clientExtensionResults?.prf?.results?.first
      ? 'prf'
      : 'userHandle';

  const ikm: ArrayBuffer =
    derivationMethod === 'prf' && clientExtensionResults?.prf?.results?.first
      ? clientExtensionResults.prf.results.first
      : userHandle.buffer;

  const key = await deriveKPasswordKey(ikm, credentialIdBytes);
  const { ciphertext, iv } = await encryptPassword(password, key);

  const record: PasskeyRecord = {
    credentialId: arrayBufferToBase64Url(credentialIdBytes),
    derivationMethod,
    encryptedPassword: ciphertext,
    iv,
  };

  if (derivationMethod === 'prf') {
    record.prfSalt = arrayBufferToBase64(prfSalt);
  }

  return record;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
