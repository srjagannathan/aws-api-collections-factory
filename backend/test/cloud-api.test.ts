// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

process.env.STATE_BUCKET = 'test-state';
process.env.JOBS_TABLE = 'test-jobs';
process.env.CODEBUILD_PROJECT = 'test-build';
process.env.ORIGIN_HEADER_VALUE = 'test-origin';

const { claimGroups, publicJob } = await import('../src/cloud-api.js');
const { normalizeBuildId } = await import('../src/cloud-build-events.js');

test('claimGroups accepts API Gateway string and array claim formats', () => {
  assert.deepEqual(claimGroups('[Administrators,Auditors]'), ['Administrators', 'Auditors']);
  assert.deepEqual(claimGroups('Administrators'), ['Administrators']);
  assert.deepEqual(claimGroups(['Administrators']), ['Administrators']);
});

test('claimGroups rejects absent and unsupported claim values', () => {
  assert.deepEqual(claimGroups(undefined), []);
  assert.deepEqual(claimGroups({ group: 'Administrators' }), []);
});

test('normalizeBuildId accepts CodeBuild API identifiers and EventBridge ARNs', () => {
  const id = 'aws-api-collections-factory-jobs:00000000-0000-0000-0000-000000000000';
  assert.equal(normalizeBuildId(id), id);
  assert.equal(
    normalizeBuildId(`arn:aws:codebuild:us-east-1:123456789012:build/${id}`),
    id,
  );
});

test('publicJob includes structured results and supports earlier stored jobs', () => {
  const stored = {
    id: 'job-1',
    kind: 'check',
    services: [],
    create_missing: false,
    status: 'succeeded',
    started_at: '2026-08-19T10:00:00.000Z',
    finished_at: '2026-08-19T10:02:00.000Z',
    return_code: 0,
  };
  const result = { source_commits_pending: 25, changed_tracked: [] };

  assert.deepEqual(publicJob(stored, 'complete', result), {
    ...stored,
    output: 'complete',
    result,
  });
  assert.equal(publicJob(stored).result, null);
});
