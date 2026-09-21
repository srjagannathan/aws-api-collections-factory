#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';

import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';

import { requiredOutput, stackOutputs } from './stack-outputs';

function temporaryPassword(): string {
  return `A!9z${randomBytes(18).toString('base64url')}#`;
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  const parsed = parseArgs({
    args: argv,
    strict: true,
    options: {
      email: { type: 'string' },
      stack: { type: 'string', default: 'AwsApiCollectionsFactory' },
    },
  });
  const email = parsed.values.email || process.env.AACF_ADMIN_EMAIL;
  if (!email) throw new Error('--email or AACF_ADMIN_EMAIL is required.');
  const outputs = await stackOutputs(parsed.values.stack!);
  const userPoolId = requiredOutput(outputs, 'UserPoolId');
  const groupName = requiredOutput(outputs, 'AdministratorGroupName');
  const cognito = new CognitoIdentityProviderClient({});
  try {
    await cognito.send(new AdminCreateUserCommand({
      UserPoolId: userPoolId,
      Username: email,
      TemporaryPassword: temporaryPassword(),
      DesiredDeliveryMediums: ['EMAIL'],
      UserAttributes: [
        { Name: 'email', Value: email },
        { Name: 'email_verified', Value: 'true' },
      ],
    }));
    console.log('Created the administrator and sent a Cognito invitation email.');
  } catch (error) {
    if ((error as { name?: string }).name !== 'UsernameExistsException') throw error;
    console.log('The administrator already exists.');
  }
  await cognito.send(new AdminAddUserToGroupCommand({
    UserPoolId: userPoolId,
    Username: email,
    GroupName: groupName,
  }));
  console.log(`Added the administrator to ${groupName}.`);
}

main().catch((error) => {
  console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
