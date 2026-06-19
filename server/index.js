// ============================================================
//  TopN 评分系统后端服务
//  - Express REST API
//  - SSE 实时推送大屏数据
//  - 评委匿名评分（access_token 链接）
//  - 实时排名（去最高最低后取平均）
// ============================================================

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { pool, ping } = require('./db');
const { aggregateWork } = require('./scoring');
const { seedDemo } = require('./seed');

const app = express();
const PORT = process.env.PORT || 5678;

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ------------------------------------------------------------
//  小工具
// ------------------------------------------------------------
const token = () => crypto.randomBytes(16).toString('hex'); // 32位 hex
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 简单结果包装
const ok = (data) => ({ ok: true, data });
const fail = (msg, code = 400) => ({ ok: false, error: msg, code });

// SSE 客户端集合：screenToken -> Set<res>
const sseClients = new Map();
function broadcastSse(screenToken, payload) {
  const clients = sseClients.get(screenToken);
  if (!clients) return;
  const msg = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients.values()) {
    try { res.write(msg); } catch (_) {}
  }
}
function regSseClient(screenToken, res) {
  if (!sseClients.has(screenToken)) sseClients.set(screenToken, new Set());
  sseClients.get(screenToken).add(res);
}
function unregSseClient(screenToken, res) {
  const set = sseClients.get(screenToken);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) sseClients.delete(screenToken);
}

// ============================================================
//  内部数据访问层 (DAL)
// ============================================================

async function getCompetition(idOrToken, field = 'id') {
  const [rows] = await pool.query(
    `SELECT * FROM competitions WHERE \`${field}\` = ? LIMIT 1`, [idOrToken]
  );
  return rows[0] || null;
}

async function getWorks(competitionId) {
  const [rows] = await pool.query(
    `SELECT * FROM works WHERE competition_id = ? ORDER BY seq, id`, [competitionId]
  );
  return rows;
}

async function getStandards(competitionId) {
  const [rows] = await pool.query(
    `SELECT * FROM standards WHERE competition_id = ? ORDER BY seq, id`, [competitionId]
  );
  return rows;
}

async function getJudges(competitionId) {
  const [rows] = await pool.query(
    `SELECT * FROM judges WHERE competition_id = ? ORDER BY seq, id`, [competitionId]
  );
  return rows;
}

// 样例演示大赛判定: 创建时间最早的一场「已发布且结构完整」的大赛
// 结构完整 = 作品>=3 且 标准权重合计=100 且 评委>=3
// 该大赛受硬保护, 不可删除, 用于演示
async function getSampleCompetitionId() {
  const [rows] = await pool.query(`
    SELECT c.id,
      (SELECT COUNT(*) FROM works WHERE competition_id = c.id) AS works_count,
      (SELECT COALESCE(SUM(weight), 0) FROM standards WHERE competition_id = c.id) AS weight_sum,
      (SELECT COUNT(*) FROM judges WHERE competition_id = c.id) AS judges_count
    FROM competitions c
    WHERE c.status = 'published'
    ORDER BY c.created_at ASC, c.id ASC
  `);
  for (const r of rows) {
    if (r.works_count >= 3 && r.weight_sum === 100 && r.judges_count >= 3) {
      return r.id;
    }
  }
  return null;
}

// 取某评委对某作品的 attempt（提交次数）
async function getAttempt(workId, judgeId) {
  const [rows] = await pool.query(
    `SELECT attempt FROM scores WHERE work_id=? AND judge_id=? LIMIT 1`, [workId, judgeId]
  );
  return rows[0] ? rows[0].attempt : 0;
}

// 取某评委对该大赛下所有作品的 attempt 状态
async function getJudgeAttempts(judgeId) {
  const [rows] = await pool.query(
    `SELECT work_id, MAX(attempt) AS attempt FROM scores WHERE judge_id=? GROUP BY work_id`, [judgeId]
  );
  const m = {};
  for (const r of rows) m[r.work_id] = r.attempt;
  return m;
}

