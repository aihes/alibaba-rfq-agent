import { createRemoteJWKSet, jwtVerify } from 'jose';
import { ApiError } from './service.js';
const keySets = new Map();
export async function requireAccessAdmin(request, env, keyOverride) {
  const issuer = env.ACCESS_TEAM_DOMAIN;
  const emails = (env.ADMIN_EMAILS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer || '') || !env.ACCESS_AUD || !emails.length) {
    throw new ApiError(503, 'admin_access_unconfigured');
  }
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) throw new ApiError(401, 'admin_login_required');
  let payload;
  try {
    if (!keyOverride && !keySets.has(issuer)) keySets.set(issuer, createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)));
    ({ payload } = await jwtVerify(token, keyOverride || keySets.get(issuer), {
      issuer, audience: env.ACCESS_AUD, algorithms: ['RS256'], requiredClaims: ['exp', 'iat', 'sub', 'email']
    }));
  } catch { throw new ApiError(401, 'admin_login_required'); }
  if (typeof payload.email !== 'string' || !emails.includes(payload.email.toLowerCase())) throw new ApiError(403, 'admin_forbidden');
  if (!['GET', 'HEAD'].includes(request.method)) {
    if (request.headers.get('Origin') !== new URL(request.url).origin || request.headers.get('X-RFQ-Admin') !== '1') {
      throw new ApiError(403, 'admin_origin_rejected');
    }
  }
  return payload.email;
}
export function clientConfig(body) {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const agent = body.daily_agent_limit, ocr = body.daily_ocr_limit;
  if (!name || name.length > 64 || !Number.isInteger(agent) || agent < 1 || agent > 500 ||
      !Number.isInteger(ocr) || ocr < 1 || ocr > 2000) throw new ApiError(400, 'invalid_client_config');
  return { name, agent, ocr };
}
export function publicClient(record, day = new Date().toISOString().slice(0, 10)) {
  return { id: record.id, name: record.name, revoked: record.revoked, createdAt: record.createdAt,
    daily_agent_limit: record.dailyAgentLimit, daily_ocr_limit: record.dailyOcrLimit,
    usage: { day, agent: record.usage?.day === day ? record.usage.agent : 0,
      ocr: record.usage?.day === day ? record.usage.ocr : 0 } };
}
