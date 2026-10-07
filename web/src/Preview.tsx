// Preview mode (?preview): the whole interface on sample data, no sign-in.
// ?preview=signin and ?preview=username show those two screens.
import { AppCtx } from './ctx';
import { mockConfig, mockMe } from './mock';
import { Shell } from './Shell';
import { SignIn } from './screens/SignIn';
import { Username } from './screens/Username';

export default function Preview() {
  const q = new URLSearchParams(window.location.search);
  const which = q.get('preview');
  if (which === 'signin') return <SignIn preview />;
  if (which === 'username') return <Username onDone={() => {}} />;
  return (
    <AppCtx.Provider value={{
      config: mockConfig as any, me: mockMe, account: { address: mockMe.wallet }, reloadMe: async () => {},
      hasX: true, linkX: () => {}, signOut: () => {}, preview: { balance: '1284.5' },
    }}>
      <Shell initialTab={(q.get('tab') as any) ?? 'calls'} initialCompose={q.has('compose')} />
    </AppCtx.Provider>
  );
}
