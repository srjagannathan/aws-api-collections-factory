#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { resolve } from 'node:path';

import * as cdk from 'aws-cdk-lib';

import { AwsApiCollectionsFactoryStack } from '../lib/aws-api-collections-factory-stack';

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

const app = new cdk.App();
new AwsApiCollectionsFactoryStack(app, process.env.AACF_STACK_NAME || 'AwsApiCollectionsFactory', {
  env: {
    account: process.env.AACF_ACCOUNT_ID || process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
  },
  repositoryRoot: resolve(__dirname, '../../..'),
  domainName: requiredEnvironment('AACF_DOMAIN_NAME'),
  hostedZoneId: requiredEnvironment('AACF_HOSTED_ZONE_ID'),
  hostedZoneName: requiredEnvironment('AACF_HOSTED_ZONE_NAME'),
  certificateArn: requiredEnvironment('AACF_CERTIFICATE_ARN'),
});
