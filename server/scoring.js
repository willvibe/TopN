// 评分聚合计算工具
// =====================================================================
//  规则:
//   1. 评委 i 对某作品的最终分 = Σ(维度分 × 维度权重/100)
//   2. 作品总分:
//      - 有效评委数 <= 5 : 全部评委加权平均 (按评委个人权重)
//      - 有效评委数 >  5 : 先去掉一个最高分、一个最低分（按评委加权分），
//                          再对其余评委做加权平均；被剔除的两位评委予以标记
//   3. 评委的"有效分"指: 该评委对该作品所有维度都打了分（attempt>0）
// =====================================================================

// 单个评委对某作品的维度加权分（按标准维度权重）
function judgeFinalScore(judgeDimensionalScores, standards) {
  let sum = 0;
  let weightSum = 0;
  for (const s of standards) {
    const v = judgeDimensionalScores[s.id];
    if (v === undefined || v === null) continue;
    sum += Number(v) * s.weight;
    weightSum += s.weight;
  }
  if (weightSum === 0) return null;
  return Math.round((sum / weightSum) * 100) / 100;
}

/**
 * 计算某作品的排名聚合
 * @param {Object} params
 * @param {Array<{judgeId:number, judgeWeight:number, scores:{stdId:number->number}}>} judgeScores
 *        各评委该作品的维度分 + 评委个人权重
 * @param {Array<{id,weight}>} standards  维度标准
 * @param {number} trimThreshold  去极值阈值（有效评委数 > 该值才去最高最低），默认 5
 * @returns {{perJudge:[{judgeId,final,submitted,excluded}], final:number, extreme:{min,max}|null}}
 */
function aggregateWork({ judgeScores, standards, trimThreshold = 5 }) {
  // 1. 每位有效评委的加权分
  const perJudge = [];
  for (const js of judgeScores) {
    const final = judgeFinalScore(js.scores, standards);
    if (final !== null) {
      perJudge.push({
        judgeId: js.judgeId,
        final,
        weight: Number(js.judgeWeight) || 1,
        submitted: true,
        excluded: false,
      });
    }
  }

  const valid = perJudge.filter(p => p.submitted);

  let final = 0;
  let extreme = null;

  if (valid.length > trimThreshold) {
    // ---- 去掉一个最高、一个最低（按评委加权分） ----
    const sorted = [...valid].sort((a, b) => a.final - b.final);
    const minItem = sorted[0];
    const maxItem = sorted[sorted.length - 1];
    // 标记被剔除
    minItem.excluded = true;
    maxItem.excluded = true;

    const remaining = valid.filter(p => !p.excluded);
    let wSum = 0, sum = 0;
    for (const p of remaining) { sum += p.final * p.weight; wSum += p.weight; }
    final = wSum > 0 ? sum / wSum : 0;
    extreme = { min: minItem.final, max: maxItem.final };
  } else if (valid.length > 0) {
    // ---- 不去极值，全部评委加权平均 ----
    let wSum = 0, sum = 0;
    for (const p of valid) { sum += p.final * p.weight; wSum += p.weight; }
    final = wSum > 0 ? sum / wSum : 0;
  }

  final = Math.round(final * 100) / 100;
  return { perJudge, final, extreme };
}

module.exports = { judgeFinalScore, aggregateWork };
