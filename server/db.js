// 数据库连接池
// 连接信息通过环境变量配置 (见 .env.example), 避免硬编码凭证
const mysql = require('mysql2/promise');

const DB_CONFIG = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'TopN',
  charset: 'utf8mb4',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  // 支持 DECIMAL 直接返回 number
  decimalNumbers: true,
};

const pool = mysql.createPool(DB_CONFIG);

// 健康检查
async function ping() {
  const conn = await pool.getConnection();
  try {
    await conn.ping();
    return true;
  } finally {
    conn.release();
  }
}

module.exports = { pool, ping };
