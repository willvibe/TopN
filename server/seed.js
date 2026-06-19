// 生成样例大赛: 6 组作品 + 3 个评分标准(权重配平100%) + 7 位已注册评委(按等级编号)
// 评委改为扫码自动注册领号模式: name 形如 "专家1号", seq 为等级内序号
// 用法: node server/seed.js
const crypto = require('crypto');
const { pool } = require('./db');
const token = () => crypto.randomBytes(16).toString('hex');

const SAMPLE = {
  name: '2026 全球未来科技创新大赛',
  name_subtitle: '决赛现场 · Future Tech Innovation',
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
  // 仅指定等级, name 与 seq 在插入时按等级内顺序自动生成 (专家1号/专家2号…)
  judges: [
    { level: 'expert' }, { level: 'expert' },
    { level: 'senior' }, { level: 'senior' },
    { level: 'normal' }, { level: 'normal' }, { level: 'normal' },
  ],
};

const LEVEL_WEIGHT = { expert: 1.5, senior: 1.2, normal: 1.0 };
const LEVEL_LABEL = { expert: '专家', senior: '资深', normal: '普通' };

async function seedDemo() {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [c] = await conn.query(
      `INSERT INTO competitions (name, name_subtitle, description) VALUES (?, ?, ?)`,
      [SAMPLE.name, SAMPLE.name_subtitle, SAMPLE.description]
    );
    const compId = c.insertId;

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
    // 评委按等级分组注册: 每个等级内 seq 从 1 递增, name = 等级中文 + 序号 + 号
    const levelSeq = { expert: 0, senior: 0, normal: 0 };
    for (const j of SAMPLE.judges) {
      levelSeq[j.level] += 1;
      const seq = levelSeq[j.level];
      const name = `${LEVEL_LABEL[j.level]}${seq}号`;
      await conn.query(
        `INSERT INTO judges (competition_id, seq, name, seat_no, level, weight, access_token)
         VALUES (?,?,?,?,?,?,?)`,
        [compId, seq, name, '', j.level, LEVEL_WEIGHT[j.level], token()]
      );
    }

    // 直接发布: 生成大屏 token + 3 个等级 token, 并激活首个作品
    const screenToken = token();
    const expertToken = token();
    const seniorToken = token();
    const normalToken = token();
    await conn.query(
      `UPDATE competitions SET status='published', screen_token=?, expert_token=?, senior_token=?, normal_token=?,
         active_work_id=(SELECT id FROM works WHERE competition_id=? ORDER BY seq LIMIT 1)
       WHERE id=?`,
      [screenToken, expertToken, seniorToken, normalToken, compId, compId]
    );

    await conn.commit();

    const [[row]] = await conn.query(
      `SELECT id, name FROM competitions WHERE id=?`, [compId]
    );
    console.log(`✅ 样例大赛已生成(已发布):`);
    console.log(`   大赛ID: ${row.id}`);
    console.log(`   名称  : ${row.name}`);
    console.log(`   作品  : ${SAMPLE.works.length} 组`);
    console.log(`   标准  : ${SAMPLE.standards.length} 项 (权重合计 ${SAMPLE.standards.reduce((a,b)=>a+b.weight,0)}%)`);
    console.log(`   评委  : ${SAMPLE.judges.length} 位 (按等级已注册领号)`);
    Object.entries(levelSeq).forEach(([lv, n]) => {
      console.log(`     · ${LEVEL_LABEL[lv]} ×${LEVEL_WEIGHT[lv]}: ${n} 位 (${LEVEL_LABEL[lv]}1号~${LEVEL_LABEL[lv]}${n}号)`);
    });
    console.log(`\n   评委入口 (扫码自动注册领号):`);
    console.log(`     专家: /j/${expertToken}`);
    console.log(`     资深: /j/${seniorToken}`);
    console.log(`     普通: /j/${normalToken}`);
    console.log(`   大屏  : /s/${screenToken}`);
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