// 取整场所有评分，聚合视图 (供大屏使用)
async function buildCompetitionSnapshot(competitionId) {
  const [comp] = await pool.query(`SELECT * FROM competitions WHERE id=?`, [competitionId]);
  if (!comp.length) return null;
  const competition = comp[0];

  const works = await getWorks(competitionId);
  const standards = await getStandards(competitionId);
  const judges = await getJudges(competitionId);

  // 全部评分明细: { [workId]: { [judgeId]: { [stdId]: score } } }
  const [scoreRows] = await pool.query(
    `SELECT work_id, judge_id, standard_id, score FROM scores WHERE competition_id=?`,
    [competitionId]
  );
  const scoreMap = {};
  for (const r of scoreRows) {
    if (!scoreMap[r.work_id]) scoreMap[r.work_id] = {};
    if (!scoreMap[r.work_id][r.judge_id]) scoreMap[r.work_id][r.judge_id] = {};
    scoreMap[r.work_id][r.judge_id][r.standard_id] = Number(r.score);
  }

  // 各评委对各作品的 attempt
  const [attemptRows] = await pool.query(
    `SELECT work_id, judge_id, MAX(attempt) AS attempt FROM scores
     WHERE competition_id=? GROUP BY work_id, judge_id`, [competitionId]
  );
  const attemptMap = {};
  for (const r of attemptRows) {
    if (!attemptMap[r.work_id]) attemptMap[r.work_id] = {};
    attemptMap[r.work_id][r.judge_id] = r.attempt;
  }

  // 计算每个作品
  const worksResult = works.map(w => {
    const judgeScores = judges.map(j => ({
      judgeId: j.id,
      judgeWeight: j.weight,
      scores: (scoreMap[w.id] && scoreMap[w.id][j.id]) || {},
    }));
    const agg = aggregateWork({ judgeScores, standards, trimThreshold: 5 });

    const perJudgeView = agg.perJudge.map(p => ({
      judgeId: p.judgeId,
      final: p.final,
      weight: p.weight,
      submitted: true,
      excluded: !!p.excluded,
    }));
    // 把未提交的评委也列出来 (final=null, submitted=false)
    for (const j of judges) {
      if (!perJudgeView.find(p => p.judgeId === j.id)) {
        perJudgeView.push({
          judgeId: j.id, final: null, weight: Number(j.weight), submitted: false, excluded: false,
        });
      }
    }
    // 按 judge seq 排序，保证矩阵列稳定
    const judgeOrder = {};
    judges.forEach((j, i) => { judgeOrder[j.id] = i; });
    perJudgeView.sort((a, b) => (judgeOrder[a.judgeId] ?? 0) - (judgeOrder[b.judgeId] ?? 0));

    return {
      id: w.id,
      seq: w.seq,
      name: w.name,
      team: w.team,
      category: w.category,
      description: w.description,
      final: agg.final,
      extreme: agg.extreme,
      perJudge: perJudgeView,
    };
  });

  // 排序 (final desc)
  const ranked = [...worksResult].sort((a, b) => b.final - a.final);

  return {
    competition: {
      id: competition.id,
      name: competition.name,
      name_subtitle: competition.name_subtitle,
      description: competition.description,
      status: competition.status,
      active_work_id: competition.active_work_id,
      share_token: competition.share_token,
      screen_token: competition.screen_token,
    },
    standards: standards.map(s => ({
      id: s.id, seq: s.seq, name: s.name, description: s.description, weight: s.weight,
    })),
    judges: judges.map(j => ({
      id: j.id, seq: j.seq, name: j.name, seat_no: j.seat_no,
      level: j.level, weight: Number(j.weight),
    })),
    works: ranked, // 已按分数排序
  };
}

// 通知某场大屏的所有 SSE 客户端刷新
async function notifyScreen(competitionId) {
  const comp = await getCompetition(competitionId);
  if (!comp || !comp.screen_token) return;
  const snap = await buildCompetitionSnapshot(competitionId);
  broadcastSse(comp.screen_token, { type: 'snapshot', snapshot: snap });
}

// ============================================================
//  API: 大赛 / 后台
// ============================================================

// 创建大赛（草稿）
app.post('/api/competitions', async (req, res) => {
  const { name, name_subtitle, description } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json(fail('大赛名称必填'));
  const [r] = await pool.query(
    `INSERT INTO competitions (name, name_subtitle, description) VALUES (?, ?, ?)`,
    [name.trim(), (name_subtitle || '').trim(), description || '']
  );
  const comp = await getCompetition(r.insertId);
  res.json(ok(comp));
});

