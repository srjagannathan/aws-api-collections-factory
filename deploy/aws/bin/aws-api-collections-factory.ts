#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { resolve } from 'node:path';

import * as cdk from 'aws-cdk-lib';

import { PostmanCollectionGeneratorStack } from '../lib/postman-collection-generator-stack';

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

const app = new cdk.App();
new PostmanCollectionGeneratorStack(app, process.env.PCG_STACK_NAME || 'PostmanCollectionGenerator', {
  env: {
    account: process.env.PCG_ACCOUNT_ID || process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
  },
  repositoryRoot: resolve(__dirname, '../../..'),
  domainName: requiredEnvironment('PCG_DOMAIN_NAME'),
  hostedZoneId: requiredEnvironment('PCG_HOSTED_ZONE_ID'),
  hostedZoneName: requiredEnvironment('PCG_HOSTED_ZONE_NAME'),
  certificateArn: requiredEnvironment('PCG_CERTIFICATE_ARN'),
});
