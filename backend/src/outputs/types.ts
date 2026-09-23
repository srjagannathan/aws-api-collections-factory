// SPDX-License-Identifier: Apache-2.0

import type { JsonMap, Logger, RuntimePaths } from '../types.js';

export interface OutputArtifact {
  data: JsonMap;
  hash: string;
  metric: number;
}

export interface OutputPushResult {
  status: string;
  uid?: string;
  error?: string;
}

// One output type converts every staged OpenAPI spec in `stagingOpenApi` into
// its own artifact format, then optionally publishes each artifact to a live
// target (Postman today). A generate-only output can omit preflight/push
// entirely and just write artifacts to disk.
export interface OutputConverter {
  readonly id: string;
  readonly kind: 'per-service';
  convertAll(paths: RuntimePaths, logger: Logger, stagingOpenApi: string, stagingOutput: string): Promise<void>;
  readArtifact(stagingOutput: string, service: string): Promise<OutputArtifact>;
  preflight?(apiKey: string): Promise<void>;
  push?(
    apiKey: string,
    artifact: OutputArtifact,
    mapping: JsonMap | undefined,
    targetConfig: JsonMap,
    allowCreate: boolean,
  ): Promise<OutputPushResult>;
}

export interface ScenarioStep {
  service: string;
  operation: string;
  narrative?: string;
}

export interface Scenario {
  id: string;
  title: string;
  description?: string;
  steps: ScenarioStep[];
}

export interface ComposedResult {
  status: 'generated' | 'failed';
  artifactPath?: string;
  error?: string;
}

// A composed output reads MULTIPLE services' staged specs at once, named by
// a curated scenario (which operations chain together can't be inferred
// from the specs alone), and produces one artifact per scenario, not per
// service.
export interface ComposedConverter {
  readonly id: string;
  readonly kind: 'composed';
  loadScenarios(paths: RuntimePaths): Promise<Scenario[]>;
  requiredServices(scenarios: Scenario[]): Set<string>;
  convertAll(
    scenarios: Scenario[],
    specPaths: Map<string, string>,
    outputDir: string,
  ): Promise<Map<string, ComposedResult>>;
}

export type AnyConverter = OutputConverter | ComposedConverter;