// 列出所有大赛
app.get('/api/competitions', async (_req, res) => {
  const [rows] = await pool.query(
    `SELECT c.*,
       (SELECT COUNT(*) FROM works WHERE competition_id=c.id) AS works_count,
       (SELECT COUNT(*) FROM judges WHERE competition_id=c.id) AS judges_count
     FROM competitions c ORDER BY c.id DESC`
  );
  // 标记受保护的样例大赛
  const sampleId = await getSampleCompetitionId();
  const list = rows.map(r => ({ ...r, is_sample: (sampleId && r.id === sampleId) }));
  res.json(ok(list));
});

// 大赛详情 + 关联数据
app.get('/api/competitions/:id', async (req, res) => {
  const comp = await getCompetition(req.params.id);
  if (!comp) return res.status(404).json(fail('大赛不存在', 404));
  const [works, standards, judges] = await Promise.all([
    getWorks(comp.id), getStandards(comp.id), getJudges(comp.id)
  ]);
  res.json(ok({
    competition: {
      id: comp.id, name: comp.name, name_subtitle: comp.name_subtitle, description: comp.description,
      status: comp.status, active_work_id: comp.active_work_id,
      share_token: comp.share_token, screen_token: comp.screen_token,
      expert_token: comp.expert_token, senior_token: comp.senior_token, normal_token: comp.normal_token,
    },
    works, standards, judges,
  }));
});

// 更新大赛基础信息
app.put('/api/competitions/:id', async (req, res) => {
  const comp = await getCompetition(req.params.id);
  if (!comp) return res.status(404).json(fail('大赛不存在', 404));
  const { name, name_subtitle, description, status } = req.body || {};
  await pool.query(
    `UPDATE competitions SET
       name = COALESCE(?, name),
       name_subtitle = COALESCE(?, name_subtitle),
       description = COALESCE(?, description),
       status = COALESCE(?, status)
     WHERE id = ?`,
    [name, name_subtitle, description, status, comp.id]
  );
  const updated = await getCompetition(comp.id);
  res.json(ok(updated));
});

// 删除大赛
app.delete('/api/competitions/:id', async (req, res) => {
  const targetId = Number(req.params.id);
  // 样例演示大赛硬保护: 不可删除
  const sampleId = await getSampleCompetitionId();
  if (sampleId && targetId === sampleId) {
    return res.status(403).json(fail('样例演示大赛不可删除', 403));
  }
  await pool.query(`DELETE FROM competitions WHERE id=?`, [req.params.id]);
  res.json(ok({ deleted: true }));
});

// ---------- 作品 CRUD ----------
app.post('/api/competitions/:id/works', async (req, res) => {
  const comp = await getCompetition(req.params.id);
  if (!comp) return res.status(404).json(fail('大赛不存在', 404));
  const { name, team, category, description, seq } = req.body || {};
  if (!name) return res.status(400).json(fail('作品名称必填'));
  const [[maxRow]] = await pool.query(
    `SELECT COALESCE(MAX(seq),0) AS m FROM works WHERE competition_id=?`, [comp.id]
  );
  const seqVal = seq !== undefined ? Number(seq) : maxRow.m + 1;
  const [r] = await pool.query(
    `INSERT INTO works (competition_id, seq, name, team, category, description)
     VALUES (?,?,?,?,?,?)`,
    [comp.id, seqVal, name, team || '', category || '', description || '']
  );
  const [rows] = await pool.query(`SELECT * FROM works WHERE id=?`, [r.insertId]);
  res.json(ok(rows[0]));
});

app.put('/api/works/:workId', async (req, res) => {
  const { name, team, category, description, seq } = req.body || {};
  await pool.query(
    `UPDATE works SET
       name=COALESCE(?,name), team=COALESCE(?,team),
       category=COALESCE(?,category), description=COALESCE(?,description),
       seq=COALESCE(?,seq)
     WHERE id=?`,
    [name, team, category, description, seq, req.params.workId]
  );
  const [rows] = await pool.query(`SELECT * FROM works WHERE id=?`, [req.params.workId]);
  res.json(ok(rows[0]));
});

app.delete('/api/works/:workId', async (req, res) => {
  await pool.query(`DELETE FROM works WHERE id=?`, [req.params.workId]);
  res.json(ok({ deleted: true }));
});

