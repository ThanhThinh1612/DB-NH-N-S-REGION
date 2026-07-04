// api/data.js — Vercel Serverless Function
// Proxy Google Sheets data qua server để ẩn Sheet ID và yêu cầu xác thực
// Sửa lỗi: C2 (Google Sheet public), H2 (PII exposure), L1 (Sheet ID lộ)
// Tuân thủ security-rules.md: auth gate, rate-limit, sheet whitelist (SSRF prevention)

const { validateToken } = require('./validate-token');

// Sheet ID chỉ tồn tại trên server — không bao giờ ship cho client
const SHEET_ID = process.env.GOOGLE_SHEET_ID || '1bc-sCXqlvmRV_j2uGTxUH7sGICDyVqSCVf-kgLg_Apk';

// Whitelist các sheet được phép truy cập
// security-rules.md: "Allowlist specific external resource identifiers on the server side"
const ALLOWED_SHEETS = ['Theo Vùng', 'Theo tỉnh', 'Theo bưu cục', 'Theo AM'];

// ============================================================
// RATE LIMITING — 30 requests/phút per IP
// security-rules.md: "Apply rate limiting to every public endpoint"
// ============================================================
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 phút
const MAX_REQUESTS = 30; // 4 sheets × ~5 refreshes = 20, cho buffer

function isRateLimited(ip) {
  const now = Date.now();
  
  // Dọn dẹp entries cũ
  for (const [key, entry] of rateLimitMap.entries()) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
      rateLimitMap.delete(key);
    }
  }

  const entry = rateLimitMap.get(ip);
  if (!entry) {
    rateLimitMap.set(ip, { count: 1, windowStart: now });
    return false;
  }

  if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(ip, { count: 1, windowStart: now });
    return false;
  }

  entry.count++;
  return entry.count > MAX_REQUESTS;
}

// ============================================================
// MAIN HANDLER
// ============================================================
module.exports = async (req, res) => {
  // Chỉ cho phép GET
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Xác thực token — security-rules.md: "Protect all API routes behind an authentication gate"
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Chưa xác thực. Vui lòng đăng nhập.' });
  }

  const token = authHeader.substring(7);
  if (!validateToken(token)) {
    return res.status(401).json({ error: 'Token không hợp lệ hoặc đã hết hạn. Vui lòng đăng nhập lại.' });
  }

  // Rate limiting
  const clientIP = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || 'unknown';
  if (isRateLimited(clientIP)) {
    res.setHeader('Retry-After', '60');
    return res.status(429).json({ error: 'Quá nhiều yêu cầu. Vui lòng đợi 1 phút.' });
  }

  // Lấy tên sheet từ query param
  const sheetName = req.query.sheet;
  if (!sheetName) {
    return res.status(400).json({ error: 'Thiếu tham số sheet' });
  }

  // Kiểm tra whitelist — security-rules.md: "Allowlist specific external resource identifiers"
  if (!ALLOWED_SHEETS.includes(sheetName)) {
    return res.status(400).json({ error: 'Sheet không hợp lệ' });
  }

  try {
    const data = await fetchGoogleSheet(SHEET_ID, sheetName);
    
    // Cache 60 giây để giảm tải
    res.setHeader('Cache-Control', 'private, max-age=60');
    return res.status(200).json(data);
  } catch (err) {
    // security-rules.md: "Never expose stack traces, internal error messages"
    console.error(`Lỗi fetch sheet "${sheetName}":`, err.message);
    return res.status(500).json({ error: `Lỗi khi tải dữ liệu từ sheet: ${sheetName}` });
  }
};

// ============================================================
// HELPER: Fetch Google Sheet data
// ============================================================
async function fetchGoogleSheet(sheetId, sheetName) {
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(sheetName)}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Google Sheets HTTP error: ${response.status}`);
    }

    const text = await response.text();
    const prefix = 'google.visualization.Query.setResponse(';
    const startIdx = text.indexOf(prefix);
    if (startIdx === -1) throw new Error('Invalid response format from Google Sheets');

    const jsonStr = text.substring(startIdx + prefix.length, text.lastIndexOf(')'));
    const data = JSON.parse(jsonStr);

    if (data && data.status === 'ok') return data;
    throw new Error('Google Sheets returned error status');
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') throw new Error('Google Sheets request timeout (15s)');
    throw err;
  }
}
