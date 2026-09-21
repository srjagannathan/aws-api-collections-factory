// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

import {
  CodeBuildClient,
  StartBuildCommand,
  type EnvironmentVariable,
} from '@aws-sdk/client-codebuild';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';

import { nowIso } from './time.js';
import type {
  CatalogResponse,
  CatalogService,
  Job,
  JsonMap,
  ServiceMetadata,
} from './types.js';

const MAX_REQUEST_BODY = 64 * 1024;
const MAX_JOB_OUTPUT = 2 * 1024 * 1024;
const LOCK_ID = '__active_job__';
const JOB_RETENTION_SECONDS = 30 * 24 * 60 * 60;
const LOCK_SECONDS = 2 * 60 * 60;

const stateBucket = requiredEnvironment('STATE_BUCKET');
const jobsTable = requiredEnvironment('JOBS_TABLE');
const buildProject = requiredEnvironment('CODEBUILD_PROJECT');
const originHeaderValue = requiredEnvironment('ORIGIN_HEADER_VALUE');
const administratorGroup = process.env.ADMINISTRATOR_GROUP || 'Administrators';

const s3 = new S3Client({});
const codeBuild = new CodeBuildClient({});
const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

interface StoredJob extends Job {
  build_id?: string;
  output_key: string;
  result_key: string;
  expires_at: number;
}

interface AuthenticationConfiguration {
  authority: string;
  client_id: string;
  hosted_ui_domain: string;
  redirect_uri: string;
  post_logout_redirect_uri: string;
}

class HttpError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function response(statusCode: number, payload: unknown): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    },
    body: JSON.stringify(payload),
  };
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftHash = createHash('sha256').update(left).digest();
  const rightHash = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

function assertCloudFrontOrigin(event: APIGatewayProxyEventV2): void {
  const supplied = event.headers['x-aacf-origin'] || '';
  if (!constantTimeEqual(supplied, originHeaderValue)) {
    throw new HttpError(403, 'This API is available through the application distribution only.');
  }
}

export function claimGroups(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'string') return [];
  return value
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((group) => group.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
}

function assertAdministrator(event: APIGatewayProxyEventV2): void {
  const context = event.requestContext as typeof event.requestContext & {
    authorizer?: { jwt?: { claims?: Record<string, unknown> } };
  };
  const claims = context.authorizer?.jwt?.claims;
  if (!claims || !claimGroups(claims['cognito:groups']).includes(administratorGroup)) {
    throw new HttpError(403, 'Administrator access is required.');
  }
}

function parseBody(event: APIGatewayProxyEventV2): JsonMap {
  const encoded = event.body || '';
  const body = event.isBase64Encoded ? Buffer.from(encoded, 'base64').toString('utf8') : encoded;
  if (Buffer.byteLength(body) > MAX_REQUEST_BODY) {
    throw new HttpError(413, 'Request body is too large.');
  }
  try {
    return JSON.parse(body) as JsonMap;
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON.');
  }
}

async function readJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const result = await s3.send(new GetObjectCommand({ Bucket: stateBucket, Key: key }));
    const value = await result.Body?.transformToString('utf8');
    return value ? JSON.parse(value) as T : fallback;
  } catch (error) {
    const name = (error as { name?: string }).name;
    if (name === 'NoSuchKey' || name === 'NotFound') return fallback;
    throw error;
  }
}

async function writeJson(key: string, value: unknown): Promise<void> {
  await s3.send(new PutObjectCommand({
    Bucket: stateBucket,
    Key: key,
    Body: `${JSON.stringify(value, null, 2)}\n`,
    ContentType: 'application/json',
    ServerSideEncryption: 'AES256',
    CacheControl: 'no-store',
  }));
}

async function catalogResponse(): Promise<CatalogResponse> {
  const [metadata, serviceConfig, postmanMap, workspace] = await Promise.all([
    readJson<{ services?: ServiceMetadata[]; updated_at?: string }>('state/service-catalog.json', {}),
    readJson<{ tracked?: string[] }>('state/services.json', {}),
    readJson<Record<string, JsonMap>>('state/postman-map.json', {}),
    readJson<JsonMap>('state/postman.json', {}),
  ]);
  if (!metadata.services?.length) {
    throw new HttpError(503, 'The AWS service catalog has not been initialized.');
  }
  const tracked = new Set(serviceConfig.tracked || []);
  const services: CatalogService[] = metadata.services.map((service) => {
    const mapping = postmanMap[service.id] || {};
    return {
      ...service,
      tracked: tracked.has(service.id),
      collection_status: mapping.missing ? 'missing' : mapping.uid ? 'mapped' : 'unmapped',
      collection_name: String(mapping.name || ''),
      last_pushed: String(mapping.last_pushed || ''),
    };
  });
  return {
    services,
    workspace_name: String(workspace.workspace_name || ''),
    workspace_configured: Boolean(workspace.workspace_id),
    updated_at: String(metadata.updated_at || nowIso()),
  };
}

