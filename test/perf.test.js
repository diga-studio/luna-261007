// 规模与性能测试：200 人名册、16 项必需技能、候选大量共享技能。
// 有解场景带已知最优答案；同时验证单次推荐的时间与峰值额外内存。
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { performance } = require("node:perf_hooks");
const { CrewPlanner } = require("../dist/index.js");

const T0 = Date.UTC(2026, 0, 10, 8, 0, 0);
const T1 = Date.UTC(2026, 0, 10, 12, 0, 0);
const SKILLS = Array.from({ length: 16 }, (_, i) => `S${i}`);
const TIME_LIMIT_MS = 5000;
const MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;

/**
 * 构造 200 人名册：
 * - 工人 1..4 各覆盖 4 个互不重叠的技能，合起来正好覆盖全部 16 项，
 *   个人代价 10，其中工人 2、3 可任领班。他们是唯一总代价 40 的最优班组。
 * - 工人 5..200 各覆盖 8 项技能（确定性伪随机，技能大量共享），
 *   个人代价 25，任意组合至少 2 人、代价 >= 50，不可能优于 40。
 */
function buildRoster({ s15Expired = false } = {}) {
  const roster = [];
  const context = {};
  const certFor = (skill) =>
    s15Expired && skill === "S15" ? T1 - 1 : T1 + 3600_000;
  for (let id = 1; id <= 200; id++) {
    let skills;
    let canLead;
    let roundTrip;
    if (id <= 4) {
      skills = SKILLS.slice((id - 1) * 4, id * 4).map((skill) => ({
        skill,
        certExpiresAt: certFor(skill),
      }));
      canLead = id === 2 || id === 3;
      roundTrip = 10;
    } else {
      const picked = new Set();
      for (let j = 0; picked.size < 8; j++) {
        picked.add(SKILLS[(id * 7 + j * 5) % 16]);
      }
      skills = [...picked].map((skill) => ({
        skill,
        certExpiresAt: certFor(skill),
      }));
      canLead = id % 2 === 0;
      roundTrip = 25;
    }
    roster.push({
      id,
      skills,
      canLead,
      workedMinutes: 0,
      creditScore: 100,
      oneWayRadiusMiles: 1000,
      avoidedClients: [],
    });
    context[id] = { available: true, oneWayMiles: 0, roundTripMinutes: roundTrip };
  }
  return { roster, context };
}

const ORDER = {
  client: "客户甲",
  startsAt: T0,
  endsAt: T1,
  workMinutes: 60,
  requiredSkills: SKILLS,
};

/** maxRSS 在 macOS 上单位为字节、Linux 上为千字节，按数量级归一化为字节。 */
function maxRssBytes() {
  const value = process.resourceUsage().maxRSS;
  return value < 16 * 1024 * 1024 ? value * 1024 : value;
}

test("200 人 16 技能有解场景：结果精确、5 秒内、峰值额外内存低于 256MiB", () => {
  const { roster, context } = buildRoster();
  const planner = new CrewPlanner();
  planner.replaceRoster(roster);

  // 预热一次，排除首次运行的初始化开销对内存基线的干扰。
  planner.recommendCrew(ORDER, context);

  const rssBefore = maxRssBytes();
  const started = performance.now();
  const result = planner.recommendCrew(ORDER, context);
  const elapsed = performance.now() - started;
  const rssAfter = maxRssBytes();

  // 已知最优答案：工人 1..4，总代价 40，领班为编号最小的可任领班者 2。
  assert.deepEqual(result, {
    memberIds: [1, 2, 3, 4],
    foremanId: 2,
    totalCost: 40,
  });
  assert.ok(
    elapsed < TIME_LIMIT_MS,
    `单次推荐耗时 ${elapsed.toFixed(0)}ms，超过 ${TIME_LIMIT_MS}ms`,
  );
  const extraMemory = rssAfter - rssBefore;
  assert.ok(
    extraMemory < MEMORY_LIMIT_BYTES,
    `峰值额外内存约 ${(extraMemory / 1024 / 1024).toFixed(1)}MiB，超过 256MiB`,
  );
  console.log(
    `    有解场景：耗时 ${elapsed.toFixed(0)}ms，峰值额外内存约 ${(extraMemory / 1024 / 1024).toFixed(1)}MiB`,
  );
});

test("200 人 16 技能无解场景：S15 证书全部过期，5 秒内返回无解", () => {
  const { roster, context } = buildRoster({ s15Expired: true });
  const planner = new CrewPlanner();
  planner.replaceRoster(roster);

  const started = performance.now();
  const result = planner.recommendCrew(ORDER, context);
  const elapsed = performance.now() - started;

  assert.equal(result, null);
  assert.ok(
    elapsed < TIME_LIMIT_MS,
    `单次推荐耗时 ${elapsed.toFixed(0)}ms，超过 ${TIME_LIMIT_MS}ms`,
  );
  console.log(`    无解场景：耗时 ${elapsed.toFixed(0)}ms`);
});
