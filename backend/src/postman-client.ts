// SPDX-License-Identifier: Apache-2.0

import type { JsonMap } from './types.js';

const POSTMAN_API = 'https://api.postman.com';

export class PostmanApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'PostmanApiError';
  }
}

export function postmanApiKey(env: NodeJS.ProcessEnv = process.env): string {
  const key = (env.POSTMAN_API_KEY || '').trim();
  if (!key) {
    throw new PostmanApiError(
      'POSTMAN_API_KEY is not set. Create a Postman API key and export it before publishing.',
    );
  }
  return key;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class PostmanClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = POSTMAN_API,
  ) {}

  async request(method: string, path: string, body?: JsonMap): Promise<JsonMap> {
    let rateLimitRetries = 1;
    let serverRetries = 1;
    while (true) {
      let response: Response;
      try {
        response = await fetch(`${this.baseUrl}${path}`, {
          method,
          headers: {
            'X-Api-Key': this.apiKey,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'User-Agent': 'aws-api-collections-factory/1.0',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(120_000),
        });
      } catch (error) {
        throw new PostmanApiError(`${method} ${path} failed: ${String(error)}`);
      }

      if (response.ok) {
        const text = await response.text();
        return text ? JSON.parse(text) as JsonMap : {};
      }
      const snippet = (await response.text()).slice(0, 300) || '(empty body)';
      if (response.status === 429 && rateLimitRetries > 0) {
        rateLimitRetries -= 1;
        const seconds = Number.parseFloat(response.headers.get('Retry-After') || '2');
        await delay(Math.min(Number.isFinite(seconds) ? seconds : 2, 60) * 1000);
        continue;
      }
      if (response.status >= 500 && method !== 'POST' && serverRetries > 0) {
        serverRetries -= 1;
        await delay(2000);
        continue;
      }
      throw new PostmanApiError(
        `${method} ${path} returned HTTP ${response.status}: ${snippet}`,
        response.status,
      );
    }
  }
}

export function uidIdPortion(uid: string): string {
  return /^\d+-/.test(uid) ? uid.split('-', 2)[1]! : uid;
}

export interface PushCollectionResult {
  status: 'updated' | 'created' | 'failed-push' | 'failed-unmapped';
  uid?: string;
  error?: string;
}

export async function pushCollection(
  client: PostmanClient,
  collection: JsonMap,
  mapping: JsonMap | undefined,
  workspaceId: string | undefined,
  allowCreate: boolean,
): Promise<PushCollectionResult> {
  const uid = mapping?.uid as string | undefined;
  if (uid && !mapping?.missing) {
    collection.info ||= {};
    collection.info._postman_id = uidIdPortion(uid);
    const body = { collection };
    try {
      const response = await client.request('PUT', `/collections/${encodeURIComponent(uid)}`, body);
      return { status: 'updated', uid: response.collection?.uid || uid };
    } catch (error) {
      if (!(error instanceof PostmanApiError) || error.status !== 404) {
        return { status: 'failed-push', uid, error: String(error) };
      }
      try {
        const response = await client.request(
          'PUT',
          `/collections/${encodeURIComponent(uidIdPortion(uid))}`,
          body,
        );
        return { status: 'updated', uid: response.collection?.uid || uid };
      } catch (retryError) {
        return { status: 'failed-push', uid, error: String(retryError) };
      }
    }
  }

  if (!allowCreate) {
    return {
      status: 'failed-unmapped',
      uid,
      error: 'No collection is mapped. Run adopt first or enable create-missing.',
    };
  }
  if (!workspaceId) {
    return {
      status: 'failed-unmapped',
      uid,
      error: 'No Postman workspace is configured. Run adopt first.',
    };
  }
  try {
    const response = await client.request(
      'POST',
      `/collections?workspace=${encodeURIComponent(workspaceId)}`,
      { collection },
    );
    return {
      status: 'created',
      uid: response.collection?.uid || response.collection?.id,
    };
  } catch (error) {
    return { status: 'failed-push', uid, error: String(error) };
  }
}
