/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {DevTools, WebAuthnModel} from '../third_party/index.js';
import {zod} from '../third_party/index.js';

import {ToolCategory} from './categories.js';
import {definePageTool} from './ToolDefinition.js';

type AuthenticatorId = DevTools.Protocol.WebAuthn.AuthenticatorId;

const authenticatorsByModel = new WeakMap<WebAuthnModel, Set<string>>();

function getAuthenticators(model: WebAuthnModel): Set<string> {
  let authenticators = authenticatorsByModel.get(model);
  if (!authenticators) {
    authenticators = new Set();
    authenticatorsByModel.set(model, authenticators);
  }
  return authenticators;
}

function requireAuthenticatorId(
  model: WebAuthnModel,
  authenticatorId: string | undefined,
): AuthenticatorId {
  if (!authenticatorId) {
    throw new Error('authenticatorId is required for this action.');
  }
  if (!getAuthenticators(model).has(authenticatorId)) {
    throw new Error(
      `No virtual authenticator with id "${authenticatorId}" on this page.`,
    );
  }
  return authenticatorId as AuthenticatorId;
}

function throwOnProtocolError(response: {
  getError(): string | undefined;
}): void {
  const error = response.getError();
  if (error) {
    throw new Error(error);
  }
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
    const {action} = request.params;
    const model = await request.page.getWebAuthnModel();
    const authenticators = getAuthenticators(model);

    switch (action) {
      case 'add_authenticator': {
        const authenticatorId = await model.addAuthenticator({
          protocol: (request.params.protocol ??
            'ctap2') as DevTools.Protocol.WebAuthn.AuthenticatorProtocol,
          transport: (request.params.transport ??
            'internal') as DevTools.Protocol.WebAuthn.AuthenticatorTransport,
          hasResidentKey: request.params.hasResidentKey ?? true,
          hasUserVerification: request.params.hasUserVerification ?? true,
          isUserVerified: request.params.isUserVerified ?? true,
          automaticPresenceSimulation: true,
        });
        if (!authenticatorId) {
          throw new Error('Failed to add a virtual authenticator.');
        }
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
          model,
          request.params.authenticatorId,
        );
        await model.removeAuthenticator(authenticatorId);
        authenticators.delete(authenticatorId);
        response.appendResponseLine(
          `Removed virtual authenticator: ${authenticatorId}`,
        );
        return;
      }
      case 'list_credentials': {
        const authenticatorId = requireAuthenticatorId(
          model,
          request.params.authenticatorId,
        );
        const credentials = await model.getCredentials(authenticatorId);
        if (!credentials?.length) {
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
          model,
          request.params.authenticatorId,
        );
        throwOnProtocolError(
          await model
            .target()
            .webAuthnAgent()
            .invoke_clearCredentials({authenticatorId}),
        );
        response.appendResponseLine(
          `Cleared all credentials in ${authenticatorId}.`,
        );
        return;
      }
      case 'set_user_verified': {
        const authenticatorId = requireAuthenticatorId(
          model,
          request.params.authenticatorId,
        );
        if (request.params.isUserVerified === undefined) {
          throw new Error('isUserVerified is required for set_user_verified.');
        }
        throwOnProtocolError(
          await model.target().webAuthnAgent().invoke_setUserVerified({
            authenticatorId,
            isUserVerified: request.params.isUserVerified,
          }),
        );
        response.appendResponseLine(
          `User verification for ${authenticatorId} now ${request.params.isUserVerified ? 'succeeds' : 'fails'}.`,
        );
        return;
      }
    }
  },
}));
