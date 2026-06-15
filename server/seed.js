// 生成样例大赛: 6 组作品 + 3 个评分标准(权重配平100%) + 7 位评委(含等级)
// 用法: node server/seed.js
const crypto = require('crypto');
const { pool } = require('./db');
const token = () => crypto.randomBytes(16).toString('hex');

const SAMPLE = {
  name: '2026 全球未来科技创新大赛 · 决赛现场',
  description: '样例大赛 —— 演示 TopN 评分系统全流程',
  works: [
    { name: 'Aetherium 超导超级环', team: '极速磁弦实验室', category: '量子交通', description: '超低温量子轨道磁阻消融技术，引领陆地飞行新纪元。' },
    { name: 'NeuraLink 仿生脑机芯片 Pro', team: '灵境认知科研所', category: '脑机计算', description: '十万通道微创式高带宽电极集成方案，破译多脑区并行算力。' },
    { name: 'Helios 微型聚变反应堆', team: '核聚未来极客空间', category: '新能源/低碳', description: '革命性零碳清洁能源微型化解决方案，磁约束等离子控制核心。' },
    { name: 'BioSphere 太空自循环生态舱', team: '天外生态工程院', category: '宇航工程', description: '微型行星地表自闭环生命维持核心，支撑长期外空栖息。' },
    { name: 'Chrono Ledger 量子密码账本', team: '暗星加密算法部', category: '信息安全', description: '对抗后量子计算时代算力突袭的高维防卫。' },
    { name: 'Zenith 垂直起降氢空天跑车', team: '逆重力载具联盟', category: '未来出行', description: '双推折叠矢量涵道氢动力低空飞行平台。' },
  ],
  standards: [
    { name: '创新力与前沿技术', description: '评估项目的核心创新性、技术攻坚难度以及后发技术护城河深度。', weight: 40 },
    { name: '工程落地与可行性', description: '评估硬件/软件工程实现难度及在当下的落地成熟性。', weight: 30 },
    { name: '商业前景与演示表现', description: '考量团队路演现场的演说气场、商业估值空间及对一级创投资本的吸引力。', weight: 30 },
  ],
  // 7 位评委: 2 专家(1.5) + 2 资深(1.2) + 3 普通(1.0)
  judges: [
    { name: '1号评委(金沙资本主席)', seat_no: 'A01', level: 'expert' },
    { name: '2号评委(朱雀基金合伙人)', seat_no: 'A02', level: 'expert' },
    { name: '3号评委(微软研究院学者)', seat_no: 'A03', level: 'senior' },
    { name: '4号评委(前沿硬科技院士)', seat_no: 'A04', level: 'senior' },
    { name: '5号评委(自媒体创投专家)', seat_no: 'A05', level: 'normal' },
    { name: '6号评委(高瓴资本董事)', seat_no: 'A06', level: 'normal' },
    { name: '7号评委(红杉资本合伙人)', seat_no: 'A07', level: 'normal' },
  ],
};

const LEVEL_WEIGHT = { expert: 1.5, senior: 1.2, normal: 1.0 };

async function seedDemo() {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [c] = await conn.query(
      `INSERT INTO competitions (name, description) VALUES (?, ?)`,
      [SAMPLE.name, SAMPLE.description]
    );
    const compId = c.insertId;

    SAMPLE.works.forEach((w, i) => i);
    let i = 0;
    for (const w of SAMPLE.works) {
      i++;
      await conn.query(
        `INSERT INTO works (competition_id, seq, name, team, category, description)
         VALUES (?,?,?,?,?,?)`,
        [compId, i, w.name, w.team, w.category, w.description]
      );
    }
    i = 0;
    for (const s of SAMPLE.standards) {
      i++;
      await conn.query(
        `INSERT INTO standards (competition_id, seq, name, description, weight)
         VALUES (?,?,?,?,?)`,
        [compId, i, s.name, s.description, s.weight]
      );
    }
    i = 0;
    for (const j of SAMPLE.judges) {
      i++;
      await conn.query(
        `INSERT INTO judges (competition_id, seq, name, seat_no, level, weight, access_token)
         VALUES (?,?,?,?,?,?,?)`,
        [compId, i, j.name, j.seat_no, j.level, LEVEL_WEIGHT[j.level], token()]
      );
    }

    await conn.commit();

    const [[row]] = await conn.query(
      `SELECT id, name FROM competitions WHERE id=?`, [compId]
    );
    console.log(`✅ 样例大赛已生成:`);
    console.log(`   大赛ID: ${row.id}`);
    console.log(`   名称  : ${row.name}`);
    console.log(`   作品  : ${SAMPLE.works.length} 组`);
    console.log(`   标准  : ${SAMPLE.standards.length} 项 (权重合计 ${SAMPLE.standards.reduce((a,b)=>a+b.weight,0)}%)`);
    console.log(`   评委  : ${SAMPLE.judges.length} 位`);
    SAMPLE.judges.forEach(j => console.log(`     · ${j.name} [${j.seat_no}] 等级=${j.level} 权重=${LEVEL_WEIGHT[j.level]}`));
    console.log(`\n   下一步: 在后台 admin.html 选择该大赛，点击「发布评分活动」生成链接。`);
    return compId;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

module.exports = { seedDemo, SAMPLE };

// 直接运行
if (require.main === module) {
  seedDemo()
    .then(() => process.exit(0))
    .catch(e => { console.error('❌ 生成失败:', e.message); process.exit(1); });
}
