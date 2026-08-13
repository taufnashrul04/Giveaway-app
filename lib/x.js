'use strict';
// X (Twitter) OAuth2 (PKCE) + follower verification.
//   X_CLIENT_ID set → real X OAuth2 (connect user account — FREE)
//   X_CLIENT_ID empty → mock (local demo)
// PKCE verifier is stored in a SIGNED COOKIE (not in-memory) so the callback
// survives across Vercel lambda instances / cold starts.
// Follower check (X_VERIFY_MODE=xapi) uses X API v2 follows.read (PAID ~$100/mo);
// default GiveFuel uses honor system (free) — see server.js.
const fetch = require('node-fetch');
const crypto = require('crypto');

const PROVIDER_BASE = 'https://api.x.com/2';
const AUTH_BASE = 'https://x.com/i/oauth2/authorize';
const TOKEN_URL = 'https://api.x.com/2/oauth2/token';

const cfg = {
  clientId: process.env.X_CLIENT_ID || '',
  clientSecret: process.env.X_CLIENT_SECRET || '',
  redirectUri: process.env.X_REDIRECT_URI || `${process.env.BASE_URL || 'http://localhost:3000'}/auth/x/callback`,
  mock: !process.env.X_CLIENT_ID,
};

const SECRET = process.env.SESSION_SECRET || 'givefuel-dev-secret';
const VERIFIER_COOKIE = 'gf_x_verifier';

// PKCE helpers
function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function randomString(n = 43) {
  return base64url(crypto.randomBytes(n));
}
function sha256(s) {
  return crypto.createHash('sha256').update(s).digest();
}
function signVerifier(state, verifier) {
  const payload = Buffer.from(JSON.stringify({ state, verifier, exp: Date.now() + 10 * 60 * 1000 })).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
function verifyVerifier(token, state) {
  if (!token) return '';
  const idx = token.lastIndexOf('.');
  if (idx === -1) return '';
  const payload = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expected = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return '';
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (data.exp < Date.now() || data.state !== state) return '';
    return data.verifier;
  } catch (e) { return ''; }
}

function buildAuthorizeUrl(res) {
  if (cfg.mock) return `/auth/x/mock?code=testcode&state=mockstate`;
  const state = randomString(32);
  const verifier = randomString(43);
  const code_challenge = base64url(sha256(verifier));
  const scope = encodeURIComponent('tweet.read users.read offline.access');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    scope,
    state,
    code_challenge,
    code_challenge_method: 'S256',
  }).toString();
  // store verifier in signed cookie (serverless-safe)
  res.cookie(VERIFIER_COOKIE, signVerifier(state, verifier), {
    httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax',
    maxAge: 10 * 60 * 1000, path: '/',
  });
  return `${AUTH_BASE}?${params}`;
}

async function exchangeCode(code, state, req, res) {
  if (cfg.mock) {
    return {
      x_user_id: 'mock_user_123',
      x_username: 'mock_user',
      x_access_token: 'mock-access-token',
    };
  }
  const verifier = verifyVerifier(req.cookies[VERIFIER_COOKIE], state);
  if (!verifier) throw new Error('PKCE verifier missing/expired — please retry login');
  const body = new URLSearchParams({
    code,
    grant_type: 'authorization_code',
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    code_verifier: verifier,
  });
  const res2 = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64'),
    },
    body,
  });
  const data = await res2.json();
  if (!data.access_token) throw new Error('X token exchange failed: ' + JSON.stringify(data));
  // fetch /2/users/me
  const me = await fetch(`${PROVIDER_BASE}/users/me?user.fields=username,name`, {
    headers: { Authorization: `Bearer ${data.access_token}` },
  }).then(r => r.json());
  // clear verifier cookie
  res.clearCookie(VERIFIER_COOKIE, { path: '/' });
  return {
    x_user_id: me.data?.id,
    x_username: me.data?.username,
    x_access_token: data.access_token,
  };
}

// Check whether user (by their x access token) follows target @handle (X API v2, paid).
async function checkFollow(accessToken, targetHandle) {
  if (cfg.mock) return true;
  const handle = targetHandle.replace(/^@/, '');
  const tgt = await fetch(`${PROVIDER_BASE}/users/by/username/${handle}?user.fields=id`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  }).then(r => r.json());
  if (!tgt.data?.id) return false;
  const targetId = tgt.data.id;
  let pagination_token = undefined;
  for (let page = 0; page < 10; page++) {
    let url = `${PROVIDER_BASE}/users/me/following?max_results=1000${pagination_token ? '&pagination_token=' + pagination_token : ''}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    const data = await res.json();
    const ids = (data.data || []).map(u => u.id);
    if (ids.includes(targetId)) return true;
    pagination_token = data.meta?.next_token;
    if (!pagination_token) break;
  }
  return false;
}

module.exports = { cfg, buildAuthorizeUrl, exchangeCode, checkFollow };
