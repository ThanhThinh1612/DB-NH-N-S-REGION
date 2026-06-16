module.exports = (req, res) => {
  // Chỉ cho phép POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { password } = req.body || {};
  const correctPassword = process.env.DASHBOARD_PASSWORD;

  // Kiểm tra server đã cấu hình mật khẩu chưa
  if (!correctPassword) {
    return res.status(500).json({ error: 'Chưa cấu hình mật khẩu trên server' });
  }

  // So sánh mật khẩu
  if (password && password === correctPassword) {
    // Tạo token ngẫu nhiên cho session
    const crypto = require('crypto');
    const token = crypto.randomBytes(32).toString('hex');
    return res.status(200).json({ success: true, token });
  }

  return res.status(401).json({ error: 'Mật khẩu không đúng' });
};
