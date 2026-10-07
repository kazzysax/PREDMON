// Verifies the token the app gets from Dynamic. Nothing the client says about
// who it is can be trusted; everything comes from the verified token.
import { createRemoteJWKSet, jwtVerify } from 'jose';

export function dynamicVerifier(environmentId) {
  if (!environmentId) throw new Error('DYNAMIC_ENVIRONMENT_ID is not set');
  const jwks = createRemoteJWKSet(
    new URL(`https://app.dynamicauth.com/api/v0/sdk/${environmentId}/.well-known/jwks`));
  return async function verify(token) {
    const { payload } = await jwtVerify(token, jwks, { algorithms: ['RS256'] });
    // A token that still needs a second factor carries a restricted scope list.
    const scopes = String(payload.scope ?? '').split(' ');
    if (!scopes.includes('user:basic')) throw new Error('token lacks user:basic scope');
    if (payload.environment_id && payload.environment_id !== environmentId) throw new Error('wrong environment');
    return normalizeClaims(payload);
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
  };
}

export async function authenticate(req, verify) {
  const h = req.headers.authorization ?? '';
  if (!h.startsWith('Bearer ')) throw httpError(401, 'sign in first');
  try { return await verify(h.slice(7)); } catch (e) { throw httpError(401, `bad token: ${e.message}`); }
}

export function httpError(status, message) { return Object.assign(new Error(message), { status }); }
