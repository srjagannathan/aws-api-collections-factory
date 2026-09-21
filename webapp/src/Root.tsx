// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';
import TopNavigation from '@cloudscape-design/components/top-navigation';

import App from './App';
import {
  initializeAuthentication,
  signIn,
  signOut,
  type AuthenticationState,
} from './auth';

interface RootState {
  authentication?: AuthenticationState;
  error?: string;
}

export default function Root() {
  const [state, setState] = useState<RootState>({});

  useEffect(() => {
    void initializeAuthentication().then(
      (authentication) => setState({ authentication }),
      (error) => setState({ error: error instanceof Error ? error.message : String(error) }),
    );
  }, []);

  if (state.error) {
    return (
      <main className="auth-shell">
        <Alert type="error" header="Sign-in initialization failed">{state.error}</Alert>
      </main>
    );
  }
  if (!state.authentication) {
    return <main className="auth-shell"><Spinner size="large" /></main>;
  }
  if (!state.authentication.enabled || state.authentication.user) {
    return (
      <App
        authenticationEnabled={state.authentication.enabled}
        onSignOut={() => void signOut()}
      />
    );
  }
  return (
    <>
      <TopNavigation identity={{ href: '/', title: 'AWS API Collections Factory' }} />
      <main className="auth-shell">
        <ContentLayout header={<Header variant="h1">Administrator sign-in</Header>}>
          <SpaceBetween size="m">
            <Box color="text-body-secondary">Authentication is required for this deployment.</Box>
            <Button variant="primary" onClick={() => void signIn()}>Sign in</Button>
          </SpaceBetween>
        </ContentLayout>
      </main>
    </>
  );
}
