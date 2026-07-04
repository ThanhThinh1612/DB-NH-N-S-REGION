// api/verify.js — Vercel Serverless Function
// Xác thực mật khẩu và cấp token phiên
// Sửa lỗi: C1 (hardcoded passcode), M2 (sessionStorage auth không có server validation)
// Tuân thủ security-rules.md: rate-limit, timing-safe compare, Origin validation

const { storeToken } = require('./validate-token');

// ============================================================
// RATE LIMITING — Brute-force protection (security-rules.md: "account lockout or backoff")
// 5 lần sai trong 15 phút → khóa IP 15 phút
// ============================================================
const loginAttempts = new Map(); // Map<ip, { count, firstAttempt }>
const MAX_ATTEMPTS = 5;
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000; // 15 phút

function isLoginRateLimited(ip) {
  const now = Date.now();
  
  // Dọn dẹp entries cũ
  for (const [key, entry] of loginAttempts.entries()) {
    if (now - entry.firstAttempt > LOCKOUT_WINDOW_MS) {
      loginAttempts.delete(key);
    }
  }

  const entry = loginAttempts.get(ip);
  if (!entry) return false;
  
  if (now - entry.firstAttempt > LOCKOUT_WINDOW_MS) {
    loginAttempts.delete(ip);
    return false;
  }

  return entry.count >= MAX_ATTEMPTS;
}

function recordFailedAttempt(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  
  if (!entry || now - entry.firstAttempt > LOCKOUT_WINDOW_MS) {
    loginAttempts.set(ip, { count: 1, firstAttempt: now });
  } else {
    entry.count++;
  }
}

function clearAttempts(ip) {
  loginAttempts.delete(ip);
}

// ============================================================
// MAIN HANDLER
// ============================================================
module.exports = (req, res) => {
  // Chỉ cho phép POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Origin validation — chống CSRF (security-rules.md: "Validate Origin or Referer")
  const allowedOrigins = [
    'https://db-nh-n-s-region.vercel.app',
    'http://localhost:3000',
    'http://localhost:5000',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:5000'
  ];
  const origin = req.headers.origin || req.headers.referer || '';
  const originHost = origin.replace(/\/+$/, '');
  
  // Cho phép request không có Origin (e.g., curl test từ server)
  // nhưng nếu có Origin thì phải nằm trong whitelist
  if (origin && !allowedOrigins.some(o => originHost.startsWith(o))) {
    return res.status(403).json({ error: 'Origin không được phép' });
  }

  // Rate limiting — chống brute-force
  const clientIP = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || 'unknown';
  if (isLoginRateLimited(clientIP)) {
    const remainingSeconds = Math.ceil(LOCKOUT_WINDOW_MS / 1000);
    res.setHeader('Retry-After', String(remainingSeconds));
    return res.status(429).json({ 
      error: `Quá nhiều lần đăng nhập sai. Vui lòng thử lại sau ${Math.ceil(LOCKOUT_WINDOW_MS / 60000)} phút.` 
    });
  }

  const { password } = req.body || {};
  const correctPassword = process.env.DASHBOARD_PASSWORD;

  // Kiểm tra server đã cấu hình mật khẩu chưa
  if (!correctPassword) {
    return res.status(500).json({ error: 'Chưa cấu hình mật khẩu trên server' });
  }

  // So sánh mật khẩu — dùng timing-safe compare để chống timing attacks
  if (password && timingSafeEqual(password, correctPassword)) {
    // Đăng nhập thành công — xóa record brute-force
    clearAttempts(clientIP);

    // Tạo token ngẫu nhiên cho session
    const crypto = require('crypto');
    const token = crypto.randomBytes(32).toString('hex');
    
    // Lưu token vào store với TTL
    storeToken(token);

    return res.status(200).json({ success: true, token });
  }

  // Đăng nhập thất bại — ghi nhận
  recordFailedAttempt(clientIP);

  return res.status(401).json({ error: 'Mật khẩu không đúng' });
};

/**
 * So sánh 2 chuỗi theo cách timing-safe (chống timing attack)
 * @param {string} a 
 * @param {string} b 
 * @returns {boolean}
 */
function timingSafeEqual(a, b) {
  const crypto = require('crypto');
  
  // Đảm bảo cùng độ dài để crypto.timingSafeEqual hoạt động
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  
  if (bufA.length !== bufB.length) {
    // Vẫn phải chạy compare để không leak timing info về length
    const bufPadded = Buffer.alloc(bufB.length);
    bufA.copy(bufPadded);
    crypto.timingSafeEqual(bufPadded, bufB);
    return false;
  }
  
  return crypto.timingSafeEqual(bufA, bufB);
}
