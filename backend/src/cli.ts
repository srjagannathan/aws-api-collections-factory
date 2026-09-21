#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { join } from 'node:path';

import { exportServiceCatalog } from './catalog-export.js';
import {
  repositoryOptionsFromEnvironment,
  resolveInputPath,
  runtimePaths,
  validateRepositoryOptions,
} from './config.js';
import { resolveModelsRepository } from './model-source.js';
import {
  applyAdoption,
  checkPipeline,
  initializeApplicationState,
  proposeAdoption,
  reconcileCollections,
  refreshPipeline,
  type PipelineContext,
} from './pipeline.js';
import type { JsonMap, RepositoryOptions } from './types.js';
import { ApplicationError, consoleLogger, stderrLogger } from './types.js';

const HELP = `aws-api-collections-factory

Usage:
  apisync [repository options] check [--json]
  apisync [repository options] catalog [--json]
  apisync init [--json]
  apisync [repository options] refresh [--all | --service a,b] [options]
  apisync adopt --workspace NAME_OR_ID [--yes]
  apisync reconcile [--json]

Repository options:
  --models-dir PATH       Existing api-models-aws checkout
  --models-url URL        Clone URL for the managed model cache
  --source-remote NAME    Remote supplying AWS models (default: origin)
  --source-branch NAME    Source branch (default: main)
  --local-branch NAME     Local synchronization branch (default: main)
  --mirror-remote NAME    Optional remote receiving the synchronized branch
  --mirror-branch NAME    Optional mirror branch (default: local branch)

Refresh options:
  --all                   Refresh every tracked service
  --service a,b           Refresh selected tracked services
  --dry-run               Convert without Git, Postman, artifact, or state writes
  --keep-cors             Keep generated Cors operations
  --discard-local         Delete local changes under models/
  --create-missing        Create unmapped Postman collections
  --keep-staging          Preserve temporary conversion files
  --json                  Emit machine-readable JSON
`;

function printTable(headers: string[], rows: Array<Array<string | number>>): void {
  const widths = headers.map((header, index) => Math.max(
    header.length,
    ...rows.map((row) => String(row[index] ?? '').length),
  ));
  const render = (row: Array<string | number>) => row
    .map((cell, index) => String(cell).padEnd(widths[index]!))
    .join(' | ');
  console.log(render(headers));
  console.log(widths.map((width) => '-'.repeat(width)).join('-+-'));
  for (const row of rows) {
    console.log(render(row));
  }
}

function repositoryOptions(values: Record<string, unknown>): RepositoryOptions {
  const defaults = repositoryOptionsFromEnvironment();
  const options: RepositoryOptions = {
    modelsDir: typeof values['models-dir'] === 'string'
      ? resolveInputPath(values['models-dir'])
      : defaults.modelsDir,
    modelsUrl: String(values['models-url'] || defaults.modelsUrl),
    sourceRemote: String(values['source-remote'] || defaults.sourceRemote),
    sourceBranch: String(values['source-branch'] || defaults.sourceBranch),
    localBranch: String(values['local-branch'] || defaults.localBranch),
    mirrorRemote: typeof values['mirror-remote'] === 'string'
      ? values['mirror-remote']
      : defaults.mirrorRemote,
    mirrorBranch: String(values['mirror-branch'] || defaults.mirrorBranch),
  };
  if (!values['mirror-branch'] && !process.env.APISYNC_MIRROR_BRANCH) {
    options.mirrorBranch = options.localBranch;
  }
  validateRepositoryOptions(options);
  return options;
}

function renderCheck(report: JsonMap): void {
  if (!report.initialized) {
    console.log(report.message);
    return;
  }
  console.log(`Source commits pending: ${report.source_commits_pending}`);
  console.log(`Local sync pending:     ${report.local_sync_pending}`);
  console.log(`Mirror remote:          ${report.mirror_remote || 'disabled'}`);
  console.log('');
  if (report.changed_tracked.length === 0) {
    console.log('No tracked services changed.');
  } else {
    printTable(
      ['service', 'operations', 'names'],
      report.changed_tracked.map((entry: JsonMap) => {
        const names = [
          ...entry.ops_added.map((name: string) => `+${name}`),
          ...entry.ops_removed.map((name: string) => `-${name}`),
        ];
        return [
          entry.service,
          `+${entry.ops_added.length}/-${entry.ops_removed.length}`,
          names.length > 6 ? `${names.slice(0, 6).join(', ')}, ...` : names.join(', '),
        ];
      }),
    );
  }
  if (report.untracked_changed) {
    console.log(`Untracked services changed: ${report.untracked_changed}`);
  }
}

function renderRefresh(outcome: { report: JsonMap; reportPath: string }): void {
  const services = outcome.report.services || {};
  const rows = Object.keys(services).sort().map((service) => {
    const result = services[service];
    return [
      service,
      result.lane || '-',
      result.requests ?? '-',
      `+${result.ops_added.length}/-${result.ops_removed.length}`,
      `${result.status}${result.error ? ` (${result.error})` : ''}`,
    ];
  });
  if (rows.length === 0) {
    console.log('Up to date.');
  } else {
    printTable(['service', 'lane', 'requests', 'ops +/-', 'status'], rows);
  }
  console.log(`Report: ${outcome.reportPath}`);
}