// 批量调整作品出场顺序 (拖拽排序)
// body: { order: [workId, workId, ...] } —— 按新顺序的作品 id 数组
// seq 从 1 连续递增并归一化 (消除删除留下的空洞), 事务保证原子性
app.put('/api/competitions/:id/works/reorder', async (req, res) => {
  const comp = await getCompetition(req.params.id);
  if (!comp) return res.status(404).json(fail('大赛不存在', 404));
  const order = req.body && req.body.order;
  if (!Array.isArray(order) || order.length === 0) {
    return res.status(400).json(fail('缺少 order 数组', 400));
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    // 逐条更新 seq (从 1 连续递增), 限定 competition_id 防越权
    for (let i = 0; i < order.length; i++) {
      await conn.query(
        `UPDATE works SET seq=? WHERE id=? AND competition_id=?`,
        [i + 1, order[i], comp.id]
      );
    }
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
  await notifyScreen(comp.id);
  const works = await getWorks(comp.id);
  res.json(ok({ works }));
});

// ---------- 评分标准 CRUD ----------
app.post('/api/competitions/:id/standards', async (req, res) => {
  const comp = await getCompetition(req.params.id);
  if (!comp) return res.status(404).json(fail('大赛不存在', 404));
  const { name, description, weight } = req.body || {};
  if (!name) return res.status(400).json(fail('维度名称必填'));
  const [[maxRow]] = await pool.query(
    `SELECT COALESCE(MAX(seq),0) AS m FROM standards WHERE competition_id=?`, [comp.id]
  );
  const [r] = await pool.query(
    `INSERT INTO standards (competition_id, seq, name, description, weight)
     VALUES (?,?,?,?,?)`,
    [comp.id, maxRow.m + 1, name, description || '', Number(weight) || 0]
  );
  const [rows] = await pool.query(`SELECT * FROM standards WHERE id=?`, [r.insertId]);
  res.json(ok(rows[0]));
});

app.put('/api/standards/:stdId', async (req, res) => {
  const { name, description, weight } = req.body || {};
  await pool.query(
    `UPDATE standards SET name=COALESCE(?,name), description=COALESCE(?,description),
       weight=COALESCE(?,weight) WHERE id=?`,
    [name, description, weight, req.params.stdId]
  );
  const [rows] = await pool.query(`SELECT * FROM standards WHERE id=?`, [req.params.stdId]);
  res.json(ok(rows[0]));
});

app.delete('/api/standards/:stdId', async (req, res) => {
  await pool.query(`DELETE FROM standards WHERE id=?`, [req.params.stdId]);
  res.json(ok({ deleted: true }));
});

// ---------- 评委等级 -> 默认权重 ----------
// expert=专家(1.5) senior=资深(1.2) normal=普通(1.0)
const LEVEL_WEIGHT = { expert: 1.5, senior: 1.2, normal: 1.0 };
const LEVEL_LABEL = { expert: '专家', senior: '资深', normal: '普通' };
function resolveLevelWeight(level, weight) {
  const lv = LEVEL_WEIGHT[level] ? level : 'normal';
  const w = (weight !== undefined && weight !== null && !Number.isNaN(Number(weight)))
    ? Number(weight) : LEVEL_WEIGHT[lv];
  return { level: lv, weight: w };
}

// ---------- 评委 CRUD ----------
app.post('/api/competitions/:id/judges', async (req, res) => {
  const comp = await getCompetition(req.params.id);
  if (!comp) return res.status(404).json(fail('大赛不存在', 404));
  const { name, seat_no, level, weight } = req.body || {};
  if (!name) return res.status(400).json(fail('评委姓名必填'));
  const { level: lv, weight: w } = resolveLevelWeight(level, weight);
  const [[maxRow]] = await pool.query(
    `SELECT COALESCE(MAX(seq),0) AS m FROM judges WHERE competition_id=?`, [comp.id]
  );
  const [r] = await pool.query(
    `INSERT INTO judges (competition_id, seq, name, seat_no, level, weight, access_token)
     VALUES (?,?,?,?,?,?,?)`,
    [comp.id, maxRow.m + 1, name, seat_no || '', lv, w, token()]
  );
  const [rows] = await pool.query(`SELECT * FROM judges WHERE id=?`, [r.insertId]);
  res.json(ok(rows[0]));
});

app.put('/api/judges/:judgeId', async (req, res) => {
  const { name, seat_no, level, weight } = req.body || {};
  // 若提供了 level/weight 之一，则一起解析
  let sets = ['name=COALESCE(?,name)', 'seat_no=COALESCE(?,seat_no)'];
  let params = [name, seat_no];
  if (level !== undefined || weight !== undefined) {
    const [cur] = await pool.query(`SELECT level, weight FROM judges WHERE id=?`, [req.params.judgeId]);
    const { level: lv, weight: w } = resolveLevelWeight(
      level !== undefined ? level : (cur[0] ? cur[0].level : 'normal'),
      weight !== undefined ? weight : (cur[0] ? cur[0].weight : 1)
    );
    sets.push('level=?', 'weight=?');
    params.push(lv, w);
  }
  params.push(req.params.judgeId);
  await pool.query(`UPDATE judges SET ${sets.join(',')} WHERE id=?`, params);
  const [rows] = await pool.query(`SELECT * FROM judges WHERE id=?`, [req.params.judgeId]);
  res.json(ok(rows[0]));
});

app.delete('/api/judges/:judgeId', async (req, res) => {
  await pool.query(`DELETE FROM judges WHERE id=?`, [req.params.judgeId]);
  res.json(ok({ deleted: true }));
});

// ---------- 批量导入 (后台一键配齐) ----------
// body: { competitionName, works:[{name,team,category,description}], standards:[{name,description,weight}], judges:[{name,seat_no}] }
app.post('/api/competitions/import', async (req, res) => {
  const { competitionName, works = [], standards = [], judges = [] } = req.body || {};
  if (!competitionName) return res.status(400).json(fail('大赛名称必填'));

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [c] = await conn.query(
      `INSERT INTO competitions (name) VALUES (?)`, [competitionName]
    );
    const compId = c.insertId;

    let i = 0;
    for (const w of works) {
      i++;
      await conn.query(
        `INSERT INTO works (competition_id, seq, name, team, category, description)
         VALUES (?,?,?,?,?,?)`,
        [compId, i, w.name, w.team || '', w.category || '', w.description || '']
      );
    }
    i = 0;
    for (const s of standards) {
      i++;
      await conn.query(
        `INSERT INTO standards (competition_id, seq, name, description, weight)
         VALUES (?,?,?,?,?)`,
        [compId, i, s.name, s.description || '', Number(s.weight) || 0]
      );
    }
    i = 0;
    for (const j of judges) {
      i++;
      const { level: lv, weight: w } = resolveLevelWeight(j.level, j.weight);
      await conn.query(
        `INSERT INTO judges (competition_id, seq, name, seat_no, level, weight, access_token)
         VALUES (?,?,?,?,?,?,?)`,
        [compId, i, j.name, j.seat_no || '', lv, w, token()]
      );
    }

    await conn.commit();
    res.json(ok({ competition_id: compId }));
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
});

// ============================================================
//  API: 发布评分活动 (生成链接)
// ============================================================
app.post('/api/competitions/:id/publish', async (req, res) => {
  const comp = await getCompetition(req.params.id);
  if (!comp) return res.status(404).json(fail('大赛不存在', 404));

  // 校验：作品 >=3，标准权重 = 100
  const [works, standards] = await Promise.all([getWorks(comp.id), getStandards(comp.id)]);
  if (works.length < 3) return res.status(400).json(fail('入围作品至少 3 组'));
  const totalWeight = standards.reduce((a, b) => a + b.weight, 0);
  if (totalWeight !== 100) return res.status(400).json(fail(`评分标准权重总和必须为 100%（当前 ${totalWeight}%）`));

  let share_token = comp.share_token || token();
  let screen_token = comp.screen_token || token();
  // 3 个等级的评委注册链接 token (扫码自动注册领号)
  let expert_token = comp.expert_token || token();
  let senior_token = comp.senior_token || token();
  let normal_token = comp.normal_token || token();

  await pool.query(
    `UPDATE competitions SET status='published', share_token=?, screen_token=?,
       expert_token=?, senior_token=?, normal_token=?,
       active_work_id=? WHERE id=?`,
    [share_token, screen_token, expert_token, senior_token, normal_token, works[0].id, comp.id]
  );

  const updated = await getCompetition(comp.id);
  const base = `${req.protocol}://${req.get('host')}`;
  res.json(ok({
    competition: updated,
    links: {
      expert_url: `${base}/j/${expert_token}`,    // 专家评委入口 ×1.5
      senior_url: `${base}/j/${senior_token}`,    // 资深评委入口 ×1.2
      normal_url: `${base}/j/${normal_token}`,    // 普通评委入口 ×1.0
      screen_url: `${base}/s/${screen_token}`,     // 大屏
      admin_url: `${base}/admin.html?id=${updated.id}`,
    },
  }));
});

// ============================================================
//  API: 评委端
// ============================================================

// 一键生成样例大赛 (6 作品 + 3 标准 + 7 评委含等级)，返回大赛ID
app.post('/api/seed/demo', async (_req, res) => {
  const id = await seedDemo();
  res.json(ok({ competition_id: id }));
});

// 等级 token 字段名 -> { level, label }
const LEVEL_TOKEN_FIELDS = [
  { field: 'expert_token', level: 'expert' },
  { field: 'senior_token', level: 'senior' },
  { field: 'normal_token', level: 'normal' },
];

// 探测 token 类型：是某大赛的等级注册 token, 还是某评委的 access_token
// 返回 { type: 'level'|'judge', level?(等级), competition }
app.get('/api/judge/probe/:token', async (req, res) => {
  const t = req.params.token;
  // 1) 先查是否是等级 token
  for (const { field, level } of LEVEL_TOKEN_FIELDS) {
    const comp = await getCompetition(t, field);
    if (comp) {
      return res.json(ok({
        type: 'level', level,
        level_label: LEVEL_LABEL[level] || '普通',
        competition: { id: comp.id, name: comp.name, status: comp.status },
      }));
    }
  }
  // 2) 再查是否是评委 access_token
  const [rows] = await pool.query(
    `SELECT j.id, j.competition_id, c.name AS competition_name, c.status AS competition_status
     FROM judges j JOIN competitions c ON c.id=j.competition_id
     WHERE j.access_token=? LIMIT 1`, [t]
  );
  if (rows.length) {
    return res.json(ok({
      type: 'judge',
      judge_id: rows[0].id,
      competition: { id: rows[0].competition_id, name: rows[0].competition_name, status: rows[0].competition_status },
    }));
  }
  res.status(404).json(fail('链接无效', 404));
});

// 评委扫码注册领号: 按等级已注册人数 +1 分配编号, 创建评委记录并返回身份
// 评委 name = 等级中文 + 编号 + 号 (如 专家1号); access_token 作为设备绑定凭证
app.post('/api/judge/register/:levelToken', async (req, res) => {
  const t = req.params.levelToken;
  // 定位大赛与等级
  let comp = null, level = null;
  for (const { field, level: lv } of LEVEL_TOKEN_FIELDS) {
    const c = await getCompetition(t, field);
    if (c) { comp = c; level = lv; break; }
  }
  if (!comp) return res.status(404).json(fail('评委注册链接无效', 404));

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    // 行锁该大赛, 防并发注册产生重复编号 (SELECT ... FOR UPDATE 锁 competitions 行)
    await conn.query(`SELECT id FROM competitions WHERE id=? FOR UPDATE`, [comp.id]);
    // 等级内当前最大 seq
    const [[maxRow]] = await conn.query(
      `SELECT COALESCE(MAX(seq),0) AS m FROM judges WHERE competition_id=? AND level=?`,
      [comp.id, level]
    );
    const seq = maxRow.m + 1;
    const { weight } = resolveLevelWeight(level, undefined);
    const name = `${LEVEL_LABEL[level]}${seq}号`;
    const accessToken = token();
    const [r] = await conn.query(
      `INSERT INTO judges (competition_id, seq, name, seat_no, level, weight, access_token)
       VALUES (?,?,?,?,?,?,?)`,
      [comp.id, seq, name, '', level, weight, accessToken]
    );
    await conn.commit();
    const [rows] = await pool.query(`SELECT * FROM judges WHERE id=?`, [r.insertId]);
    const j = rows[0];
    res.json(ok({
      judge: {
        id: j.id, access_token: j.access_token, name: j.name, seat_no: j.seat_no, seq: j.seq,
        level: j.level, level_label: LEVEL_LABEL[j.level] || '普通', weight: Number(j.weight),
      },
      competition: { id: comp.id, name: comp.name, status: comp.status },
    }));
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
});

// 通过 share_token 拿到大赛与评委列表（旧总入口, 兼容保留）
app.get('/api/competitions/by-share/:shareToken', async (req, res) => {
  const comp = await getCompetition(req.params.shareToken, 'share_token');
  if (!comp) return res.status(404).json(fail('评委链接无效', 404));
  const judges = await getJudges(comp.id);
  res.json(ok({
    competition: { id: comp.id, name: comp.name, status: comp.status },
    judges: judges.map(j => ({
      id: j.id, name: j.name, seat_no: j.seat_no,
      level: j.level, level_label: LEVEL_LABEL[j.level] || '普通', weight: Number(j.weight),
      access_token: j.access_token,
    })),
  }));
});

// 评委登录页：通过 access_token 拿到评委/大赛信息
app.get('/api/judge/by-token/:accessToken', async (req, res) => {
  const [rows] = await pool.query(
    `SELECT j.*, c.name AS competition_name, c.status AS competition_status
     FROM judges j JOIN competitions c ON c.id=j.competition_id
     WHERE j.access_token=? LIMIT 1`, [req.params.accessToken]
  );
  if (!rows.length) return res.status(404).json(fail('评委链接无效', 404));
  const j = rows[0];
  res.json(ok({
    judge: {
      id: j.id, name: j.name, seat_no: j.seat_no, seq: j.seq,
      level: j.level, level_label: LEVEL_LABEL[j.level] || '普通', weight: Number(j.weight),
    },
    competition: { id: j.competition_id, name: j.competition_name, status: j.competition_status },
  }));
});

// 评委视角：作品列表 + 各自的评分/attempt
app.get('/api/judge/:judgeId/dashboard', async (req, res) => {
  const [jRows] = await pool.query(`SELECT * FROM judges WHERE id=?`, [req.params.judgeId]);
  if (!jRows.length) return res.status(404).json(fail('评委不存在', 404));
  const judge = jRows[0];

  const [works, standards] = await Promise.all([
    getWorks(judge.competition_id), getStandards(judge.competition_id)
  ]);

  // 该评委的全部评分
  const [sc] = await pool.query(
    `SELECT work_id, standard_id, score, attempt FROM scores WHERE judge_id=?`, [judge.id]
  );
  const myScores = {}; // { [workId]: { [stdId]: score } }
  const myAttempt = {}; // { [workId]: attempt }
  for (const r of sc) {
    if (!myScores[r.work_id]) myScores[r.work_id] = {};
    myScores[r.work_id][r.standard_id] = Number(r.score);
    myAttempt[r.work_id] = r.attempt;
  }

  res.json(ok({
    judge: { id: judge.id, name: judge.name, seat_no: judge.seat_no, seq: judge.seq },
    competition_id: judge.competition_id,
    standards: standards.map(s => ({ id: s.id, name: s.name, description: s.description, weight: s.weight })),
    works: works.map(w => ({
      id: w.id, seq: w.seq, name: w.name, team: w.team,
      category: w.category, description: w.description,
      scores: myScores[w.id] || {},
      attempt: myAttempt[w.id] || 0,
    })),
  }));
});

// 评委提交评分（首次或唯一一次修改）
// body: { work_id, scores: { stdId: value }, }
app.post('/api/judge/:judgeId/score', async (req, res) => {
  const [jRows] = await pool.query(`SELECT * FROM judges WHERE id=?`, [req.params.judgeId]);
  if (!jRows.length) return res.status(404).json(fail('评委不存在', 404));
  const judge = jRows[0];

  const { work_id, scores } = req.body || {};
  if (!work_id || !scores) return res.status(400).json(fail('参数缺失'));

  const [wRows] = await pool.query(
    `SELECT * FROM works WHERE id=? AND competition_id=?`, [work_id, judge.competition_id]
  );
  if (!wRows.length) return res.status(400).json(fail('作品不存在'));

  // attempt 控制：0 -> 1 (首次), 1 -> 2 (修改), 2 -> 拒绝
  const currentAttempt = await getAttempt(work_id, judge.id);
  if (currentAttempt >= 2) {
    return res.status(400).json(fail('该作品评分已终极锁定，无法再次修改'));
  }
  const newAttempt = currentAttempt + 1;

  const standards = await getStandards(judge.competition_id);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const s of standards) {
    const v = scores[s.id];
      if (v === undefined || v === null) continue;
      let val = Number(v);
      if (Number.isNaN(val)) continue;
      val = Math.max(0, Math.min(10, val));
      await conn.query(
        `INSERT INTO scores (competition_id, work_id, judge_id, standard_id, score, round, attempt)
         VALUES (?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE score=VALUES(score), attempt=VALUES(attempt), round=VALUES(round)`,
        [judge.competition_id, work_id, judge.id, s.id, val, newAttempt, newAttempt]
      );
    }
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }

  // 推送大屏刷新
  await notifyScreen(judge.competition_id);

  const updated = await getAttempt(work_id, judge.id);
  res.json(ok({ work_id, attempt: updated }));
});

