// SPDX-License-Identifier: Apache-2.0

import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { collectionHash, countRequests } from '../collection-utils.js';
import { PostmanClient, pushCollection } from '../postman-client.js';
import { runProcess } from '../process.js';
import type { JsonMap, Logger, RuntimePaths } from '../types.js';
import type { OutputArtifact, OutputConverter, OutputPushResult } from './types.js';

async function convertAll(
  paths: RuntimePaths,
  logger: Logger,
  stagingOpenApi: string,
  stagingOutput: string,
): Promise<void> {
  const result = await runProcess('node', [
    paths.postmanConverter,
    'convert',
    stagingOpenApi,
    '-o', stagingOutput,
  ], { cwd: paths.postmanConverterDirectory, logger });
  if (result.exitCode !== 0) {
    logger.warn(`The Postman conversion stage exited with status ${result.exitCode}.`);
  }
}

async function readArtifact(stagingOutput: string, service: string): Promise<OutputArtifact> {
  const collectionPath = join(stagingOutput, `${service}.postman_collection.json`);
  let data: JsonMap;
  try {
    data = JSON.parse(await readFile(collectionPath, 'utf8')) as JsonMap;
  } catch (error) {
    throw new Error(`No valid ${basename(collectionPath)} was produced: ${String(error)}`);
  }
  return {
    data,
    hash: collectionHash(data),
    metric: countRequests(data.item as JsonMap[] | undefined),
  };
}

async function preflight(apiKey: string): Promise<void> {
  await new PostmanClient(apiKey).request('GET', '/me');
}

async function push(
  apiKey: string,
  artifact: OutputArtifact,
  mapping: JsonMap | undefined,
  targetConfig: JsonMap,
  allowCreate: boolean,
): Promise<OutputPushResult> {
  const client = new PostmanClient(apiKey);
  return pushCollection(client, artifact.data, mapping, targetConfig.workspace_id, allowCreate);
}

export const postmanOutput: OutputConverter = {
  id: 'postman',
  kind: 'per-service',
  convertAll,
  readArtifact,
  preflight,
  push,
};
