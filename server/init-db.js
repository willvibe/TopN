// 数据库初始化脚本：执行 schema.sql
// 用法: node server/init-db.js   (需配置环境变量, 见 .env.example)
// Windows cmd:  set DB_HOST=... & set DB_PASSWORD=... & node server/init-db.js
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const SQL = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

(async () => {
  // 不指定 database，先连上服务器执行 schema（里面含 CREATE DATABASE）
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    multipleStatements: true,
    charset: 'utf8mb4',
  });

  try {
    // 直接整段执行 (multipleStatements 已开启)
    await conn.query(SQL);
    console.log('✅ 数据库初始化完成 (TopN)，所有表已就绪');

    // ---- 幂等迁移：对已存在的表补充新增字段（CREATE TABLE IF NOT EXISTS 不会改老表） ----
    const migrations = [
      {
        table: 'judges',
        column: 'level',
        ddl: `ALTER TABLE judges
                ADD COLUMN level ENUM('expert','senior','normal') NOT NULL DEFAULT 'normal'`,
      },
      {
        table: 'judges',
        column: 'weight',
        ddl: `ALTER TABLE judges
                ADD COLUMN weight DECIMAL(3,2) NOT NULL DEFAULT 1.00`,
      },
      {
        table: 'competitions',
        column: 'expert_token',
        ddl: `ALTER TABLE competitions ADD COLUMN expert_token VARCHAR(64) UNIQUE`,
      },
      {
        table: 'competitions',
        column: 'senior_token',
        ddl: `ALTER TABLE competitions ADD COLUMN senior_token VARCHAR(64) UNIQUE`,
      },
      {
        table: 'competitions',
        column: 'normal_token',
        ddl: `ALTER TABLE competitions ADD COLUMN normal_token VARCHAR(64) UNIQUE`,
      },
      {
        table: 'competitions',
        column: 'name_subtitle',
        ddl: `ALTER TABLE competitions ADD COLUMN name_subtitle VARCHAR(200) DEFAULT ''`,
      },
    ];
    for (const m of migrations) {
      const [cols] = await conn.query(
        `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND COLUMN_NAME=?`,
        [process.env.DB_NAME || 'TopN', m.table, m.column]
      );
      if (cols[0].c === 0) {
        await conn.query(m.ddl);
        console.log(`  ↳ 迁移: ${m.table}.${m.column} 已添加`);
      }
    }

    // 列出表
    const dbName = process.env.DB_NAME || 'TopN';
    const [tables] = await conn.query(`SHOW TABLES FROM \`${dbName}\``);
    console.log('   表清单:');
    for (const t of tables) {
      const name = Object.values(t)[0];
      console.log('     -', name);
    }
  } catch (e) {
    console.error('\n❌ 初始化失败:', e.message);
    process.exit(1);
  } finally {
    await conn.end();
  }
})();