async function confirmAdoption(): Promise<boolean> {
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await readline.question('Merge this mapping into postman-map.json? [y/N] '))
      .trim()
      .toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    readline.close();
  }
}

async function main(argv = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      json: { type: 'boolean' },
      'models-dir': { type: 'string' },
      'models-url': { type: 'string' },
      'source-remote': { type: 'string' },
      'source-branch': { type: 'string' },
      'local-branch': { type: 'string' },
      'mirror-remote': { type: 'string' },
      'mirror-branch': { type: 'string' },
      all: { type: 'boolean' },
      service: { type: 'string' },
      'dry-run': { type: 'boolean' },
      'keep-cors': { type: 'boolean' },
      'discard-local': { type: 'boolean' },
      'create-missing': { type: 'boolean' },
      'keep-staging': { type: 'boolean' },
      workspace: { type: 'string' },
      yes: { type: 'boolean' },
    },
  });
  if (parsed.values.help || parsed.positionals.length === 0) {
    console.log(HELP);
    return 0;
  }
  if (parsed.positionals.length !== 1) {
    throw new ApplicationError(`Unexpected positional arguments: ${parsed.positionals.slice(1).join(' ')}`);
  }
  const command = parsed.positionals[0]!;
  if (!['init', 'check', 'catalog', 'refresh', 'adopt', 'reconcile'].includes(command)) {
    throw new ApplicationError(`Unknown command '${command}'.\n\n${HELP}`);
  }
  const context: PipelineContext = {
    repository: repositoryOptions(parsed.values),
    paths: runtimePaths(),
    logger: parsed.values.json ? stderrLogger : consoleLogger,
  };

  if (command === 'init') {
    const report = await initializeApplicationState(context.paths);
    if (parsed.values.json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`Application home: ${report.application_home}`);
      console.log(report.created.length > 0
        ? `Created: ${report.created.join(', ')}`
        : 'Configuration already exists. No files were replaced.');
    }
    return 0;
  }

  if (command === 'check') {
    const report = await checkPipeline(context);
    if (parsed.values.json) console.log(JSON.stringify(report, null, 2));
    else renderCheck(report);
    return 0;
  }
  if (command === 'catalog') {
    const modelsRepository = await resolveModelsRepository(
      context.repository,
      context.paths,
      context.logger,
    );
    const output = join(context.paths.applicationHome, 'service-catalog.json');
    const count = await exportServiceCatalog(join(modelsRepository, 'models'), output);
    if (parsed.values.json) console.log(JSON.stringify({ services: count, output }, null, 2));
    else console.log(`Exported ${count} services to ${output}`);
    return 0;
  }
  if (command === 'refresh') {
    const selected = typeof parsed.values.service === 'string'
      ? parsed.values.service.split(',').map((value) => value.trim()).filter(Boolean)
      : undefined;
    if (parsed.values.all && selected?.length) {
      throw new ApplicationError('--all and --service cannot be used together.');
    }
    const outcome = await refreshPipeline(context, {
      all: Boolean(parsed.values.all),
      services: selected,
      dryRun: Boolean(parsed.values['dry-run']),
      keepCors: Boolean(parsed.values['keep-cors']),
      discardLocal: Boolean(parsed.values['discard-local']),
      createMissing: Boolean(parsed.values['create-missing']),
      keepStaging: Boolean(parsed.values['keep-staging']),
    });
    if (parsed.values.json) console.log(JSON.stringify(outcome.report, null, 2));
    else renderRefresh(outcome);
    return outcome.exitCode;
  }
  if (command === 'adopt') {
    if (typeof parsed.values.workspace !== 'string' || !parsed.values.workspace.trim()) {
      throw new ApplicationError('adopt requires --workspace NAME_OR_ID.');
    }
    const summary = await proposeAdoption(context, parsed.values.workspace);
    console.log(`Workspace: ${summary.workspace.name} (${summary.workspace.id})`);
    if (Object.keys(summary.proposed).length > 0) {
      printTable(
        ['service', 'collection', 'uid'],
        Object.entries(summary.proposed).map(([service, collection]) => [
          service,
          (collection as JsonMap).name || '',
          (collection as JsonMap).uid || '',
        ]),
      );
    } else {
      console.log('No collection names matched tracked services.');
    }
    if (!parsed.values.yes && !(await confirmAdoption())) {
      console.log('No mapping was written.');
      return 1;
    }
    const result = await applyAdoption(context, summary);
    console.log(`Mapping updated: ${result.added} added, ${result.retained} retained.`);
    return 0;
  }

  const report = await reconcileCollections(context);
  if (parsed.values.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printTable(
      ['service', 'uid', 'status'],
      report.services.map((entry: JsonMap) => [entry.service, entry.uid || '-', entry.status]),
    );
    if (report.unmapped_collections.length > 0) {
      console.log('Unmapped workspace collections:');
      for (const collection of report.unmapped_collections) {
        console.log(`  ${collection.name} (${collection.uid || collection.id})`);
      }
    }
  }
  return 0;
}

main().then(
  (code) => { process.exitCode = code; },
  (error) => {
    const exitCode = error instanceof ApplicationError ? error.exitCode : 1;
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = exitCode;
  },
);
