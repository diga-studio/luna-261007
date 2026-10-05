// 确定性随机对拍：以固定种子的暴力枚举为参照，验证库返回的精确最优结果。
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { CrewPlanner } = require("../dist/index.js");

const T0 = Date.UTC(2026, 0, 10, 8, 0, 0);
const T1 = Date.UTC(2026, 0, 10, 12, 0, 0);

function makeRnd(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

/** 暴力枚举全部 2..8 人子集，按业务规则取最优，作为参照答案。 */
function bruteForce(roster, context, order) {
  const eligible = [];
  for (const w of roster) {
    const ctx = context[w.id];
    if (!ctx || !ctx.available) continue;
    if (ctx.oneWayMiles > w.oneWayRadiusMiles) continue;
    if (w.avoidedClients.includes(order.client)) continue;
    if (w.workedMinutes + order.workMinutes > 600) continue;
    const skills = new Set();
    for (const cert of w.skills) {
      if (cert.certExpiresAt >= order.endsAt) skills.add(cert.skill);
    }
    eligible.push({
      id: w.id,
      canLead: w.canLead,
      cost: ctx.roundTripMinutes + w.workedMinutes + (100 - w.creditScore),
      skills,
    });
  }
  eligible.sort((a, b) => a.id - b.id);

  let best = null;
  const consider = (members) => {
    if (members.length < 2 || members.length > 8) return;
    if (!members.some((m) => m.canLead)) return;
    const covered = new Set();
    for (const m of members) for (const s of m.skills) covered.add(s);
    if (!order.requiredSkills.every((s) => covered.has(s))) return;
    const totalCost = members.reduce((sum, m) => sum + m.cost, 0);
    const ids = members.map((m) => m.id).sort((a, b) => a - b);
    if (
      best === null ||
      totalCost < best.totalCost ||
      (totalCost === best.totalCost && ids.length < best.memberIds.length) ||
      (totalCost === best.totalCost &&
        ids.length === best.memberIds.length &&
        ids.some((id, i) => id !== best.memberIds[i]) &&
        ids.find((id, i) => id !== best.memberIds[i]) <
          best.memberIds[ids.findIndex((id, i) => id !== best.memberIds[i])])
    ) {
      best = { memberIds: ids, totalCost };
    }
  };

  const chosen = [];
  const walk = (start) => {
    if (chosen.length > 0) consider(chosen);
    if (chosen.length === 8) return;
    for (let i = start; i < eligible.length; i++) {
      chosen.push(eligible[i]);
      walk(i + 1);
      chosen.pop();
    }
  };
  walk(0);

  if (best === null) return null;
  const canLeadById = new Map(roster.map((w) => [w.id, w.canLead]));
  const foremanId = best.memberIds.find((id) => canLeadById.get(id));
  return { memberIds: best.memberIds, foremanId, totalCost: best.totalCost };
}

test("随机小规模场景与暴力枚举结果一致（固定种子，300 轮）", () => {
  const rnd = makeRnd(20261006);
  const planner = new CrewPlanner();
  for (let round = 0; round < 300; round++) {
    const skillPool = ["A", "B", "C", "D", "E"].slice(0, 1 + Math.floor(rnd() * 5));
    const n = 1 + Math.floor(rnd() * 12);
    const roster = [];
    const context = {};
    for (let id = 1; id <= n; id++) {
      const skills = [];
      for (const skill of skillPool) {
        if (rnd() < 0.45) {
          // 部分证书已过期
          skills.push({
            skill,
            certExpiresAt: rnd() < 0.25 ? T1 - 1 - Math.floor(rnd() * 1000) : T1 + Math.floor(rnd() * 1000),
          });
        }
      }
      roster.push({
        id,
        skills,
        canLead: rnd() < 0.4,
        workedMinutes: rnd() < 0.15 ? 541 + Math.floor(rnd() * 60) : Math.floor(rnd() * 200),
        creditScore: Math.floor(rnd() * 101),
        oneWayRadiusMiles: Math.floor(rnd() * 50),
        avoidedClients: rnd() < 0.15 ? ["客户甲"] : [],
      });
      context[id] = {
        available: rnd() < 0.8,
        oneWayMiles: Math.floor(rnd() * 60),
        roundTripMinutes: Math.floor(rnd() * 100),
      };
    }
    const requiredSkills = skillPool.filter(() => rnd() < 0.7);
    if (requiredSkills.length === 0) requiredSkills.push(skillPool[0]);
    const order = {
      client: "客户甲",
      startsAt: T0,
      endsAt: T1,
      workMinutes: 60,
      requiredSkills,
    };
    planner.replaceRoster(roster);
    const expected = bruteForce(roster, context, order);
    const actual = planner.recommendCrew(order, context);
    assert.deepEqual(
      actual,
      expected,
      `第 ${round} 轮不一致：actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`,
    );
  }
});
