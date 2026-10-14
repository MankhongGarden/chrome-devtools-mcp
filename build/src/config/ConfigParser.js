/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { yargs, hideBin } from '../third_party/index.js';
import { readFileSync } from 'node:fs';
import { mcpOptions, getMcpOptionsForViaCli, CLI_EXAMPLES, CONFLICTING_ARGS, IMPLICATIONS, DEFAULT_FILESYSTEM_ROOT, withoutDefaults, } from './mcp-options.js';
import { ConfigLocator } from './ConfigLocator.js';
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function getErrorMessage(err) {
    return err instanceof Error ? err.message : String(err);
}
function stripYargsPositionalArgs(parsed) {
    const copy = { ...parsed };
    delete copy._;
    delete copy.$0;
    return copy;
}
export class ConfigParser {
    version;
    argv;
    env;
    exitProcess;
    #configPath;
    configLocator;
    /**
     * @param configLocator Finds the config file when `--config` is not passed.
     * Config file discovery is off without it, for example in tests.
     */
    constructor(version, argv = process.argv, env = process.env, exitProcess = true) {
        this.version = version;
        this.argv = argv;
        this.env = env;
        this.exitProcess = exitProcess;
        this.configLocator = new ConfigLocator();
    }
    buildCliParser(options = mcpOptions) {
        const yargsInstance = yargs(hideBin(this.argv));
        return yargsInstance
            .scriptName('npx chrome-devtools-mcp@latest')
            .parserConfiguration({
            'strip-aliased': true,
            'strip-dashed': true,
        })
            .options(options)
            .showHelpOnFail(false, 'Specify --help for available options')
            .example(CLI_EXAMPLES)
            .wrap(Math.min(120, yargsInstance.terminalWidth()))
            .help()
            .version(this.version);
    }
    /**
     * Step 1: parses the CLI flags without applying defaults, so the result only
     * contains what the user passed. `--help` and `--version` print and exit the
     * process; parse errors throw.
     */
    parseCliArgs() {
        const parsed = this.buildCliParser(withoutDefaults(mcpOptions))
            .fail(false)
            .parseSync();
        return stripYargsPositionalArgs(parsed);
    }
    /**
     * Step 2: reads the JSON config file and runs it through yargs to reject
     * unknown keys and apply coercions, without applying defaults.
     */
    parseConfigFile(configPath) {
        try {
            const fileContent = JSON.parse(readFileSync(configPath, 'utf-8'));
            if (!isPlainObject(fileContent)) {
                throw new Error('Config must be a JSON object');
            }
            const parsed = yargs([])
                .parserConfiguration({
                'strip-aliased': true,
                'camel-case-expansion': false,
            })
                .options(withoutDefaults(mcpOptions))
                .config(fileContent)
                .strict()
                .fail(false)
                .exitProcess(false)
                .parseSync([]);
            return stripYargsPositionalArgs(parsed);
        }
        catch (err) {
            throw new Error(`Invalid JSON config file: ${getErrorMessage(err)}`);
        }
    }
    warnUnknownArgs(cliArgs) {
        const allowedArgs = new Set(Object.keys(mcpOptions));
        const unknownArgs = Object.keys(cliArgs).filter(arg => !allowedArgs.has(arg));
        if (unknownArgs.length > 0) {
            console.error(`Unknown arguments: ${unknownArgs.map(arg => `--${arg}`)}`);
        }
    }
    /**
     * Step 4: rejects mutually exclusive inputs. Only explicit inputs are checked,
     * so defaults never conflict.
     */
    validateConflicts(explicitArgs) {
        const activeArgs = new Set();
        for (const [key, val] of Object.entries(explicitArgs)) {
            if (val !== undefined && val !== false) {
                activeArgs.add(key);
            }
        }
        for (const group of CONFLICTING_ARGS) {
            const activeInGroup = group.filter(arg => activeArgs.has(arg));
            if (activeInGroup.length > 1) {
                const [arg1, arg2] = activeInGroup;
                throw new Error(`Arguments ${String(arg1)} and ${String(arg2)} are mutually exclusive`);
            }
        }
    }
    validateImplications(explicitArgs) {
        for (const [key, implied] of IMPLICATIONS) {
            const isKeySet = explicitArgs[key] !== undefined && explicitArgs[key] !== false;
            const isImpliedSet = explicitArgs[implied] !== undefined && explicitArgs[implied] !== false;
            if (isKeySet && !isImpliedSet) {
                throw new Error(`Implications failed:\n  ${String(key)} -> ${String(implied)}`);
            }
        }
    }
    /**
     * Step 5: fills in defaults for everything that was not set explicitly.
     * `viaCli` is an explicit input like any other; it selects which defaults
     * apply.
     */
    applyDefaults(explicitArgs) {
        const isViaCli = explicitArgs.viaCli === true;
        const baseOptions = isViaCli ? getMcpOptionsForViaCli() : mcpOptions;
        const resolvedArgs = { ...explicitArgs };
        // `channel` only applies when Chrome is launched by channel. Leaving it
        // unset otherwise keeps it out of telemetry (computeFlagUsage).
        const launchesByChannel = !resolvedArgs.browserUrl &&
            !resolvedArgs.wsEndpoint &&
            !resolvedArgs.executablePath;
        for (const [key, option] of Object.entries(baseOptions)) {
            if (key === 'channel' && !launchesByChannel) {
                continue;
            }
            if (resolvedArgs[key] === undefined &&
                'default' in option) {
                resolvedArgs[key] = option.default;
            }
        }
        if (isViaCli) {
            if (resolvedArgs.filesystemRoot === DEFAULT_FILESYSTEM_ROOT &&
                explicitArgs.allowUnrestrictedPaths !== false) {
                resolvedArgs.allowUnrestrictedPaths = true;
                resolvedArgs.filesystemRoot = undefined;
            }
            const connectsToExistingBrowser = resolvedArgs.autoConnect ||
                resolvedArgs.browserUrl ||
                resolvedArgs.wsEndpoint;
            if (explicitArgs.isolated === undefined &&
                resolvedArgs.userDataDir === undefined &&
                !connectsToExistingBrowser) {
                resolvedArgs.isolated = true;
            }
            if (resolvedArgs.categoryExtensions === undefined &&
                !connectsToExistingBrowser) {
                resolvedArgs.categoryExtensions = true;
            }
        }
        if (this.env['CI'] || this.env['CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS']) {
            console.error("turning off usage statistics. process.env['CI'] || process.env['CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS'] is set.");
            resolvedArgs.usageStatistics = false;
        }
        if (resolvedArgs.categoryExperimentalThirdParty === undefined &&
            this.env['CHROME_DEVTOOLS_MCP_CATEGORY_EXPERIMENTAL_THIRD_PARTY']) {
            resolvedArgs.categoryExperimentalThirdParty = true;
        }
        // The merge and the default loop lose the static type that yargs infers from
        // `mcpOptions`. Every value was produced by the same option definitions (CLI
        // parser, strict config-file parser, option defaults), so the shape matches.
        return resolvedArgs;
    }
    parse() {
        try {
            const cliArgs = this.parseCliArgs();
            this.#configPath = cliArgs.config ?? this.configLocator?.locate(this.env);
            this.warnUnknownArgs(cliArgs);
            return this.#resolve(cliArgs);
        }
        catch (error) {
            if (this.exitProcess) {
                console.error(getErrorMessage(error));
                process.exit(1);
            }
            throw error;
        }
    }
    /**
     * Re-reads the config file resolved by `parse()` and merges it with the CLI
     * arguments again. Unlike `parse()`, it does not discover a new config file
     * and throws on invalid configuration instead of exiting the process.
     */
    reload() {
        return this.#resolve(this.parseCliArgs());
    }
    #resolve(cliArgs) {
        const configPath = this.#configPath;
        const configFileArgs = configPath ? this.parseConfigFile(configPath) : {};
        // Step 3: merges the explicit inputs. The CLI wins over the config file.
        const explicitArgs = {
            ...configFileArgs,
            ...cliArgs,
            ...(configPath ? { config: configPath } : {}),
        };
        this.validateConflicts(explicitArgs);
        this.validateImplications(explicitArgs);
        return this.applyDefaults(explicitArgs);
    }
}
//# sourceMappingURL=ConfigParser.js.map