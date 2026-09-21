// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';

import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';

import { PostmanCollectionGeneratorStack } from '../lib/postman-collection-generator-stack';

test('uses the Cognito managed sign-in domain', () => {
  const app = new cdk.App();
  const stack = new PostmanCollectionGeneratorStack(app, 'TestStack', {
    env: { account: '111122223333', region: 'us-east-1' },
    repositoryRoot: resolve(__dirname, '../../../..'),
    domainName: 'pcg.example.com',
    hostedZoneId: 'Z0123456789EXAMPLE',
    hostedZoneName: 'example.com',
    certificateArn: 'arn:aws:acm:us-east-1:111122223333:certificate/example',
  });

  const functions = Template.fromStack(stack).findResources('AWS::Lambda::Function');
  const hostedUiDomains = Object.values(functions)
    .map((resource) => resource.Properties?.Environment?.Variables?.COGNITO_HOSTED_UI_DOMAIN)
    .filter((value) => value !== undefined);

  assert.equal(hostedUiDomains.length, 1);
  const hostedUiDomain = JSON.stringify(hostedUiDomains[0]);
  assert.match(hostedUiDomain, /\.auth\.us-east-1\.amazoncognito\.com/);
  assert.doesNotMatch(hostedUiDomain, /\.auth\.us-east-1\.amazonaws\.com/);
});
