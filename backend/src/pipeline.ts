// SPDX-License-Identifier: Apache-2.0

import { access, copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import {
  filterCorsOperations,
  normalizeCollectionName,
  specificationOperationIds,
} from './collection-utils.js';
import { readJson, writeJsonAtomic } from './json-store.js';
import {
  changedServices,
  enforceHistoryAnchor,
  fetchSource,
  git,
  isAncestor,
  operationsAt,
  resolveModelsRepository,
  routeConverter,
  sourceRef,
  syncModelsRepository,
} from './model-source.js';
import { knownOutputIds, resolveEnabledConverters } from './outputs/registry.js';
import type { ComposedConverter, OutputConverter, Scenario } from './outputs/types.js';
import {
  PostmanClient,
  postmanApiKey,
  uidIdPortion,
} from './postman-client.js';
import { runProcess } from './process.js';
import { convertQueryServices } from './query-converter.js';
import { nowIso, nowStamp } from './time.js';
import type { JsonMap, Logger, RepositoryOptions, RuntimePaths } from './types.js';
import { ApplicationError } from './types.js';

const FULL_SUCCESS = new Set(['updated', 'created', 'skipped-unchanged']);

export interface PipelineContext {
  repository: RepositoryOptions;
  paths: RuntimePaths;
  logger: Logger;
}

export interface RefreshOptions {
  all?: boolean;
  services?: string[];
  dryRun?: boolean;
  keepCors?: boolean;
  discardLocal?: boolean;
  createMissing?: boolean;
  keepStaging?: boolean;
  // For composed outputs (e.g. interaction-poc) whose scenarios reference
  // services outside this run's targets: 'current' (default) converts those
  // services fresh in this run too; 'last-used' reuses whatever spec was
  // persisted from the last successful non-dry-run refresh instead.
  scenarioSpecs?: 'current' | 'last-used';
}

export interface PipelineOutcome {
  report: JsonMap;
  reportPath: string;
  exitCode: number;
}

export async function initializeApplicationState(paths: RuntimePaths): Promise<JsonMap> {
  await mkdir(paths.applicationHome, { recursive: true });
  const created: string[] = [];
  for (const [exampleName, destination] of [
    ['services.example.json', paths.servicesConfig],
    ['postman.example.json', paths.postmanConfig],
    ['outputs.example.json', paths.outputsConfig],
  ] as const) {
    try {
      await access(destination, constants.F_OK);
    } catch {
      const source = join(paths.repositoryRoot, 'config', exampleName);
      const value = JSON.parse(await readFile(source, 'utf8')) as JsonMap;
      await writeJsonAtomic(destination, value);
      created.push(destination);
    }
  }
  return { application_home: paths.applicationHome, created };
}

function sortedDifference(left: Iterable<string>, right: Iterable<string>): string[] {
  const other = new Set(right);
  return [...new Set(left)].filter((item) => !other.has(item)).sort();
}

function sourceAnchor(syncState: JsonMap): string | undefined {
  return syncState.last_source_commit || syncState.last_upstream_commit;
}

export async function loadTrackedServices(paths: RuntimePaths): Promise<string[]> {
  const config = await readJson<JsonMap>(paths.servicesConfig, {});
  if (!Array.isArray(config.tracked) || config.tracked.length === 0) {
    throw new ApplicationError(
      `Tracked services are missing. Initialize ${paths.servicesConfig} from config/services.example.json.`,
    );
  }
  const values = config.tracked.filter((value: unknown): value is string => typeof value === 'string');
  if (values.length !== config.tracked.length) {
    throw new ApplicationError(`${paths.servicesConfig} must contain only string service identifiers.`);
  }
  return [...new Set(values)].sort();
}

export async function checkPipeline(context: PipelineContext): Promise<JsonMap> {
  const { repository, paths, logger } = context;
  const tracked = new Set(await loadTrackedServices(paths));
  const modelsRepository = await resolveModelsRepository(repository, paths, logger);
  const source = sourceRef(repository);
  await fetchSource(modelsRepository, repository, logger, false);

  const syncState = await readJson<JsonMap>(join(paths.applicationHome, 'sync-state.json'), {});
  const anchor = sourceAnchor(syncState);
  if (!anchor) {
    return {
      initialized: false,
      message: 'No synchronization state exists. Run refresh --all.',
      source_ref: source,
      mirror_remote: repository.mirrorRemote || null,
      changed_tracked: [],
      untracked_changed: 0,
    };
  }
  await enforceHistoryAnchor(modelsRepository, anchor, source);

  const sourceHead = (await git(modelsRepository, ['rev-parse', source])).stdout.trim();
  const pending = Number.parseInt((await git(modelsRepository, [
    'rev-list', '--count', `${anchor}..${source}`,
  ])).stdout.trim(), 10);
  const localPending = Number.parseInt((await git(modelsRepository, [
    'rev-list', '--count', `${repository.localBranch}..${source}`,
  ])).stdout.trim(), 10);
  const changed = await changedServices(modelsRepository, anchor, source);
  const changedTracked = [...changed].filter((service) => tracked.has(service)).sort();
  const details = await Promise.all(changedTracked.map(async (service) => {
    const before = await operationsAt(modelsRepository, anchor, service);
    const after = await operationsAt(modelsRepository, source, service);
    return {
      service,
      ops_added: sortedDifference(after, before),
      ops_removed: sortedDifference(before, after),
    };
  }));
  return {
    initialized: true,
    anchor,
    source_ref: source,
    source_head: sourceHead,
    source_commits_pending: pending,
    local_sync_pending: localPending,
    mirror_remote: repository.mirrorRemote || null,
    changed_tracked: details,
    untracked_changed: [...changed].filter((service) => !tracked.has(service)).length,
  };
}

// Checks that don't need the AWS models repository, so callers can run them
// before paying for a clone (the repository may not exist locally yet).
async function assertRefreshEnvironment(
  context: PipelineContext,
  options: RefreshOptions,
): Promise<{ apiKey: string | undefined; outputConverter: OutputConverter; composedConverters: ComposedConverter[] }> {
  const { paths } = context;
  try {
    await access(paths.javaLauncher, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
  } catch {
    throw new ApplicationError(
      `The Java converter is missing: ${paths.javaLauncher}\nRun ./gradlew installDist.`,
    );
  }
  try {
    await access(join(paths.postmanConverterDirectory, 'node_modules'), constants.F_OK);
  } catch {
    throw new ApplicationError('Postman converter dependencies are missing. Run npm install in scripts/.');
  }
  const { perService, composed, unknownIds } = await resolveEnabledConverters(paths);
  if (unknownIds.length > 0) {
    throw new ApplicationError(
      `Unknown output converter(s) in ${paths.outputsConfig}: ${unknownIds.join(', ')}. `
      + `Known: ${knownOutputIds().join(', ')}.`,
    );
  }
  if (perService.length !== 1) {
    // Only one per-service output type (Postman) is implemented so far, so
    // exactly one must resolve. This becomes a real choice once a second
    // per-service type exists; composed outputs (e.g. interaction-poc) are
    // separate and may be zero or more regardless of this constraint.
    throw new ApplicationError(
      `Exactly one per-service output converter must be enabled in ${paths.outputsConfig}. `
      + `Enabled: ${perService.length ? perService.map((converter) => converter.id).join(', ') : '(none)'}.`,
    );
  }
  const apiKey = options.dryRun ? undefined : postmanApiKey();
  return { apiKey, outputConverter: perService[0]!, composedConverters: composed };
}

async function assertRepositoryClean(
  modelsRepository: string,
  options: RefreshOptions,
  logger: Logger,
): Promise<void> {
  const probe = await git(modelsRepository, ['rev-parse', '--is-inside-work-tree'], { check: false });
  if (probe.exitCode !== 0 || probe.stdout.trim() !== 'true') {
    throw new ApplicationError(`The models repository is not a Git worktree: ${modelsRepository}`);
  }
  const dirty = (await git(modelsRepository, ['status', '--porcelain', '--', 'models/'])).stdout.trim();
  if (dirty) {
    if (!options.discardLocal) {
      throw new ApplicationError(
        `The models directory contains local changes:\n${dirty}\nUse --discard-local only when those changes may be deleted.`,
      );
    }
    await git(modelsRepository, ['checkout', '--', 'models/']);
    logger.warn('Discarded local changes under models/.');
  }
}

async function resolveTargets(
  context: PipelineContext,
  modelsRepository: string,
  tracked: string[],
  anchor: string | undefined,
  source: string,
  options: RefreshOptions,
): Promise<string[]> {
  if (options.services?.length) {
    const requested = [...new Set(options.services)].sort();
    const unknown = requested.filter((service) => !tracked.includes(service));
    if (unknown.length > 0) {
      throw new ApplicationError(`Unknown tracked services: ${unknown.join(', ')}`);
    }
    return requested;
  }
  if (options.all || !anchor) {
    return tracked;
  }
  const changed = await changedServices(modelsRepository, anchor, source);
  return tracked.filter((service) => changed.has(service));
}

interface ConversionLanes {
  lanes: Map<string, 'java' | 'typescript'>;
  failures: Map<string, string>;
}

async function runConversionLanes(
  context: PipelineContext,
  modelsRoot: string,
  targets: string[],
  stagingOpenApi: string,
): Promise<ConversionLanes> {
  const lanes = new Map<string, 'java' | 'typescript'>();
  const failures = new Map<string, string>();
  for (const service of targets) {
    const lane = await routeConverter(modelsRoot, service);
    if (lane) {
      lanes.set(service, lane);
    } else {
      failures.set(service, 'The service model could not be located or routed.');
    }
  }

  const javaServices = [...lanes.entries()]
    .filter(([, lane]) => lane === 'java')
    .map(([service]) => service)
    .sort();
  if (javaServices.length > 0) {
    const result = await runProcess(context.paths.javaLauncher, [
      modelsRoot,
      '-o', stagingOpenApi,
      '-s', javaServices.join(','),
    ], { cwd: context.paths.repositoryRoot, logger: context.logger });
    if (result.exitCode !== 0) {
      context.logger.warn(`The Java conversion lane exited with status ${result.exitCode}.`);
    }
  }

  const typeScriptServices = [...lanes.entries()]
    .filter(([, lane]) => lane === 'typescript')
    .map(([service]) => service)
    .sort();
  const typeScriptFailures = await convertQueryServices(
    modelsRoot,
    typeScriptServices,
    stagingOpenApi,
    context.logger,
  );
  for (const [service, error] of typeScriptFailures) {
    failures.set(service, error.message);
  }
  return { lanes, failures };
}

async function writeReport(paths: RuntimePaths, report: JsonMap, dryRun: boolean): Promise<string> {
  const suffix = dryRun ? '-dryrun' : '';
  const path = join(paths.reports, `refresh-${nowStamp()}${suffix}.json`);
  await writeJsonAtomic(path, report);
  return path;
}

export async function refreshPipeline(
  context: PipelineContext,
  options: RefreshOptions,
): Promise<PipelineOutcome> {
  const { repository, paths, logger } = context;
  const tracked = await loadTrackedServices(paths);
  const { apiKey, outputConverter, composedConverters } = await assertRefreshEnvironment(context, options);
  const modelsRepository = await resolveModelsRepository(repository, paths, logger);
  const modelsRoot = join(modelsRepository, 'models');
  const source = sourceRef(repository);
  await assertRepositoryClean(modelsRepository, options, logger);
  await fetchSource(modelsRepository, repository, logger, true);

  const syncStatePath = join(paths.applicationHome, 'sync-state.json');
  const syncState = await readJson<JsonMap>(syncStatePath, {});
  const anchor = sourceAnchor(syncState);
  if (anchor) {
    await enforceHistoryAnchor(modelsRepository, anchor, source);
  }
  const sourceHead = (await git(modelsRepository, ['rev-parse', source])).stdout.trim();
  const targets = await resolveTargets(
    context,
    modelsRepository,
    tracked,
    anchor,
    source,
    options,
  );

  const scenariosByConverter = new Map<string, Scenario[]>();
  for (const converter of composedConverters) {
    scenariosByConverter.set(converter.id, await converter.loadScenarios(paths));
  }
  const scenarioSpecsMode = options.scenarioSpecs || 'current';
  const scenarioRequiredServices = new Set<string>();
  for (const converter of composedConverters) {
    for (const service of converter.requiredServices(scenariosByConverter.get(converter.id)!)) {
      scenarioRequiredServices.add(service);
    }
  }
  const stagingTargets = scenarioSpecsMode === 'current'
    ? [...new Set([...targets, ...scenarioRequiredServices])].sort()
    : targets;

  let mirrorPushed: boolean | null = null;
  if (options.dryRun) {
    if (!(await isAncestor(modelsRepository, source, repository.localBranch))) {
      throw new ApplicationError(
        `Dry-run cannot use stale models. Synchronize ${repository.localBranch} with ${source} first.`,
      );
    }
  } else {
    mirrorPushed = await syncModelsRepository(repository, modelsRepository, source, logger);
  }

  const report: JsonMap = {
    timestamp: nowIso(),
    command: 'refresh',
    dry_run: Boolean(options.dryRun),
    anchor_before: anchor || null,
    source_ref: source,
    source_head: sourceHead,
    mirror_remote: repository.mirrorRemote || null,
    mirror_pushed: mirrorPushed,
    targets,
    services: {},
    scenarios: {},
  };
  if (stagingTargets.length === 0 && composedConverters.length === 0) {
    const reportPath = await writeReport(paths, report, Boolean(options.dryRun));
    return { report, reportPath, exitCode: 0 };
  }

  const postmanConfig = await readJson<JsonMap>(paths.postmanConfig, {});
  const mapPath = join(paths.applicationHome, 'postman-map.json');
  const inventoryPath = join(paths.applicationHome, 'ops-inventory.json');
  const postmanMap = await readJson<JsonMap>(mapPath, {});
  const operationsInventory = await readJson<JsonMap>(inventoryPath, {});
  const staging = await mkdtemp(join(tmpdir(), 'aws-api-collections-factory-'));
  const stagingOpenApi = join(staging, 'openapi');
  const stagingPostman = join(staging, 'postman');
  await mkdir(stagingOpenApi, { recursive: true });
  await mkdir(stagingPostman, { recursive: true });

  const results: JsonMap = {};
  const stagedOperations = new Map<string, string[]>();
  const collections = new Map<string, JsonMap>();
  const targetSet = new Set(targets);
  try {
    // stagingTargets may be a superset of targets: an enabled composed
    // output (e.g. interaction-poc) can pull in services its scenarios
    // reference that this run otherwise wouldn't have touched. Those extra
    // services get their spec staged below but are deliberately excluded
    // from the per-service report/Postman-push path via targetSet.
    const conversion = await runConversionLanes(context, modelsRoot, stagingTargets, stagingOpenApi);
    for (const [service, error] of conversion.failures) {
      if (!targetSet.has(service)) continue;
      results[service] = {
        lane: conversion.lanes.get(service) || null,
        requests: null,
        ops_added: [],
        ops_removed: [],
        hash: null,
        status: 'failed-route',
        error,
      };
    }

    for (const [service, lane] of [...conversion.lanes.entries()].sort()) {
      if (!targetSet.has(service) || results[service]) {
        continue;
      }
      const specPath = join(stagingOpenApi, `${service}.openapi.json`);
      const entry: JsonMap = {
        lane,
        requests: null,
        ops_added: [],
        ops_removed: [],
        hash: null,
        status: null,
        error: null,
      };
      results[service] = entry;
      try {
        const specification = JSON.parse(await readFile(specPath, 'utf8')) as JsonMap;
        if (!options.keepCors) {
          filterCorsOperations(specification);
          await writeJsonAtomic(specPath, specification);
        }
        const operations = specificationOperationIds(specification);
        stagedOperations.set(service, operations);
        const previous = Array.isArray(operationsInventory[service])
          ? operationsInventory[service] as string[]
          : [];
        entry.ops_added = sortedDifference(operations, previous);
        entry.ops_removed = sortedDifference(previous, operations);
      } catch (error) {
        entry.status = 'failed-convert';
        entry.error = `No valid ${basename(specPath)} was produced: ${String(error)}`;
      }
    }

    if (stagedOperations.size > 0) {
      await outputConverter.convertAll(paths, logger, stagingOpenApi, stagingPostman);
    }
    for (const service of [...stagedOperations.keys()].sort()) {
      const entry = results[service];
      try {
        const artifact = await outputConverter.readArtifact(stagingPostman, service);
        collections.set(service, artifact.data);
        entry.requests = artifact.metric;
        entry.hash = artifact.hash;
      } catch (error) {
        entry.status = 'failed-collection';
        entry.error = error instanceof Error ? error.message : String(error);
      }
    }

    const toPush: string[] = [];
    for (const [service] of [...collections.entries()].sort()) {
      const entry = results[service];
      const mapping = postmanMap[service] || {};
      if (entry.hash === mapping.hash && mapping.uid && !mapping.missing) {
        entry.status = 'skipped-unchanged';
      } else if (options.dryRun) {
        entry.status = 'dry-run';
      } else {
        toPush.push(service);
      }
    }

    if (toPush.length > 0 && !options.dryRun) {
      try {
        await outputConverter.preflight!(apiKey!);
      } catch (error) {
        for (const service of toPush.splice(0)) {
          results[service].status = 'failed-push';
          results[service].error = `Postman preflight failed: ${String(error)}`;
        }
      }
      for (const service of toPush) {
        const entry = results[service];
        const mapping = postmanMap[service];
        const pushed = await outputConverter.push!(
          apiKey!,
          { data: collections.get(service)!, hash: entry.hash as string, metric: entry.requests as number },
          mapping,
          postmanConfig,
          Boolean(options.createMissing || mapping?.missing),
        );
        entry.status = pushed.status;
        entry.error = pushed.error || null;
        if (['updated', 'created'].includes(pushed.status)) {
          postmanMap[service] = {
            uid: pushed.uid,
            name: collections.get(service)?.info?.name || service,
            hash: entry.hash,
            last_pushed: nowIso(),
          };
        }
      }
    }

    if (!options.dryRun) {
      await mkdir(paths.outputOpenApi, { recursive: true });
      await mkdir(paths.outputPostman, { recursive: true });
      for (const service of collections.keys()) {
        await copyFile(
          join(stagingOpenApi, `${service}.openapi.json`),
          join(paths.outputOpenApi, `${service}.openapi.json`),
        );
        await copyFile(
          join(stagingPostman, `${service}.postman_collection.json`),
          join(paths.outputPostman, `${service}.postman_collection.json`),
        );
      }

      const fullySuccessful = targets.filter((service) => FULL_SUCCESS.has(results[service]?.status));
      for (const service of fullySuccessful) {
        operationsInventory[service] = stagedOperations.get(service) || operationsInventory[service] || [];
      }
      await writeJsonAtomic(mapPath, postmanMap);
      await writeJsonAtomic(inventoryPath, operationsInventory);
      syncState.last_refresh = nowIso();
      if (options.services?.length) {
        report.anchor_after = anchor || null;
      } else if (fullySuccessful.length === targets.length) {
        syncState.last_source_commit = sourceHead;
        delete syncState.last_upstream_commit;
        syncState.source_remote = repository.sourceRemote;
        syncState.source_branch = repository.sourceBranch;
        report.anchor_after = sourceHead;
      } else {
        report.anchor_after = anchor || null;
      }
      await writeJsonAtomic(syncStatePath, syncState);
    }

    const scenarios: JsonMap = {};
    for (const converter of composedConverters) {
      const converterScenarios = scenariosByConverter.get(converter.id)!;
      if (converterScenarios.length === 0) continue;

      const specPaths = new Map<string, string>();
      for (const service of converter.requiredServices(converterScenarios)) {
        if (conversion.lanes.has(service)) {
          specPaths.set(service, join(stagingOpenApi, `${service}.openapi.json`));
        } else if (scenarioSpecsMode === 'last-used') {
          const lastUsedPath = join(paths.outputOpenApi, `${service}.openapi.json`);
          try {
            await access(lastUsedPath, constants.F_OK);
            specPaths.set(service, lastUsedPath);
          } catch {
            // No persisted spec either; reported per-scenario below.
          }
        }
      }

      const converterStaging = join(staging, converter.id);
      const scenarioResults = await converter.convertAll(converterScenarios, specPaths, converterStaging);
      const persistDir = join(paths.outputRoot, converter.id);
      if (!options.dryRun) {
        await mkdir(persistDir, { recursive: true });
      }
      for (const [scenarioId, result] of scenarioResults) {
        if (result.status === 'generated' && result.artifactPath && !options.dryRun) {
          const persistedPath = join(persistDir, basename(result.artifactPath));
          await copyFile(result.artifactPath, persistedPath);
          scenarios[scenarioId] = { output: converter.id, status: 'generated', artifact_path: persistedPath, error: null };
        } else {
          scenarios[scenarioId] = {
            output: converter.id,
            status: options.dryRun && result.status === 'generated' ? 'dry-run' : result.status,
            artifact_path: null,
            error: result.error || null,
          };
        }
      }
    }

    report.services = results;
    report.scenarios = scenarios;
    const reportPath = await writeReport(paths, report, Boolean(options.dryRun));
    const failed = Object.values(results).some((entry: any) => String(entry.status || '').startsWith('failed'))
      || Object.values(scenarios).some((entry: any) => entry.status === 'failed');
    return { report, reportPath, exitCode: failed ? 1 : 0 };
  } finally {
    if (options.keepStaging) {
      logger.info(`Staging directory: ${staging}`);
    } else {
      await rm(staging, { recursive: true, force: true });
    }
  }
}

export interface AdoptionSummary {
  workspace: JsonMap;
  proposed: JsonMap;
  unmatchedServices: string[];
  unmatchedCollections: JsonMap[];
}

export async function proposeAdoption(
  context: PipelineContext,
  wantedWorkspace: string,
): Promise<AdoptionSummary> {
  const client = new PostmanClient(postmanApiKey());
  const tracked = await loadTrackedServices(context.paths);
  const workspaces = (await client.request('GET', '/workspaces')).workspaces || [];
  let matches = workspaces.filter((workspace: JsonMap) => workspace.id === wantedWorkspace);
  if (matches.length === 0) {
    matches = workspaces.filter((workspace: JsonMap) => workspace.name === wantedWorkspace);
  }
  if (matches.length === 0) {
    matches = workspaces.filter(
      (workspace: JsonMap) => String(workspace.name || '').toLowerCase() === wantedWorkspace.toLowerCase(),
    );
  }
  if (matches.length !== 1) {
    const available = workspaces.map(
      (workspace: JsonMap) => `${workspace.id}: ${workspace.name} (${workspace.type || 'unknown'})`,
    ).join('\n');
    throw new ApplicationError(
      `Workspace '${wantedWorkspace}' was not uniquely resolved.\nAvailable workspaces:\n${available}`,
    );
  }
  const workspace = matches[0];
  const collections = (await client.request(
    'GET',
    `/collections?workspace=${encodeURIComponent(workspace.id)}`,
  )).collections || [];
  const byNormalizedName = new Map<string, JsonMap[]>();
  for (const collection of collections) {
    const key = normalizeCollectionName(collection.name || '');
    byNormalizedName.set(key, [...(byNormalizedName.get(key) || []), collection]);
  }
  const proposed: JsonMap = {};
  const unmatchedServices: string[] = [];
  for (const service of tracked) {
    const candidates = byNormalizedName.get(normalizeCollectionName(service)) || [];
    if (candidates.length === 1) {
      proposed[service] = candidates[0];
    } else {
      unmatchedServices.push(service);
    }
  }
  const matchedUids = new Set(Object.values(proposed).map((collection: any) => collection.uid));
  return {
    workspace,
    proposed,
    unmatchedServices,
    unmatchedCollections: collections.filter((collection: JsonMap) => !matchedUids.has(collection.uid)),
  };
}

export async function applyAdoption(
  context: PipelineContext,
  summary: AdoptionSummary,
): Promise<{ added: number; retained: number }> {
  await writeJsonAtomic(context.paths.postmanConfig, {
    workspace_id: summary.workspace.id,
    workspace_name: summary.workspace.name || '',
  });
  const mapPath = join(context.paths.applicationHome, 'postman-map.json');
  const map = await readJson<JsonMap>(mapPath, {});
  let added = 0;
  let retained = 0;
  for (const [service, collection] of Object.entries(summary.proposed) as [string, JsonMap][]) {
    if (map[service]) {
      retained += 1;
    } else {
      map[service] = { uid: collection.uid, name: collection.name || '' };
      added += 1;
    }
  }
  await writeJsonAtomic(mapPath, map);
  return { added, retained };
}

export async function reconcileCollections(context: PipelineContext): Promise<JsonMap> {
  const config = await readJson<JsonMap>(context.paths.postmanConfig, {});
  if (!config.workspace_id) {
    throw new ApplicationError('No Postman workspace is configured. Run adopt first.');
  }
  const client = new PostmanClient(postmanApiKey());
  const collections = (await client.request(
    'GET',
    `/collections?workspace=${encodeURIComponent(config.workspace_id)}`,
  )).collections || [];
  const liveIds = new Set<string>();
  for (const collection of collections) {
    if (collection.uid) liveIds.add(collection.uid);
    if (collection.id) liveIds.add(collection.id);
  }
  const mapPath = join(context.paths.applicationHome, 'postman-map.json');
  const map = await readJson<JsonMap>(mapPath, {});
  const services: JsonMap[] = [];
  for (const service of Object.keys(map).sort()) {
    const entry = map[service];
    const uid = String(entry.uid || '');
    const alive = liveIds.has(uid) || liveIds.has(uidIdPortion(uid));
    if (alive) {
      delete entry.missing;
    } else {
      entry.missing = true;
    }
    services.push({ service, uid: uid || null, status: alive ? 'ok' : 'missing' });
  }
  const mappedUids = new Set(Object.values(map).map((entry: any) => entry.uid).filter(Boolean));
  const mappedIds = new Set([...mappedUids].map((uid) => uidIdPortion(String(uid))));
  const unmapped = collections.filter(
    (collection: JsonMap) => !mappedUids.has(collection.uid) && !mappedIds.has(collection.id),
  );
  await writeJsonAtomic(mapPath, map);
  return { services, unmapped_collections: unmapped };
}
