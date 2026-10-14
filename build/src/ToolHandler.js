/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
var __addDisposableResource = (this && this.__addDisposableResource) || function (env, value, async) {
    if (value !== null && value !== void 0) {
        if (typeof value !== "object" && typeof value !== "function") throw new TypeError("Object expected.");
        var dispose, inner;
        if (async) {
            if (!Symbol.asyncDispose) throw new TypeError("Symbol.asyncDispose is not defined.");
            dispose = value[Symbol.asyncDispose];
        }
        if (dispose === void 0) {
            if (!Symbol.dispose) throw new TypeError("Symbol.dispose is not defined.");
            dispose = value[Symbol.dispose];
            if (async) inner = dispose;
        }
        if (typeof dispose !== "function") throw new TypeError("Object not disposable.");
        if (inner) dispose = function() { try { inner.call(this); } catch (e) { return Promise.reject(e); } };
        env.stack.push({ value: value, dispose: dispose, async: async });
    }
    else if (async) {
        env.stack.push({ async: true });
    }
    return value;
};
var __disposeResources = (this && this.__disposeResources) || (function (SuppressedError) {
    return function (env) {
        function fail(e) {
            env.error = env.hasError ? new SuppressedError(e, env.error, "An error was suppressed during disposal.") : e;
            env.hasError = true;
        }
        var r, s = 0;
        function next() {
            while (r = env.stack.pop()) {
                try {
                    if (!r.async && s === 1) return s = 0, env.stack.push(r), Promise.resolve().then(next);
                    if (r.dispose) {
                        var result = r.dispose.call(r.value);
                        if (r.async) return s |= 2, Promise.resolve(result).then(next, function(e) { fail(e); return next(); });
                    }
                    else s |= 1;
                }
                catch (e) {
                    fail(e);
                }
            }
            if (s === 1) return env.hasError ? Promise.reject(env.error) : Promise.resolve();
            if (env.hasError) throw env.error;
        }
        return next();
    };
})(typeof SuppressedError === "function" ? SuppressedError : function (error, suppressed, message) {
    var e = new Error(message);
    return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
});
import { McpResponse } from './McpResponse.js';
import { SlimMcpResponse } from './SlimMcpResponse.js';
import { ClearcutLogger } from './telemetry/ClearcutLogger.js';
import { zod } from './third_party/index.js';
import { labels } from './tools/categories.js';
import { categoryToFlagName } from './config/category-options.js';
import { isAvailableInMode, isSlimTool } from './tools/ToolDefinition.js';
import { logger } from './utils/logger.js';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isLocalhost } from './utils/url.js';
/**
 * Upper bound on how long a single tool call may wait on the browser
 * connection. Puppeteer normally rejects in-flight CDP calls when the
 * underlying transport closes, but a transport that dies silently (e.g. an
 * adb port-forward torn down mid-call, rather than closed cleanly) never
 * fires `close`/`error`/`disconnected`, so the call would otherwise hang
 * until an external (client-side) timeout gives up on the whole server. This
 * bound turns that into a fast, clear error instead, and forgets the cached
 * browser handle so the next call reconnects rather than reusing a handle
 * that still looks connected.
 */
