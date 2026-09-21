// SPDX-License-Identifier: Apache-2.0

import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { RepositoryOptions, RuntimePaths } from './types.js';

export const APPLICATION_NAME = 'aws-api-collections-factory';
export const DEFAULT_MODELS_URL = 'https://github.com/aws/api-models-aws.git';

export function resolveInputPath(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.INIT_CWD || process.cwd(), value);
}

function findRepositoryRoot(): string {
  let candidate = dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (existsSync(join(candidate, 'settings.gradle.kts')) && existsSync(join(candidate, 'webapp'))) {
      return candidate;
    }
    const parent = dirname(candidate);
    if (parent === candidate) {
      throw new Error('Unable to locate the aws-api-collections-factory repository root.');
    }
    candidate = parent;
  }
}

export function defaultApplicationHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.APISYNC_HOME) {
    return resolve(env.APISYNC_HOME);
  }
  if (env.APISYNC_STATE_DIR) {
    return resolve(env.APISYNC_STATE_DIR);
  }
  if (platform() === 'win32') {
    return join(env.APPDATA || join(homedir(), 'AppData', 'Roaming'), APPLICATION_NAME);
  }
  if (platform() === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', APPLICATION_NAME);
  }
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), APPLICATION_NAME);
}

export function runtimePaths(
  applicationHome = defaultApplicationHome(),
  repositoryRoot = findRepositoryRoot(),
): RuntimePaths {
  const executable = platform() === 'win32'
    ? `${APPLICATION_NAME}.bat`
    : APPLICATION_NAME;
  return {
    repositoryRoot,
    applicationHome,
    servicesConfig: join(applicationHome, 'services.json'),
    postmanConfig: join(applicationHome, 'postman.json'),
    outputOpenApi: join(applicationHome, 'output', 'openapi'),
    outputPostman: join(applicationHome, 'output', 'postman'),
    reports: join(applicationHome, 'reports'),
    javaLauncher: join(repositoryRoot, 'build', 'install', APPLICATION_NAME, 'bin', executable),
    postmanConverter: join(repositoryRoot, 'scripts', 'openapi-to-postman.js'),
    postmanConverterDirectory: join(repositoryRoot, 'scripts'),
    staticRoot: join(repositoryRoot, 'webui', 'static'),
  };
}

export function repositoryOptionsFromEnvironment(env: NodeJS.ProcessEnv = process.env): RepositoryOptions {
  const sourceBranch = env.APISYNC_SOURCE_BRANCH || 'main';
  const localBranch = env.APISYNC_LOCAL_BRANCH || sourceBranch;
  return {
    modelsDir: env.APISYNC_MODELS_REPO ? resolveInputPath(env.APISYNC_MODELS_REPO, env) : undefined,
    modelsUrl: env.APISYNC_MODELS_URL || DEFAULT_MODELS_URL,
    sourceRemote: env.APISYNC_SOURCE_REMOTE || 'origin',
    sourceBranch,
    localBranch,
    mirrorRemote: env.APISYNC_MIRROR_REMOTE || undefined,
    mirrorBranch: env.APISYNC_MIRROR_BRANCH || localBranch,
  };
}

export function validateGitName(label: string, value: string): void {
  if (!value || value.startsWith('-') || /\s/.test(value)) {
    throw new Error(`${label} must be a non-empty Git name without whitespace.`);
  }
}

export function validateRepositoryOptions(options: RepositoryOptions): void {
  validateGitName('source remote', options.sourceRemote);
  validateGitName('source branch', options.sourceBranch);
  validateGitName('local branch', options.localBranch);
  validateGitName('mirror branch', options.mirrorBranch);
  if (options.mirrorRemote) {
    validateGitName('mirror remote', options.mirrorRemote);
    if (options.mirrorRemote === options.sourceRemote) {
      throw new Error('The mirror remote must differ from the source remote.');
    }
  }
}

export function statePath(paths: RuntimePaths, name: string): string {
  return join(paths.applicationHome, name);
}
