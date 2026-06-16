// api/telegram.js — Vercel Serverless Function
// Gửi thông báo Top 10 Bưu cục nghỉ nhiều nhất + Top 10 Cảnh báo rủi ro qua Telegram

module.exports = async (req, res) => {
  // Cho phép cả GET (từ cron) và POST (từ nút bấm)
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Xác thực cron secret (nếu có) hoặc cho phép gọi trực tiếp
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers.authorization !== `Bearer ${cronSecret}`) {
    // Nếu không phải cron request hợp lệ, kiểm tra có phải từ UI không
    const isManualTrigger = req.method === 'POST';
    if (!isManualTrigger) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

  if (!BOT_TOKEN || !CHAT_ID) {
    return res.status(500).json({
      error: 'Chưa cấu hình TELEGRAM_BOT_TOKEN hoặc TELEGRAM_CHAT_ID trên Vercel'
    });
  }

  try {
    // 1. Fetch dữ liệu từ Google Sheets — sheet "Theo bưu cục"
    const SHEET_ID = '1bc-sCXqlvmRV_j2uGTxUH7sGICDyVqSCVf-kgLg_Apk';
    const sheetData = await fetchGoogleSheet(SHEET_ID, 'Theo bưu cục');
    const postOffices = parsePostOfficeData(sheetData);

    if (postOffices.length === 0) {
      return res.status(500).json({ error: 'Không có dữ liệu bưu cục' });
    }

    // 2. Lấy ngày cập nhật từ label
    const updateDate = extractUpdateDate(sheetData);

    // 3. Tính toán Top 10
    const top7 = getTopByField(postOffices, 'nghi_7', 10);
    const top14 = getTopByField(postOffices, 'nghi_14', 10);
    const top30 = getTopByField(postOffices, 'nghi_30', 10);

    // 4. Tính điểm rủi ro & Top 10
    const riskTop = postOffices.map(item => ({
      ...item,
      score: calculateRiskScore(item)
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

    // 5. Format message
    const message = formatTelegramMessage(updateDate, top7, top14, top30, riskTop);

    // 6. Gửi qua Telegram (chia nhỏ nếu message quá dài)
    const messages = splitMessage(message, 4000);
    for (const msg of messages) {
      await sendTelegramMessage(BOT_TOKEN, CHAT_ID, msg);
      // Delay 500ms giữa các tin nhắn để tránh rate limit
      if (messages.length > 1) {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    return res.status(200).json({
      success: true,
      message: `Đã gửi ${messages.length} tin nhắn Telegram thành công`,
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    console.error('Telegram API error:', err);
    return res.status(500).json({
      error: 'Lỗi khi gửi thông báo Telegram',
      detail: err.message
    });
  }
};

// ============================================================
// HELPERS
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

function getStr(row, idx, fallback = '') {
  if (!row || !row.c || !row.c[idx]) return fallback;
  const val = row.c[idx].v;
  return val !== null && val !== undefined ? String(val).trim() : fallback;
}

function getNum(row, idx, fallback = 0) {
  if (!row || !row.c || !row.c[idx]) return fallback;
  const val = row.c[idx].v;
  if (typeof val === 'number') return val;
  if (val === null || val === undefined) return fallback;
  const parsed = Number(val);
  return isNaN(parsed) ? fallback : parsed;
}

function extractUpdateDate(json) {
  try {
    if (json && json.table && json.table.cols && json.table.cols[0]) {
      const label = json.table.cols[0].label || '';
      const match = label.match(/\d{2}\/\d{2}\/\d{4}/);
      if (match) return match[0];
    }
  } catch (e) { /* ignore */ }

  // Fallback: ngày hiện tại
  const now = new Date();
  const dd = String(now.getDate()).padStart(2, '0');
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const yyyy = now.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function parsePostOfficeData(json) {
  return json.table.rows.filter(row => {
    const bc = getStr(row, 1);
    return bc && bc !== 'Bưu cục' && bc !== '';
  }).map(row => ({
    vung: getStr(row, 0),
    name: getStr(row, 1),
    nghi_7: getNum(row, 16),
    nghi_14: getNum(row, 17),
    nghi_30: getNum(row, 18),
    tuyen_7: getNum(row, 13),
    tuyen_14: getNum(row, 14),
    tuyen_30: getNum(row, 15),
    nv_duoi_3: getNum(row, 19),
    nv_tren_3: getNum(row, 20),
    pct_tren_3: getNum(row, 21),
    ns_duoi_3: getNum(row, 11),
    ns_tren_3: getNum(row, 12),
    slnv_ht: getNum(row, 22),
    dinh_bien: getNum(row, 23),
    so_thieu: getNum(row, 24)
  }));
}

function getTopByField(data, field, limit) {
  return [...data]
    .sort((a, b) => (b[field] || 0) - (a[field] || 0))
    .slice(0, limit);
}

function calculateRiskScore(item) {
  const tong_nv = item.slnv_ht || 0;
  const nghi_30 = item.nghi_30 || 0;
  const so_thieu = item.so_thieu || 0;
  const dinh_bien = item.dinh_bien || 0;
  const ty_le_tren3 = typeof item.pct_tren_3 === 'number' ? item.pct_tren_3 : 0;

  const term1 = tong_nv > 0 ? (nghi_30 / tong_nv * 40) : 0;
  const term2 = dinh_bien > 0 ? (Math.max(so_thieu, 0) / dinh_bien * 30) : 0;
  const term3 = (1 - ty_le_tren3) * 30;

  return term1 + term2 + term3;
}

function getRiskEmoji(score) {
  if (score >= 60) return '🔴';
  if (score >= 40) return '🟠';
  return '🟡';
}

function getRiskLabel(score) {
  if (score >= 60) return 'Nguy hiểm';
  if (score >= 40) return 'Cần theo dõi';
  return 'Chú ý';
}

function formatNumber(val) {
  if (val === null || val === undefined) return '0';
  return Math.round(val).toLocaleString('vi-VN');
}

function formatPercentNoDec(val) {
  if (val === null || val === undefined) return '-';
  return Math.round(val * 100) + '%';
}

function formatTelegramMessage(updateDate, top7, top14, top30, riskTop) {
  let msg = '';

  // Header
  msg += `📊 <b>BÁO CÁO NHÂN SỰ — ${updateDate}</b>\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

  // Top 10 Nghỉ nhiều nhất
  msg += `🔴 <b>TOP 10 BƯU CỤC NGHỈ NHIỀU NHẤT</b>\n\n`;

  // 7 ngày
  msg += `▸ <b>7 ngày gần nhất:</b>\n`;
  top7.forEach((item, i) => {
    const net = (item.tuyen_7 || 0) - (item.nghi_7 || 0);
    const netStr = net >= 0 ? `+${formatNumber(net)}` : formatNumber(net);
    msg += `  ${i + 1}. ${item.name} — <b>${formatNumber(item.nghi_7)}</b> nghỉ (net: ${netStr})\n`;
  });
  msg += '\n';

  // 14 ngày
  msg += `▸ <b>14 ngày gần nhất:</b>\n`;
  top14.forEach((item, i) => {
    const net = (item.tuyen_14 || 0) - (item.nghi_14 || 0);
    const netStr = net >= 0 ? `+${formatNumber(net)}` : formatNumber(net);
    msg += `  ${i + 1}. ${item.name} — <b>${formatNumber(item.nghi_14)}</b> nghỉ (net: ${netStr})\n`;
  });
  msg += '\n';

  // 30 ngày
  msg += `▸ <b>30 ngày gần nhất:</b>\n`;
  top30.forEach((item, i) => {
    const net = (item.tuyen_30 || 0) - (item.nghi_30 || 0);
    const netStr = net >= 0 ? `+${formatNumber(net)}` : formatNumber(net);
    msg += `  ${i + 1}. ${item.name} — <b>${formatNumber(item.nghi_30)}</b> nghỉ (net: ${netStr})\n`;
  });

  msg += `\n━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

  // Top 10 Cảnh báo rủi ro
  msg += `⚠️ <b>TOP 10 BƯU CỤC CẢNH BÁO RỦI RO</b>\n\n`;

  riskTop.forEach((item, i) => {
    const emoji = getRiskEmoji(item.score);
    const label = getRiskLabel(item.score);
    msg += `  ${i + 1}. ${emoji} <b>${item.name}</b> (${item.vung})\n`;
    msg += `     Điểm: <b>${item.score.toFixed(1)}</b> — ${label}\n`;
    msg += `     Nghỉ 30n: ${formatNumber(item.nghi_30)} | Thiếu: ${formatNumber(item.so_thieu)} | >3th: ${formatPercentNoDec(item.pct_tren_3)}\n`;
  });

  msg += `\n━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `🕐 Gửi lúc: ${new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}\n`;
  msg += `🔗 <a href="https://db-nh-n-s-region.vercel.app/">Xem Dashboard</a>`;

  return msg;
}

function splitMessage(text, maxLength) {
  if (text.length <= maxLength) return [text];

  const parts = [];
  const lines = text.split('\n');
  let current = '';

  for (const line of lines) {
    if ((current + '\n' + line).length > maxLength && current.length > 0) {
      parts.push(current.trim());
      current = line;
    } else {
      current += (current ? '\n' : '') + line;
    }
  }

  if (current.trim()) parts.push(current.trim());
  return parts;
}

async function sendTelegramMessage(botToken, chatId, text) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    })
  });

  const data = await response.json();

  if (!data.ok) {
    throw new Error(`Telegram API error: ${data.description || 'Unknown error'}`);
  }

  return data;
}
