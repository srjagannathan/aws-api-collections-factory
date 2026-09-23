// SPDX-License-Identifier: Apache-2.0

export type JsonMap = Record<string, any>;

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const consoleLogger: Logger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};

export const stderrLogger: Logger = {
  info: (message) => console.error(message),
  warn: (message) => console.error(message),
  error: (message) => console.error(message),
};

export interface RepositoryOptions {
  modelsDir?: string;
  modelsUrl: string;
  sourceRemote: string;
  sourceBranch: string;
  localBranch: string;
  mirrorRemote?: string;
  mirrorBranch: string;
}

export interface RuntimePaths {
  repositoryRoot: string;
  applicationHome: string;
  servicesConfig: string;
  postmanConfig: string;
  outputsConfig: string;
  outputRoot: string;
  outputOpenApi: string;
  outputPostman: string;
  reports: string;
  javaLauncher: string;
  postmanConverter: string;
  postmanConverterDirectory: string;
  staticRoot: string;
}

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ServiceMetadata {
  id: string;
  name: string;
  protocol: string;
  version: string;
  operations: number;
}

export interface CatalogService extends ServiceMetadata {
  tracked: boolean;
  collection_status: 'mapped' | 'missing' | 'unmapped';
  collection_name: string;
  last_pushed: string;
}

export interface CatalogResponse {
  services: CatalogService[];
  workspace_name: string;
  workspace_configured: boolean;
  updated_at: string;
}

export interface Job {
  id: string;
  kind: 'check' | 'preview' | 'publish';
  services: string[];
  create_missing: boolean;
  status: 'running' | 'succeeded' | 'failed';
  started_at: string;
  finished_at: string | null;
  return_code: number | null;
  output: string;
  result: JsonMap | null;
}

export class ApplicationError extends Error {
  constructor(message: string, readonly exitCode = 1) {
    super(message);
    this.name = 'ApplicationError';
  }
}
