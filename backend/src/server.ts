#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { Catalog } from './catalog.js';
import {
  repositoryOptionsFromEnvironment,
  resolveInputPath,
  runtimePaths,
  validateRepositoryOptions,
} from './config.js';
import { JobManager } from './jobs.js';
import { resolveModelsRepository } from './model-source.js';
import type { PipelineContext } from './pipeline.js';
import type { JsonMap, RepositoryOptions } from './types.js';
import { ApplicationError, consoleLogger } from './types.js';

const MAX_REQUEST_BODY = 64 * 1024;
const STATIC_ASSET = /^\/[A-Za-z0-9._-]+\.(?:js|css|woff2?|png|svg)$/;

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': body.length,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  response.end(body);
}

async function readJsonBody(request: IncomingMessage): Promise<JsonMap> {
  const length = Number.parseInt(request.headers['content-length'] || '0', 10);
  if (!Number.isFinite(length) || length < 0 || length > MAX_REQUEST_BODY) {
    throw new Error('Request body is too large or has an invalid Content-Length.');
  }
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    received += buffer.length;
    if (received > MAX_REQUEST_BODY) {
      throw new Error('Request body is too large.');
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as JsonMap;
  } catch {
    throw new Error('Request body must be valid JSON.');
  }
}

function tokenMatches(request: IncomingMessage, token: string): boolean {
  const supplied = String(request.headers['x-apisync-token'] || '');
  const expectedHash = createHash('sha256').update(token).digest();
  const suppliedHash = createHash('sha256').update(supplied).digest();
  return timingSafeEqual(expectedHash, suppliedHash);
}

function optionsFromArguments(values: Record<string, unknown>): RepositoryOptions {
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

export async function startLocalServer(argv = process.argv.slice(2)): Promise<void> {
  const parsed = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      port: { type: 'string', default: '8765' },
      'models-dir': { type: 'string' },
      'models-url': { type: 'string' },
      'source-remote': { type: 'string' },
      'source-branch': { type: 'string' },
      'local-branch': { type: 'string' },
      'mirror-remote': { type: 'string' },
      'mirror-branch': { type: 'string' },
    },
  });
  const port = Number.parseInt(parsed.values.port!, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ApplicationError('--port must be between 1 and 65535.');
  }
  const paths = runtimePaths();
  await access(join(paths.staticRoot, 'index.html'), constants.F_OK).catch(() => {
    throw new ApplicationError('The browser build is missing. Run npm run build:web.');
  });
  const repository = optionsFromArguments(parsed.values);
  const modelsRepository = await resolveModelsRepository(repository, paths, consoleLogger);
  repository.modelsDir = modelsRepository;
  const context: PipelineContext = { repository, paths, logger: consoleLogger };
  const catalog = new Catalog(join(modelsRepository, 'models'), paths);
  const jobs = new JobManager(catalog, context);
  const token = randomBytes(32).toString('base64url');

  const server = createServer(async (request, response) => {
    const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);
    try {
      if (request.method === 'GET' && url.pathname === '/api/catalog') {
        sendJson(response, 200, await catalog.response());
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/config') {
        sendJson(response, 200, { authentication: null });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/jobs') {
        sendJson(response, 200, jobs.snapshot());
        return;
      }
      if (request.method === 'GET' && url.pathname.startsWith('/api/jobs/')) {
        const job = jobs.snapshot(url.pathname.split('/').at(-1));
        sendJson(response, job ? 200 : 404, job || { error: 'Job not found.' });
        return;
      }
      if (request.method === 'POST' && !tokenMatches(request, token)) {
        sendJson(response, 403, { error: 'Invalid local request token.' });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/tracking') {
        const payload = await readJsonBody(request);
        sendJson(response, 200, await catalog.updateTracking(payload.services));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/jobs') {
        const payload = await readJsonBody(request);
        if (!['check', 'preview', 'publish'].includes(payload.kind)) {
          throw new Error('kind must be check, preview, or publish.');
        }
        const services = payload.kind === 'check'
          ? []
          : await catalog.validateTargets(payload.services);
        sendJson(response, 202, jobs.start(payload.kind, services, Boolean(payload.create_missing)));
        return;
      }
      if (request.method === 'GET' && (url.pathname === '/' || STATIC_ASSET.test(url.pathname))) {
        const filename = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        let body = await readFile(join(paths.staticRoot, filename));
        if (filename === 'index.html') {
          body = Buffer.from(body.toString('utf8').replace('{{APISYNC_TOKEN}}', token));
        }
        const contentType = filename === 'index.html'
          ? 'text/html; charset=utf-8'
          : filename.endsWith('.js')
            ? 'application/javascript; charset=utf-8'
            : filename.endsWith('.css')
              ? 'text/css; charset=utf-8'
              : filename.endsWith('.svg')
                ? 'image/svg+xml'
                : filename.endsWith('.png')
                  ? 'image/png'
                  : 'font/woff2';
        response.writeHead(200, {
          'Content-Type': contentType,
          'Cache-Control': 'no-store',
          'Content-Length': body.length,
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer',
        });
        response.end(body);
        return;
      }
      sendJson(response, 404, { error: 'Not found.' });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      consoleLogger.error(`HTTP ${request.method || 'UNKNOWN'} ${url.pathname}: ${detail}`);
      sendJson(response, 400, { error: 'Request could not be completed. Review the local server log.' });
    }
  });

  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolvePromise());
  });
  console.log(`AWS API Collections Factory: http://127.0.0.1:${port}`);
  console.log('Bound to localhost only. Press Ctrl-C to stop.');
}

startLocalServer().catch((error) => {
  console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = error instanceof ApplicationError ? error.exitCode : 1;
});