async function activeJobId(): Promise<string | null> {
  const result = await dynamodb.send(new GetCommand({
    TableName: jobsTable,
    Key: { id: LOCK_ID },
    ConsistentRead: true,
  }));
  const lock = result.Item;
  if (!lock) return null;
  if (Number(lock.expires_at || 0) >= Math.floor(Date.now() / 1000)) {
    return String(lock.job_id);
  }
  await dynamodb.send(new DeleteCommand({ TableName: jobsTable, Key: { id: LOCK_ID } }));
  return null;
}

export function publicJob(
  item: Record<string, unknown>,
  output = '',
  result: JsonMap | null = null,
): Job {
  return {
    id: String(item.id),
    kind: item.kind as Job['kind'],
    services: Array.isArray(item.services) ? item.services.map(String) : [],
    create_missing: Boolean(item.create_missing),
    status: item.status as Job['status'],
    started_at: String(item.started_at),
    finished_at: item.finished_at ? String(item.finished_at) : null,
    return_code: typeof item.return_code === 'number' ? item.return_code : null,
    output,
    result,
  };
}

async function jobOutput(key: string): Promise<string> {
  try {
    const result = await s3.send(new GetObjectCommand({ Bucket: stateBucket, Key: key }));
    const output = await result.Body?.transformToString('utf8') || '';
    if (Buffer.byteLength(output) <= MAX_JOB_OUTPUT) return output;
    return `${output.slice(0, MAX_JOB_OUTPUT)}\n[Job output truncated at 2 MiB]\n`;
  } catch (error) {
    const name = (error as { name?: string }).name;
    if (name === 'NoSuchKey' || name === 'NotFound') return '';
    throw error;
  }
}

async function listJobs(): Promise<{ active_job_id: string | null; jobs: Job[] }> {
  const result = await dynamodb.send(new ScanCommand({ TableName: jobsTable, Limit: 100 }));
  const jobs = (result.Items || [])
    .filter((item) => item.id !== LOCK_ID)
    .sort((left, right) => String(right.started_at).localeCompare(String(left.started_at)))
    .slice(0, 20)
    .map((item) => publicJob(item));
  return { active_job_id: await activeJobId(), jobs };
}

async function getJob(jobId: string): Promise<Job> {
  const result = await dynamodb.send(new GetCommand({
    TableName: jobsTable,
    Key: { id: jobId },
    ConsistentRead: true,
  }));
  if (!result.Item || result.Item.id === LOCK_ID) throw new HttpError(404, 'Job not found.');
  const outputKey = typeof result.Item.output_key === 'string' ? result.Item.output_key : '';
  const resultKey = typeof result.Item.result_key === 'string' ? result.Item.result_key : '';
  const [output, jobResult] = await Promise.all([
    outputKey ? jobOutput(outputKey) : Promise.resolve(''),
    resultKey ? readJson<JsonMap | null>(resultKey, null) : Promise.resolve(null),
  ]);
  return publicJob(result.Item, output, jobResult);
}

async function assertNoActiveJob(): Promise<void> {
  if (await activeJobId()) {
    throw new HttpError(409, 'A pipeline job is already running. Wait for it to finish.');
  }
}

async function updateTracking(serviceIds: unknown): Promise<CatalogResponse> {
  await assertNoActiveJob();
  if (!Array.isArray(serviceIds) || !serviceIds.every((service) => typeof service === 'string')) {
    throw new HttpError(400, 'services must be a list of service identifiers.');
  }
  const catalog = await catalogResponse();
  const known = new Set(catalog.services.map((service) => service.id));
  const selected = [...new Set(serviceIds as string[])].sort();
  const unknown = selected.filter((service) => !known.has(service));
  if (unknown.length > 0) throw new HttpError(400, `Unknown services: ${unknown.join(', ')}`);
  if (selected.length === 0) throw new HttpError(400, 'Keep at least one tracked service.');
  await writeJson('state/services.json', { tracked: selected });
  return catalogResponse();
}

async function validateTargets(kind: Job['kind'], value: unknown): Promise<string[]> {
  if (kind === 'check') return [];
  if (!Array.isArray(value) || value.length === 0 || !value.every((item) => typeof item === 'string')) {
    throw new HttpError(400, 'Select at least one service first.');
  }
  const selected = [...new Set(value as string[])].sort();
  const catalog = await catalogResponse();
  const known = new Set(catalog.services.map((service) => service.id));
  const tracked = new Set(catalog.services.filter((service) => service.tracked).map((service) => service.id));
  const unknown = selected.filter((service) => !known.has(service));
  if (unknown.length > 0) throw new HttpError(400, `Unknown services: ${unknown.join(', ')}`);
  const untracked = selected.filter((service) => !tracked.has(service));
  if (untracked.length > 0) {
    throw new HttpError(400, `Track selected services before running the pipeline: ${untracked.join(', ')}`);
  }
  return selected;
}

