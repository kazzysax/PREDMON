import './polyfill';
import '@fontsource/geist-sans/700';
import '@fontsource/geist-sans/400';
import '@fontsource/geist-sans/500';
import '@fontsource/geist-sans/600';
import './styles.css';
import React, { Suspense } from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PREVIEW } from './mock';

// Preview mode never loads the sign-in SDK, so it runs with no keys at all.
const Root = React.lazy(() => (PREVIEW ? import('./Preview') : import('./App')));
const queryClient = new QueryClient();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <Suspense fallback={null}><Root /></Suspense>
  </QueryClientProvider>,
);
