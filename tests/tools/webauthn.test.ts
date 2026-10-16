/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {describe, it} from 'node:test';

import type {McpContext} from '../../src/McpContext.js';
import type {McpResponse} from '../../src/McpResponse.js';
import {configureWebAuthn} from '../../src/tools/webauthn.js';
import {serverHooks} from '../server.js';
import {html, withMcpContext} from '../utils.js';

const PASSKEY_PAGE = html`<script>
  window.register = async () => {
    const credential = await navigator.credentials.create({
      publicKey: {
        challenge: new Uint8Array(32),
        rp: {name: 'Test'},
        user: {
          id: new Uint8Array([1, 2, 3, 4]),
          name: 'alice@example.com',
          displayName: 'Alice',
        },
        pubKeyCredParams: [{type: 'public-key', alg: -7}],
        authenticatorSelection: {
          residentKey: 'required',
          userVerification: 'required',
        },
      },
    });
    return credential.id;
  };
  window.signIn = async () => {
    try {
      const credential = await navigator.credentials.get({
        publicKey: {
          challenge: new Uint8Array(32),
          userVerification: 'required',
        },
      });
      return credential.id;
    } catch (error) {
      return error.name;
    }
  };
</script>`;

async function run(
  context: McpContext,
  response: McpResponse,
  params: Parameters<
    ReturnType<typeof configureWebAuthn>['handler']
  >[0]['params'],
  args: Parameters<typeof configureWebAuthn>[0],
): Promise<string[]> {
  response.resetResponseLineForTesting();
  await configureWebAuthn(args).handler(
    {params, page: context.getSelectedMcpPage()},
    response,
    context,
  );
  return [...response.responseLines];
}

// WebAuthn rejects IP addresses as relying party ids.
function localhostRoute(url: string): string {
  return url.replace('//127.0.0.1:', '//localhost:');
}

function authenticatorIdFrom(lines: string[]): string {
  const id = lines[0]?.split(': ')[1];
  assert.ok(id, `no authenticator id in ${JSON.stringify(lines)}`);
  return id;
}

describe('webauthn', () => {
  const server = serverHooks();

  it('registers and signs in with a passkey', async () => {
    server.addHtmlRoute('/passkey.html', PASSKEY_PAGE);
    await withMcpContext(async (response, context, args) => {
      const page = context.getSelectedMcpPage().pptrPage;
      await page.goto(localhostRoute(server.getRoute('/passkey.html')));

      const id = authenticatorIdFrom(
        await run(context, response, {action: 'add_authenticator'}, args),
      );

      const credentialId = await page.evaluate(() =>
        // @ts-expect-error defined by the test page
        window.register(),
      );
      const lines = await run(
        context,
        response,
        {action: 'list_credentials', authenticatorId: id},
        args,
      );
      assert.strictEqual(lines.length, 2);
      assert.match(lines[1], /rpId=localhost/);
      assert.match(lines[1], /discoverable=true/);
      assert.match(lines[1], /userName=alice@example\.com/);
      assert.doesNotMatch(lines[1], /privateKey/);

      const signedIn = await page.evaluate(() =>
        // @ts-expect-error defined by the test page
        window.signIn(),
      );
      assert.strictEqual(signedIn, credentialId);
    });
  });

  it('fails sign-in when user verification is turned off', async () => {
    server.addHtmlRoute('/passkey.html', PASSKEY_PAGE);
    await withMcpContext(async (response, context, args) => {
      const page = context.getSelectedMcpPage().pptrPage;
      await page.goto(localhostRoute(server.getRoute('/passkey.html')));
      const id = authenticatorIdFrom(
        await run(context, response, {action: 'add_authenticator'}, args),
      );
      await page.evaluate(() =>
        // @ts-expect-error defined by the test page
        window.register(),
      );

      await run(
        context,
        response,
        {
          action: 'set_user_verified',
          authenticatorId: id,
          isUserVerified: false,
        },
        args,
      );
      const result = await page.evaluate(() =>
        // @ts-expect-error defined by the test page
        window.signIn(),
      );
      assert.strictEqual(result, 'NotAllowedError');
    });
  });

  it('clears credentials and removes the authenticator', async () => {
    server.addHtmlRoute('/passkey.html', PASSKEY_PAGE);
    await withMcpContext(async (response, context, args) => {
      const page = context.getSelectedMcpPage().pptrPage;
      await page.goto(localhostRoute(server.getRoute('/passkey.html')));
      const id = authenticatorIdFrom(
        await run(context, response, {action: 'add_authenticator'}, args),
      );
      await page.evaluate(() =>
        // @ts-expect-error defined by the test page
        window.register(),
      );

      await run(
        context,
        response,
        {action: 'clear_credentials', authenticatorId: id},
        args,
      );
      assert.deepStrictEqual(
        await run(
          context,
          response,
          {action: 'list_credentials', authenticatorId: id},
          args,
        ),
        [`No credentials stored in ${id}.`],
      );

      assert.deepStrictEqual(
        await run(context, response, {action: 'list_authenticators'}, args),
        ['Virtual authenticators:', `- ${id}`],
      );
      await run(
        context,
        response,
        {action: 'remove_authenticator', authenticatorId: id},
        args,
      );
      assert.deepStrictEqual(
        await run(context, response, {action: 'list_authenticators'}, args),
        ['No virtual authenticators on this page.'],
      );
    });
  });

  it('rejects an unknown authenticator id', async () => {
    await withMcpContext(async (response, context, args) => {
      await assert.rejects(
        run(
          context,
          response,
          {action: 'list_credentials', authenticatorId: 'nope'},
          args,
        ),
        /No virtual authenticator with id "nope"/,
      );
    });
  });
});
