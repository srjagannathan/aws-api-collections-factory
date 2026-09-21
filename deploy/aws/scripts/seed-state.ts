#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

import { requiredOutput, stackOutputs } from './stack-outputs';

const APPROVED_FILES = [
  'services.json',
  'postman.json',
  'postman-map.json',
  'ops-inventory.json',
  'sync-state.json',
  'service-catalog.json',
] as const;

async function main(argv = process.argv.slice(2)): Promise<void> {
  const parsed = parseArgs({
    args: argv,
    strict: true,
    options: {
      'state-dir': { type: 'string' },
      stack: { type: 'string', default: 'AwsApiCollectionsFactory' },
    },
  });
  if (!parsed.values['state-dir']) throw new Error('--state-dir is required.');
  const stateDirectory = resolve(parsed.values['state-dir']);
  const outputs = await stackOutputs(parsed.values.stack!);
  const bucket = requiredOutput(outputs, 'StateBucketName');
  const s3 = new S3Client({});
  for (const filename of APPROVED_FILES) {
    const body = await readFile(join(stateDirectory, filename));
    JSON.parse(body.toString('utf8'));
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: `state/${filename}`,
      Body: body,
      ContentType: 'application/json',
      CacheControl: 'no-store',
      ServerSideEncryption: 'AES256',
    }));
    console.log(`Uploaded ${filename}`);
  }
}

main().catch((error) => {
  console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
