'use strict';
// X (Twitter) OAuth2 + follower verification.
// Supports two modes:
//   AUTH_MODE=xapi  — real X API v2 (needs X_CLIENT_ID/SECRET, ~$100/mo for meaningful use)
//   AUTH_MODE=mock  — local mock (no keys needed) — lets the platform run + be demoed free.
// Follower check via X API v2:
//   GET /2/users/{id}/following?max_results=1000&pagination_token=...
//   or /2/users/by/username/{handle}; then poll following list for target.
const fetch = require('node-fetch');

const PROVIDER_BASE = 'https://api.x.com/2';
const AUTH_BASE = 'https://x.com/i/oauth2/authorize';
const TOKEN_URL = 'https://api.x.com/2/oauth2/token';

// Configuration (env). If X_CLIENT_ID is missing → mock mode.
const cfg = {
  clientId: process.env.X_CLIENT_ID || '',
  clientSecret: process.env.X_CLIENT_SECRET || '',
  redirectUri: process.env.X_REDIRECT_URI || `${process.env.BASE_URL || 'http://localhost:3000'}/auth/x/callback`,
  mock: !process.env.X_CLIENT_ID,
};

// PKCE helpers
function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function randomString(n = 43) {
  const bytes = require('crypto').randomBytes(n);
  return base64url(bytes);
}
function sha256(s) {
  return require('crypto').createHash('sha256').update(s).digest();
}

function buildAuthorizeUrl() {
  if (cfg.mock) return `/auth/x/mock?code=testcode&state=mockstate`;
  const state = randomString(32);
  const verifier = randomString(43);
  const code_challenge = base64url(sha256(verifier));
  const scope = encodeURIComponent('tweet.read users.read follows.read offline.access');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    scope,
    state,
    code_challenge,
    code_challenge_method: 'S256',
  }).toString();
  // stash verifier per-state (in-memory; MVP). keyed by state
  global.__xpkce = global.__xpkce || {};
  global.__xpkce[state] = verifier;
  return `${AUTH_BASE}?${params}`;
}

async function exchangeCode(code, state) {
  if (cfg.mock) {
    return {
      x_user_id: 'mock_user_123',
      x_username: 'mock_user',
      x_access_token: 'mock-access-token',
    };
  }
  const verifier = (global.__xpkce || {})[state] || '';
  const body = new URLSearchParams({
    code,
    grant_type: 'authorization_code',
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    code_verifier: verifier,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64'),
    },
    body,
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('X token exchange failed: ' + JSON.stringify(data));
  // fetch /2/users/me
  const me = await fetch(`${PROVIDER_BASE}/users/me?user.fields=username,name`, {
    headers: { Authorization: `Bearer ${data.access_token}` },
  }).then(r => r.json());
  return {
    x_user_id: me.data?.id,
    x_username: me.data?.username,
    x_access_token: data.access_token,
  };
}

// Check whether user (by their x access token) follows target @handle.
async function checkFollow(accessToken, targetHandle) {
  if (cfg.mock) return true; // mock: assume followed (configurable via MOCK_FOLLOW)
  // 1. resolve target id
  const handle = targetHandle.replace(/^@/, '');
  const tgt = await fetch(`${PROVIDER_BASE}/users/by/username/${handle}?user.fields=id`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  }).then(r => r.json());
  if (!tgt.data?.id) return false;
  const targetId = tgt.data.id;
  // 2. paginate caller's following list looking for targetId
  let pagination_token = undefined;
  let nextCursor = null;
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