// ============================================================
//  API: 大屏
// ============================================================

// 大屏通过 screen_token 拿到完整快照
app.get('/api/screen/:screenToken', async (req, res) => {
  const comp = await getCompetition(req.params.screenToken, 'screen_token');
  if (!comp) return res.status(404).json(fail('大屏链接无效', 404));
  const snap = await buildCompetitionSnapshot(comp.id);
  res.json(ok(snap));
});

// 推进当前路演作品（后台 / 大屏均可调用）
app.post('/api/competitions/:id/active-work', async (req, res) => {
  const comp = await getCompetition(req.params.id);
  if (!comp) return res.status(404).json(fail('大赛不存在', 404));
  const { work_id } = req.body || {};
  if (work_id) {
    await pool.query(`UPDATE competitions SET active_work_id=? WHERE id=?`, [work_id, comp.id]);
  } else {
    // 推进到下一个
    const works = await getWorks(comp.id);
    const curIdx = works.findIndex(w => w.id === comp.active_work_id);
    const next = works[(curIdx + 1) % works.length];
    await pool.query(`UPDATE competitions SET active_work_id=? WHERE id=?`, [next.id, comp.id]);
  }
  await notifyScreen(comp.id);
  const updated = await getCompetition(comp.id);
  res.json(ok({ active_work_id: updated.active_work_id }));
});