export const TOOL_CALL_TIMEOUT_MS = 60_000;
class ToolCallTimeoutError extends Error {
}
function buildDisabledMessage(toolName, flag, categoryLabel) {
    const reason = categoryLabel
        ? `is in category ${categoryLabel} which`
        : `requires ${flag.startsWith('--experimental') ? 'experimental feature' : 'flag'} ${flag} and`;
    return `Tool ${toolName} ${reason} is currently disabled. Enable it by running chrome-devtools start ${flag}=true. For more information check the README.`;
}
function getToolStatusInfo(tool, serverArgs) {
    if (!isAvailableInMode(tool, serverArgs)) {
        return {
            disabled: true,
            unavailableInMode: true,
            reason: isSlimTool(tool)
                ? `Tool ${tool.name} is only available with --slim.`
                : `Tool ${tool.name} is not available with --slim.`,
        };
    }
    const category = tool.annotations.category;
    if (category) {
        const flag = categoryToFlagName(category);
        if (!serverArgs[flag]) {
            return {
                disabled: true,
                reason: buildDisabledMessage(tool.name, `--${flag}`, labels[category]),
            };
        }
    }
    for (const condition of tool.annotations.conditions || []) {
        if (!serverArgs[condition]) {
            return {
                disabled: true,
                reason: buildDisabledMessage(tool.name, `--${condition}`),
            };
        }
    }
    return { disabled: false };
}
function isPageScopedTool(tool) {
    return 'pageScoped' in tool && tool.pageScoped === true;
}
async function validateAndResolvePathOrUrl(filePathOrUrl, context) {
    if (filePathOrUrl.trim().length === 0) {
        return undefined;
    }
    try {
        const url = new URL(filePathOrUrl);
        if (url.protocol === 'file:') {
            return pathToFileURL(await context.validatePath(fileURLToPath(url))).href;
        }
        if (['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
            return filePathOrUrl;
        }
    }
    catch {
        // Suppress parsing errors for regular file paths.
    }
    return await context.validatePath(filePathOrUrl);
}
function isLocalBrowser(context) {
    if (context.browser.process()) {
        return true;
    }
    const wsEndpoint = context.browser.wsEndpoint();
    if (wsEndpoint && isLocalhost(wsEndpoint)) {
        return true;
    }
    return false;
}
function shouldValidateFile(option, isLocal) {
    if (option === true) {
        return true;
    }
    if (typeof option === 'object' && option !== null) {
        if (isLocal) {
            return Boolean(option.local);
        }
        return Boolean(option.remote);
    }
    return false;
}
async function validateToolFiles(tool, params, context) {
    const isLocal = isLocalBrowser(context);
    for (const [key, option] of Object.entries(tool.verifyFilesSchema)) {
        if (shouldValidateFile(option, isLocal)) {
            const val = params[key];
            if (typeof val === 'string') {
                params[key] = await validateAndResolvePathOrUrl(val, context);
            }
            else if (Array.isArray(val)) {
                const updated = [];
                for (const item of val) {
                    if (typeof item === 'string') {
                        const resolved = await validateAndResolvePathOrUrl(item, context);
                        if (resolved !== undefined) {
                            updated.push(resolved);
                        }
                    }
                    else {
                        throw new Error('Unexpected non-string value as a file path or URL');
                    }
                }
                params[key] = updated;
            }
        }
    }
}
export class ToolHandler {
    tool;
    serverArgs;
    getContext;
    toolMutex;
    forgetBrowserOnTimeout;
    abandonPendingBrowserAttemptOnTimeout;
    inputSchema;
    registeredInputSchema;
    disabled;
    disabledReason;
    constructor(tool, serverArgs, getContext, toolMutex, forgetBrowserOnTimeout, abandonPendingBrowserAttemptOnTimeout) {
        this.tool = tool;
        this.serverArgs = serverArgs;
        this.getContext = getContext;
        this.toolMutex = toolMutex;
        this.forgetBrowserOnTimeout = forgetBrowserOnTimeout;
        this.abandonPendingBrowserAttemptOnTimeout = abandonPendingBrowserAttemptOnTimeout;
        const { disabled, reason, unavailableInMode } = getToolStatusInfo(tool, serverArgs);
        this.disabledReason = reason;
        this.disabled =
            disabled && (Boolean(unavailableInMode) || !serverArgs.viaCli);
        this.inputSchema = tool.schema;
        this.registeredInputSchema = zod.object(this.inputSchema).strict();
    }
    /**
     * Races a promise against TOOL_CALL_TIMEOUT_MS, calling onTimeout() if the
     * timer wins. The loser of the race is left running — there is no way to
     * cancel a pending Puppeteer call — but since nothing is left awaiting it,
     * it cannot block subsequent tool calls.
     */
    async #raceWithTimeout(promise, onTimeout) {
        const timeoutError = new ToolCallTimeoutError(`Tool "${this.tool.name}" timed out after ${TOOL_CALL_TIMEOUT_MS}ms waiting on the browser connection. The connection may have been lost (for example, the debugged browser or app restarted). It will be re-established automatically on the next tool call.`);
        let timer;
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => reject(timeoutError), TOOL_CALL_TIMEOUT_MS);
            timer.unref?.();
        });
        try {
            return await Promise.race([promise, timeout]);
        }
        catch (err) {
            if (err === timeoutError) {
                onTimeout();
            }
            throw err;
        }
        finally {
            clearTimeout(timer);
        }
    }
    handle = async (params) => {
        const env_1 = { stack: [], error: void 0, hasError: false };
        try {
            const guard = __addDisposableResource(env_1, await this.toolMutex.acquire(), false);
            if (this.disabledReason) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: this.disabledReason,
                        },
                    ],
                    isError: true,
                };
            }
            const startTime = Date.now();
            let success = false;
            let devToolsData;
            let pageUrl;
            try {
                logger?.(`${this.tool.name} request: ${JSON.stringify(params, null, '  ')}`);
                // ensureBrowser() has no cancellation mechanism, so this timeout only
                // stops us from waiting — the attempt itself keeps running abandoned.
                // abandonPendingBrowserAttemptOnTimeout() tells BrowserManager to
                // discard that attempt if it succeeds later instead of handing it to a
                // subsequent caller — see BrowserManager#abandonPendingAttempt()'s doc
                // comment for the full mechanism.
                const context = await this.#raceWithTimeout(this.getContext(), () => this.abandonPendingBrowserAttemptOnTimeout());
                logger?.(`${this.tool.name} context: resolved`);
                const response = this.serverArgs.slim
                    ? new SlimMcpResponse(this.serverArgs)
                    : new McpResponse(this.serverArgs);
                response.setRedactNetworkHeaders(this.serverArgs.redactNetworkHeaders);
                if (context.consumeReconnectNotice()) {
                    response.setReconnectNotice();
                }
                // Shares one budget with tool.handler(): several tools' actual CDP
                // calls happen in response.handle() instead (take_snapshot,
                // list_pages, get_network_request, list_extensions), so it needs
                // covering too. The closure below isn't cancelled on timeout — it
                // keeps running abandoned — but nothing after this point observes its
                // result.
                const { content, structuredContent } = await this.#raceWithTimeout((async () => {
                    let page;
                    try {
                        await validateToolFiles(this.tool, params, context);
                        if (isPageScopedTool(this.tool)) {
                            const pageId = typeof params.pageId === 'number' ? params.pageId : undefined;
                            page =
                                this.serverArgs.pageIdRouting &&
                                    pageId !== undefined &&
                                    !isSlimTool(this.tool)
                                    ? context.getPageById(pageId)
                                    : context.getSelectedMcpPage();
                            await page?.init();
                            response.setPage(page);
                            if (this.tool.blockedByDialog) {
                                page.throwIfDialogOpen();
                            }
                            await this.tool.handler({
                                params,
                                page,
                            }, response, context);
                        }
                        else {
                            await this.tool.handler({
                                params,
                            }, response, context);
                        }
                    }
                    catch (err) {
                        response.setError(err);
                    }
                    devToolsData = await context.getDevToolsData(page);
                    pageUrl = context.getSelectedMcpPageUrl(page);
                    // --experimentalDataFormat takes precedence over the legacy
                    // --experimentalToonFormat.
                    const dataFormat = this.serverArgs.experimentalDataFormat ??
                        (this.serverArgs.experimentalToonFormat ? 'toon' : 'default');
                    return await response.handle(context, dataFormat);
                })(), () => this.forgetBrowserOnTimeout(context.browser));
                const result = {
                    content,
                };
                if (response.error) {
                    result.isError = true;
                }
                success = true;
                if (this.serverArgs.experimentalStructuredContent) {
                    result.structuredContent = structuredContent;
                }
                return result;
            }
            catch (err) {
                logger?.(`${this.tool.name} error:`, err, err?.stack);
                let errorText = err && 'message' in err ? err.message : String(err);
                if ('cause' in err && err.cause) {
                    errorText += `\nCause: ${err.cause.message}`;
                }
                return {
                    content: [
                        {
                            type: 'text',
                            text: errorText,
                        },
                    ],
                    isError: true,
                };
            }
            finally {
                void ClearcutLogger.get()?.logToolInvocation({
                    toolName: this.tool.name,
                    params,
                    schema: this.inputSchema,
                    success,
                    latencyMs: Date.now() - startTime,
                    devToolsData,
                    pageUrl,
                });
            }
        }
        catch (e_1) {
            env_1.error = e_1;
            env_1.hasError = true;
        }
        finally {
            __disposeResources(env_1);
        }
    };
}
//# sourceMappingURL=ToolHandler.js.map