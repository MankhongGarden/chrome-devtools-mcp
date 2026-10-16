/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {CDPSession, Page} from '../third_party/index.js';
import {zod} from '../third_party/index.js';

import {ToolCategory} from './categories.js';
import {definePageTool} from './ToolDefinition.js';

const enabledSessions = new WeakSet<CDPSession>();
const authenticatorsByPage = new WeakMap<Page, Set<string>>();

async function getWebAuthnSession(page: Page): Promise<CDPSession> {
  // @ts-expect-error internal API
  const session: CDPSession = page._client();
  if (!enabledSessions.has(session)) {
    await session.send('WebAuthn.enable', {enableUI: false});
    enabledSessions.add(session);
  }
  return session;
}

function getAuthenticators(page: Page): Set<string> {
  let authenticators = authenticatorsByPage.get(page);
  if (!authenticators) {
    authenticators = new Set();
    authenticatorsByPage.set(page, authenticators);
  }
  return authenticators;
}

function requireAuthenticatorId(
  page: Page,
  authenticatorId: string | undefined,
): string {
  if (!authenticatorId) {
    throw new Error('authenticatorId is required for this action.');
  }
  if (!getAuthenticators(page).has(authenticatorId)) {
    throw new Error(
      `No virtual authenticator with id "${authenticatorId}" on this page.`,
    );
  }
  return authenticatorId;
}

export const configureWebAuthn = definePageTool(() => ({
  name: 'configure_webauthn',
  description:
    'Manages virtual WebAuthn authenticators on the selected page so passkey and security key flows can be tested without a physical device. ' +
    'Add an authenticator before the page calls navigator.credentials.create() or get(); it then answers those calls automatically. ' +
    'Authenticators belong to the page and are removed when it closes.',
  annotations: {
    category: ToolCategory.WEBAUTHN,
    readOnlyHint: false,
  },
  schema: {
    action: zod
      .enum([
        'add_authenticator',
        'remove_authenticator',
        'list_authenticators',
        'list_credentials',
        'clear_credentials',
        'set_user_verified',
      ])
      .describe('The operation to perform.'),
    authenticatorId: zod
      .string()
      .optional()
      .describe(
        'The authenticator to act on, as returned by add_authenticator. Required for every action except add_authenticator and list_authenticators.',
      ),
    protocol: zod
      .enum(['ctap2', 'u2f'])
      .optional()
      .describe('add_authenticator: the protocol to emulate. Default: ctap2.'),
    transport: zod
      .enum(['internal', 'usb', 'nfc', 'ble', 'hybrid'])
      .optional()
      .describe(
        'add_authenticator: "internal" emulates a platform authenticator such as Touch ID or Windows Hello; the others emulate roaming security keys. Default: internal.',
      ),
    hasResidentKey: zod
      .boolean()
      .optional()
      .describe(
        'add_authenticator: whether the authenticator can store discoverable credentials (passkeys). Default: true.',
      ),
    hasUserVerification: zod
      .boolean()
      .optional()
      .describe(
        'add_authenticator: whether the authenticator supports user verification (PIN or biometrics). Default: true.',
      ),
    isUserVerified: zod
      .boolean()
      .optional()
      .describe(
        'add_authenticator and set_user_verified: whether user verification succeeds. Set to false to test a failed verification. Default: true.',
      ),
  },
  blockedByDialog: false,
  verifyFilesSchema: {},
  handler: async (request, response) => {
    const page = request.page.pptrPage;
    const {action} = request.params;
    const session = await getWebAuthnSession(page);
    const authenticators = getAuthenticators(page);

    switch (action) {
      case 'add_authenticator': {
        const {authenticatorId} = await session.send(
          'WebAuthn.addVirtualAuthenticator',
          {
            options: {
              protocol: request.params.protocol ?? 'ctap2',
              transport: request.params.transport ?? 'internal',
              hasResidentKey: request.params.hasResidentKey ?? true,
              hasUserVerification: request.params.hasUserVerification ?? true,
              isUserVerified: request.params.isUserVerified ?? true,
              automaticPresenceSimulation: true,
            },
          },
        );
        authenticators.add(authenticatorId);
        response.appendResponseLine(
          `Added virtual authenticator: ${authenticatorId}`,
        );
        return;
      }
      case 'list_authenticators': {
        if (authenticators.size === 0) {
          response.appendResponseLine(
            'No virtual authenticators on this page.',
          );
          return;
        }
        response.appendResponseLine('Virtual authenticators:');
        for (const id of authenticators) {
          response.appendResponseLine(`- ${id}`);
        }
        return;
      }
      case 'remove_authenticator': {
        const authenticatorId = requireAuthenticatorId(
          page,
          request.params.authenticatorId,
        );
        await session.send('WebAuthn.removeVirtualAuthenticator', {
          authenticatorId,
        });
        authenticators.delete(authenticatorId);
        response.appendResponseLine(
          `Removed virtual authenticator: ${authenticatorId}`,
        );
        return;
      }
      case 'list_credentials': {
        const authenticatorId = requireAuthenticatorId(
          page,
          request.params.authenticatorId,
        );
        const {credentials} = await session.send('WebAuthn.getCredentials', {
          authenticatorId,
        });
        if (credentials.length === 0) {
          response.appendResponseLine(
            `No credentials stored in ${authenticatorId}.`,
          );
          return;
        }
        response.appendResponseLine(`Credentials in ${authenticatorId}:`);
        for (const credential of credentials) {
          const fields = [
            `credentialId=${credential.credentialId}`,
            `rpId=${credential.rpId ?? 'unknown'}`,
            `discoverable=${credential.isResidentCredential}`,
            `signCount=${credential.signCount}`,
          ];
          if (credential.userName) {
            fields.push(`userName=${credential.userName}`);
          }
          response.appendResponseLine(`- ${fields.join(', ')}`);
        }
        return;
      }
      case 'clear_credentials': {
        const authenticatorId = requireAuthenticatorId(
          page,
          request.params.authenticatorId,
        );
        await session.send('WebAuthn.clearCredentials', {authenticatorId});
        response.appendResponseLine(
          `Cleared all credentials in ${authenticatorId}.`,
        );
        return;
      }
      case 'set_user_verified': {
        const authenticatorId = requireAuthenticatorId(
          page,
          request.params.authenticatorId,
        );
        if (request.params.isUserVerified === undefined) {
          throw new Error('isUserVerified is required for set_user_verified.');
        }
        await session.send('WebAuthn.setUserVerified', {
          authenticatorId,
          isUserVerified: request.params.isUserVerified,
        });
        response.appendResponseLine(
          `User verification for ${authenticatorId} now ${request.params.isUserVerified ? 'succeeds' : 'fails'}.`,
        );
        return;
      }
    }
  },
}));
