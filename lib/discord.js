'use strict';
// Discord OAuth2 + guild membership verification.
//   AUTH_MODE=xapi → real Discord OAuth2 (needs DC_CLIENT_ID/SECRET)
//   AUTH_MODE=mock → local mock (no keys needed)
// Real flow:
//   authorize?client_id&redirect_uri&response_type=code&scope=identify%20guilds
//   token exchange → GET /users/@me/guilds → check guild id membership.
const fetch = require('node-fetch');

const AUTH_BASE = 'https://discord.com/oauth2/authorize';
const TOKEN_URL = 'https://discord.com/api/oauth2/token';
const API_BASE = 'https://discord.com/api';

const cfg = {
  clientId: process.env.DC_CLIENT_ID || '',
  clientSecret: process.env.DC_CLIENT_SECRET || '',
  redirectUri: process.env.DC_REDIRECT_URI || `${process.env.BASE_URL || 'http://localhost:3000'}/auth/dc/callback`,
  mock: !process.env.DC_CLIENT_ID,
};

function buildAuthorizeUrl() {
  if (cfg.mock) return `/auth/dc/mock?code=testcode&state=mockstate`;
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: 'code',
    scope: 'identify guilds',
    prompt: 'consent',
  }).toString();
  return `${AUTH_BASE}?${params}`;
}

async function exchangeCode(code) {
  if (cfg.mock) {
    return {
      dc_user_id: 'mock_dc_123',
      dc_username: 'mock_user',
      dc_access_token: 'mock-dc-token',
      dc_guilds: [{ id: 'mock_guild_1', name: 'Mock Server', member: true }],
    };
  }
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: cfg.redirectUri,
  });
  const res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const data = await res.json();
  if (!data.access_token) throw new Error('Discord token exchange failed: ' + JSON.stringify(data));
  const [me, guilds] = await Promise.all([
    fetch(`${API_BASE}/users/@me`, { headers: { Authorization: `Bearer ${data.access_token}` } }).then(r => r.json()),
    fetch(`${API_BASE}/users/@me/guilds`, { headers: { Authorization: `Bearer ${data.access_token}` } }).then(r => r.json()),
  ]);
  return {
    dc_user_id: me.id,
    dc_username: me.username,
    dc_access_token: data.access_token,
    dc_guilds: (guilds || []).map(g => ({ id: g.id, name: g.name, member: true })),
  };
}

function isMember(guilds, targetGuildId) {
  if (!targetGuildId) return true; // no guild requirement
  return (guilds || []).some(g => g.id === targetGuildId);
}

module.exports = { cfg, buildAuthorizeUrl, exchangeCode, isMember };
