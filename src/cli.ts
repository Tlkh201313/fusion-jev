#!/usr/bin/env node
import { dirname } from 'node:path';
import { assertEnvFileArgs, assertSetupArgs, splitProviderEnv } from './cli/args.js';
import { builtCliPath, type CliContext } from './cli/context.js';
import { HELP } from './cli/help.js';

// Only this dispatcher loads eagerly. Each command's modules load on demand so that
// `fusion-jev run` and `fusion-jev evidence` do not pay for the MCP SDK, zod, ajv or jose.
const context: CliContext = { selfUrl: import.meta.url };

async function main(): Promise<void> {
  if (process.argv[2] === 'run') {
    await (await import('./cli/run-command.js')).runCli(process.argv.slice(3), context);
    return;
  }
  if (process.argv[2] === 'evidence') {
    await (await import('./cli/evidence-command.js')).evidenceCli(process.argv.slice(3));
    return;
  }
  const commands = await import('./cli/config-command.js');
  const [config, { prepareSetup }] = await Promise.all([commands.loadConfigModules(), import('./setup.js')]);
  const { args, providerEnv } = splitProviderEnv(process.argv.slice(2));
  if (args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
    process.stdout.write(HELP);
    return;
  }
  if (args[0] === 'setup') {
    assertSetupArgs(args);
    const result = prepareSetup({
      configDir: dirname(commands.userConfigPath(config)),
      envFile: providerEnv,
      executable: process.execPath,
      cliPath: builtCliPath(context),
      dryRun: args.includes('--dry-run'),
    });
    process.stdout.write(result.instructions);
    return;
  }
  if (args[0] === 'config' && args[1] === 'env-file') {
    assertEnvFileArgs(args, providerEnv);
    commands.configureEnvFile(args[2], config);
    return;
  }
  commands.loadProviderEnvFile(providerEnv, config);
  await (await import('./cli/serve.js')).serveCli(args);
}

main().catch((error) => {
  // Configuration diagnostics use static messages; provider bodies never reach stderr.
  process.stderr.write(`Fusion: ${error instanceof Error ? error.message : 'startup failed'}\n`);
  process.exitCode = 1;
});