function environmentVariable(name: string, value: string): EnvironmentVariable {
  return { name, value, type: 'PLAINTEXT' };
}

async function startJob(payload: JsonMap): Promise<Job> {
  if (!['check', 'preview', 'publish'].includes(payload.kind)) {
    throw new HttpError(400, 'kind must be check, preview, or publish.');
  }
  const kind = payload.kind as Job['kind'];
  const services = await validateTargets(kind, payload.services);
  const id = randomUUID().replace(/-/g, '').slice(0, 12);
  const now = nowIso();
  const epoch = Math.floor(Date.now() / 1000);
  const item: StoredJob = {
    id,
    kind,
    services,
    create_missing: Boolean(payload.create_missing),
    status: 'running',
    started_at: now,
    finished_at: null,
    return_code: null,
    output: '',
    result: null,
    output_key: `jobs/${id}/output.log`,
    result_key: `jobs/${id}/result.json`,
    expires_at: epoch + JOB_RETENTION_SECONDS,
  };

  try {
    await dynamodb.send(new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: jobsTable,
            Item: { id: LOCK_ID, job_id: id, expires_at: epoch + LOCK_SECONDS },
            ConditionExpression: 'attribute_not_exists(id) OR expires_at < :now',
            ExpressionAttributeValues: { ':now': epoch },
          },
        },
        {
          Put: {
            TableName: jobsTable,
            Item: item,
            ConditionExpression: 'attribute_not_exists(id)',
          },
        },
      ],
    }));
  } catch (error) {
    if ((error as { name?: string }).name === 'TransactionCanceledException') {
      throw new HttpError(409, 'A pipeline job is already running. Wait for it to finish.');
    }
    throw error;
  }

  try {
    const started = await codeBuild.send(new StartBuildCommand({
      projectName: buildProject,
      environmentVariablesOverride: [
        environmentVariable('APISYNC_JOB_ID', id),
        environmentVariable('APISYNC_JOB_KIND', kind),
        environmentVariable('APISYNC_SERVICES', services.join(',')),
        environmentVariable('APISYNC_CREATE_MISSING', String(Boolean(payload.create_missing))),
      ],
    }));
    if (!started.build?.id) throw new Error('CodeBuild did not return a build identifier.');
    item.build_id = started.build.id;
    await dynamodb.send(new UpdateCommand({
      TableName: jobsTable,
      Key: { id },
      UpdateExpression: 'SET build_id = :build_id',
      ExpressionAttributeValues: { ':build_id': item.build_id },
    }));
    return publicJob(item as unknown as JsonMap);
  } catch (error) {
    await Promise.allSettled([
      dynamodb.send(new DeleteCommand({ TableName: jobsTable, Key: { id } })),
      dynamodb.send(new DeleteCommand({ TableName: jobsTable, Key: { id: LOCK_ID } })),
    ]);
    throw error;
  }
}

function authenticationConfiguration(): AuthenticationConfiguration {
  return {
    authority: requiredEnvironment('COGNITO_AUTHORITY'),
    client_id: requiredEnvironment('COGNITO_CLIENT_ID'),
    hosted_ui_domain: requiredEnvironment('COGNITO_HOSTED_UI_DOMAIN'),
    redirect_uri: requiredEnvironment('COGNITO_REDIRECT_URI'),
    post_logout_redirect_uri: requiredEnvironment('COGNITO_LOGOUT_URI'),
  };
}

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    assertCloudFrontOrigin(event);
    const path = event.rawPath;
    const method = event.requestContext.http.method;
    if (method === 'GET' && path === '/api/config') {
      return response(200, { authentication: authenticationConfiguration() });
    }

    assertAdministrator(event);
    if (method === 'GET' && path === '/api/catalog') {
      return response(200, await catalogResponse());
    }
    if (method === 'GET' && path === '/api/jobs') {
      return response(200, await listJobs());
    }
    if (method === 'GET' && path.startsWith('/api/jobs/')) {
      const jobId = path.split('/').at(-1) || '';
      return response(200, await getJob(jobId));
    }
    if (method === 'POST' && path === '/api/tracking') {
      return response(200, await updateTracking(parseBody(event).services));
    }
    if (method === 'POST' && path === '/api/jobs') {
      return response(202, await startJob(parseBody(event)));
    }
    return response(404, { error: 'Not found.' });
  } catch (error) {
    console.error(JSON.stringify({
      path: event.rawPath,
      method: event.requestContext.http.method,
      error: error instanceof Error ? error.message : String(error),
    }));
    if (error instanceof HttpError) return response(error.statusCode, { error: error.message });
    return response(500, { error: 'Request could not be completed.' });
  }
}