// 重置某场全部评分
app.post('/api/competitions/:id/reset-scores', async (req, res) => {
  await pool.query(`DELETE FROM scores WHERE competition_id=?`, [req.params.id]);
  await notifyScreen(req.params.id);
  res.json(ok({ reset: true }));
});

// ============================================================
//  SSE: 大屏实时推送
// ============================================================
app.get('/api/screen/:screenToken/stream', async (req, res) => {
  const comp = await getCompetition(req.params.screenToken, 'screen_token');
  if (!comp) return res.status(404).json(fail('大屏链接无效', 404));

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  regSseClient(req.params.screenToken, res);

  // 立刻推一份当前快照
  const snap = await buildCompetitionSnapshot(comp.id);
  res.write(`data: ${JSON.stringify({ type: 'snapshot', snapshot: snap })}\n\n`);

  // 心跳
  const heartbeat = setInterval(() => {
    try { res.write(`: hb\n\n`); } catch (_) {}
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    unregSseClient(req.params.screenToken, res);
  });
});

// ============================================================
//  前端路由（评分链接 / 大屏链接）
// ============================================================
app.get('/j/:token', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'judge.html'));
});
app.get('/s/:token', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'screen.html'));
});

// ============================================================
//  错误处理
// ============================================================
app.use((err, _req, res, _next) => {
  console.error('[ERR]', err);
  res.status(500).json(fail(err.message || '服务器错误', 500));
});

// ============================================================
//  启动
// ============================================================
(async () => {
  try {
    await ping();
    console.log('✅ MySQL 连接成功');
  } catch (e) {
    console.error('❌ MySQL 连接失败:', e.message);
    console.error('   请确认 DB_HOST/DB_PASSWORD 等环境变量已配置，且 schema.sql 已执行。');
  }

  app.listen(PORT, () => {
    console.log(`🚀 TopN 评分服务已启动: http://localhost:${PORT}`);
    console.log(`   后台: http://localhost:${PORT}/admin.html`);
  });
})();
