// Verifies the token the app gets from Dynamic. Nothing the client says about
// who it is can be trusted; everything comes from the verified token.
import { createRemoteJWKSet, jwtVerify } from 'jose';

export function dynamicVerifier(environmentId, fetchImpl = fetch) {
  if (!environmentId) throw new Error('DYNAMIC_ENVIRONMENT_ID is not set');
  const jwks = createRemoteJWKSet(
    new URL(`https://app.dynamicauth.com/api/v0/sdk/${environmentId}/.well-known/jwks`));
  return async function verify(token) {
    const { payload } = await jwtVerify(token, jwks, { algorithms: ['RS256'] });
    // A token that still needs a second factor carries a restricted scope list.
    const scopes = String(payload.scope ?? '').split(' ');
    if (!scopes.includes('user:basic')) throw new Error('token lacks user:basic scope');
    if (payload.environment_id && payload.environment_id !== environmentId) throw new Error('wrong environment');
    // A "minified" token carries only a hash of the credentials. The token is already verified above,
    // so ask Dynamic for this user's credentials with it; the answer comes straight from Dynamic.
    if (!Array.isArray(payload.verified_credentials)) {
      const res = await fetchImpl(`https://app.dynamicauth.com/api/v0/sdk/${environmentId}/me`, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`could not read the account from Dynamic (${res.status})`);
      const me = await res.json();
      const user = me.user ?? me;
      if (user.id && String(user.id) !== String(payload.sub)) throw new Error('account does not match the token');
      payload.verified_credentials = (user.verifiedCredentials ?? user.verified_credentials ?? []).map(c => ({
        ...c,
        wallet_provider: c.wallet_provider ?? c.walletProvider ?? c.walletName,
        oauth_provider: c.oauth_provider ?? c.oauthProvider,
        oauth_username: c.oauth_username ?? c.oauthUsername ?? c.oauthDisplayName,
        oauth_display_name: c.oauth_display_name ?? c.oauthDisplayName,
      }));
    }
    const n = normalizeClaims(payload);
    if (!n.wallets.length) console.log('no wallet in credentials; shapes', JSON.stringify((payload.verified_credentials ?? []).map(c => ({ format: c.format, chain: c.chain ?? null, provider: c.wallet_provider ?? null, keys: Object.keys(c).slice(0, 14) }))));
    return n;
  };
}

/** Pulls the fields we use out of Dynamic's claims. */
export function normalizeClaims(p) {
  const creds = Array.isArray(p.verified_credentials) ? p.verified_credentials : [];
  const wallets = creds
    .filter(c => c.format === 'blockchain' && /^0x[0-9a-fA-F]{40}$/.test(c.address ?? '') && (!c.chain || c.chain === 'eip155'))
    .map(c => ({ address: c.address.toLowerCase(), embedded: /embedded|waas|dynamic/i.test(c.wallet_provider ?? c.walletName ?? '') }));
  const x = creds.find(c => c.format === 'oauth' && c.oauth_provider === 'twitter');
  return {
    userId: String(p.sub),
    email: p.email ?? null,
    wallets,
    xUsername: x?.oauth_username ?? x?.oauth_display_name ?? null,
    debug: creds.map(c => ({ format: c.format, chain: c.chain ?? null, provider: c.wallet_provider ?? c.walletName ?? null })),
  };
}

export async function authenticate(req, verify) {
  const h = req.headers.authorization ?? '';
  if (!h.startsWith('Bearer ')) throw httpError(401, 'sign in first');
  try { return await verify(h.slice(7)); } catch (e) { throw httpError(401, `bad token: ${e.message}`); }
}

export function httpError(status, message) { return Object.assign(new Error(message), { status }); }
