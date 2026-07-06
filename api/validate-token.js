// api/validate-token.js — Module quản lý token xác thực
// Dùng HMAC-signed token (stateless) thay vì in-memory Map
// Mỗi Vercel serverless function instance có thể verify token độc lập
// không cần shared memory.

const crypto = require('crypto');

// Secret key để ký token — đọc từ env hoặc derive từ DASHBOARD_PASSWORD
function getSecret() {
  const secret = process.env.TOKEN_SECRET || process.env.DASHBOARD_PASSWORD;
  if (!secret) throw new Error('TOKEN_SECRET or DASHBOARD_PASSWORD env var required');
  return secret;
}

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 giờ

/**
 * Tạo signed token mới
 * Token format: base64(payload).base64(hmac_signature)
 * Payload chứa timestamp tạo token
 * @returns {string} signed token
 */
function createToken() {
  const payload = JSON.stringify({ iat: Date.now() });
  const payloadB64 = Buffer.from(payload).toString('base64url');
  
  const hmac = crypto.createHmac('sha256', getSecret());
  hmac.update(payloadB64);
  const signature = hmac.digest('base64url');
  
  return `${payloadB64}.${signature}`;
}

/**
 * Kiểm tra token có hợp lệ không (stateless — không cần shared memory)
 * @param {string} token 
 * @returns {boolean}
 */
function validateToken(token) {
  if (!token || typeof token !== 'string') return false;
  
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  
  const [payloadB64, signature] = parts;
  
  // Verify HMAC signature
  try {
    const hmac = crypto.createHmac('sha256', getSecret());
    hmac.update(payloadB64);
    const expectedSig = hmac.digest('base64url');
    
    // Timing-safe comparison
    if (!timingSafeCompare(signature, expectedSig)) return false;
    
    // Parse payload & check expiry
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
    const age = Date.now() - payload.iat;
    
    if (age < 0 || age > TOKEN_TTL_MS) return false;
    
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Timing-safe string comparison
 */
function timingSafeCompare(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  
  if (bufA.length !== bufB.length) {
    const padded = Buffer.alloc(bufB.length);
    bufA.copy(padded);
    crypto.timingSafeEqual(padded, bufB);
    return false;
  }
  
  return crypto.timingSafeEqual(bufA, bufB);
}

// Backward compatibility exports
function storeToken(token) {
  // No-op: tokens are now stateless (self-contained signed tokens)
  // This function exists only for backward compatibility with verify.js
}

function removeToken(token) {
  // No-op: stateless tokens can't be revoked individually
  // Token will naturally expire after TTL
}

module.exports = { createToken, validateToken, storeToken, removeToken };
