// api/validate-token.js — Module quản lý token xác thực
// Dùng in-memory Map với TTL. Được chia sẻ giữa verify.js, data.js, telegram.js
//
// Lưu ý: Trên Vercel Serverless, mỗi instance có bộ nhớ riêng.
// Token có thể bị invalidate khi function cold-start.
// Đây là trade-off chấp nhận được cho use case nội bộ.
// Nếu cần persistence, chuyển sang Vercel KV hoặc Redis.

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 giờ

// Token store: Map<token_string, { createdAt: number }>
const tokenStore = new Map();

/**
 * Lưu token mới vào store
 * @param {string} token 
 */
function storeToken(token) {
  // Dọn dẹp token hết hạn trước khi thêm mới
  cleanExpiredTokens();
  tokenStore.set(token, { createdAt: Date.now() });
}

/**
 * Kiểm tra token có hợp lệ không
 * @param {string} token 
 * @returns {boolean}
 */
function validateToken(token) {
  if (!token || !tokenStore.has(token)) return false;

  const entry = tokenStore.get(token);
  const age = Date.now() - entry.createdAt;

  if (age > TOKEN_TTL_MS) {
    // Token hết hạn — xóa khỏi store
    tokenStore.delete(token);
    return false;
  }

  return true;
}

/**
 * Xóa token (dùng khi logout)
 * @param {string} token 
 */
function removeToken(token) {
  tokenStore.delete(token);
}

/**
 * Dọn dẹp các token đã hết hạn
 */
function cleanExpiredTokens() {
  const now = Date.now();
  for (const [token, entry] of tokenStore.entries()) {
    if (now - entry.createdAt > TOKEN_TTL_MS) {
      tokenStore.delete(token);
    }
  }
}

module.exports = { storeToken, validateToken, removeToken };
