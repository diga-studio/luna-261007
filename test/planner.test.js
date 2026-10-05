// 小规模场景的精确最优答案测试。每个场景的期望结果均由人工独立推导。
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { CrewPlanner } = require("../dist/index.js");

const T0 = Date.UTC(2026, 0, 10, 8, 0, 0);
const T1 = Date.UTC(2026, 0, 10, 12, 0, 0);

/** 构造工人。cost 通过 roundTripMinutes 体现（credit=100, worked=0）。 */
function worker(id, skills, canLead, cost, overrides = {}) {
  return {
    worker: {
      id,
      skills: skills.map((skill) => ({
        skill,
        certExpiresAt: overrides.certExpiresAt ?? T1 + 3600_000,
      })),
      canLead,
      workedMinutes: overrides.workedMinutes ?? 0,
      creditScore: overrides.creditScore ?? 100,
      oneWayRadiusMiles: overrides.oneWayRadiusMiles ?? 1000,
      avoidedClients: overrides.avoidedClients ?? [],
    },
    ctx: {
      available: overrides.available ?? true,
      oneWayMiles: overrides.oneWayMiles ?? 0,
      roundTripMinutes: cost,
    },
  };
}

function run(workers, order) {
  const planner = new CrewPlanner();
  const context = {};
  const roster = [];
  for (const { worker: w, ctx } of workers) {
    roster.push(w);
    context[w.id] = ctx;
  }
  planner.replaceRoster(roster);
  return planner.recommendCrew(
    {
      client: order.client ?? "客户甲",
      startsAt: T0,
      endsAt: T1,
      workMinutes: order.workMinutes ?? 60,
      requiredSkills: order.requiredSkills,
    },
    context,
  );
}

test("最便宜的工人不属于最优班组", () => {
  // W1 代价最低(1) 但无相关技能；W2+W3=40 为最优，优于 W1+W4=46。
  const result = run(
    [
      worker(1, [], false, 1),
      worker(2, ["A"], false, 20),
      worker(3, ["B"], true, 20),
      worker(4, ["A", "B"], true, 45),
    ],
    { requiredSkills: ["A", "B"] },
  );
  assert.deepEqual(result, { memberIds: [2, 3], foremanId: 3, totalCost: 40 });
});

test("总代价相同先选人数较少，再按编号序列字典序", () => {
  // {1,2}=60(2人)、{1,3}=60(2人)、{1,4}=60(2人)、{1,5}=60(2人)、{3,4,5}=60(3人)。
  // 人数较少优先，2 人方案中字典序最小为 {1,2}。
  const result = run(
    [
      worker(1, ["A", "B", "C"], true, 40),
      worker(2, ["A"], false, 20),
      worker(3, ["A"], true, 20),
      worker(4, ["B"], false, 20),
      worker(5, ["C"], false, 20),
    ],
    { requiredSkills: ["A", "B", "C"] },
  );
  assert.deepEqual(result, { memberIds: [1, 2], foremanId: 1, totalCost: 60 });
});

test("字典序平局在第二位成员上分出胜负", () => {
  // 2 人班组都必须含 W1（唯一领班），{1,2} 字典序最小。
  const result = run(
    [
      worker(1, ["A"], true, 10),
      worker(2, ["A"], false, 10),
      worker(3, ["A"], false, 10),
      worker(4, ["A"], false, 10),
    ],
    { requiredSkills: ["A"] },
  );
  assert.deepEqual(result, { memberIds: [1, 2], foremanId: 1, totalCost: 20 });
});

test("领班为成员中编号最小的可任领班者，领班也贡献技能", () => {
  // {1,3}=35 与 {2,3}=35 平局，{1,3} 字典序更小；W1 的 A 技能被使用。
  const result = run(
    [
      worker(1, ["A"], true, 30),
      worker(2, ["B"], true, 30),
      worker(3, ["A", "B"], false, 5),
    ],
    { requiredSkills: ["A", "B"] },
  );
  assert.deepEqual(result, { memberIds: [1, 3], foremanId: 1, totalCost: 35 });
});

test("资格过滤：不可用、超出半径、避配客户、当日分钟数上限", () => {
  // 仅 W1、W2、W7 有资格；W7 太贵不入选。W1 的 A 证书已过期但 B 仍有效。
  const result = run(
    [
      {
        worker: {
          id: 1,
          skills: [
            { skill: "A", certExpiresAt: T1 - 1 },
            { skill: "B", certExpiresAt: T1 + 1000 },
          ],
          canLead: true,
          workedMinutes: 0,
          creditScore: 100,
          oneWayRadiusMiles: 1000,
          avoidedClients: [],
        },
        ctx: { available: true, oneWayMiles: 0, roundTripMinutes: 10 },
      },
      {
        worker: {
          id: 2,
          skills: [{ skill: "A", certExpiresAt: T1 }], // 到期时刻等于结束时刻，有效
          canLead: false,
          workedMinutes: 0,
          creditScore: 100,
          oneWayRadiusMiles: 1000,
          avoidedClients: [],
        },
        ctx: { available: true, oneWayMiles: 0, roundTripMinutes: 10 },
      },
      worker(3, ["A", "B"], true, 1, { available: false }),
      worker(4, ["A", "B"], true, 1, { oneWayRadiusMiles: 5, oneWayMiles: 6 }),
      worker(5, ["A", "B"], true, 1, { avoidedClients: ["客户甲"] }),
      worker(6, ["A", "B"], true, 1, { workedMinutes: 541 }), // 541+60>600
      worker(7, ["A", "B"], true, 50, { workedMinutes: 540 }), // 540+60=600 恰好允许
    ],
    { requiredSkills: ["A", "B"], workMinutes: 60 },
  );
  assert.deepEqual(result, { memberIds: [1, 2], foremanId: 1, totalCost: 20 });
});

test("个人代价包含往返分钟、已排分钟与 100 减信用分", () => {
  // W1: 10+5+(100-90)=25；W2: 20+0+(100-50)=70；合计 95。
  const result = run(
    [
      worker(1, ["A"], true, 10, { workedMinutes: 5, creditScore: 90 }),
      worker(2, ["B"], false, 20, { creditScore: 50 }),
    ],
    { requiredSkills: ["A", "B"] },
  );
  assert.deepEqual(result, { memberIds: [1, 2], foremanId: 1, totalCost: 95 });
});

test("班组至少 2 人：一人全覆盖仍须加人", () => {
  const result = run(
    [worker(1, ["A"], true, 10), worker(2, [], false, 50)],
    { requiredSkills: ["A"] },
  );
  assert.deepEqual(result, { memberIds: [1, 2], foremanId: 1, totalCost: 60 });
});

test("班组至多 8 人：9 项技能各需一人时无解，8 项时有解", () => {
  const make = (n) =>
    Array.from({ length: n }, (_, i) =>
      worker(i + 1, [`S${i}`], i === 0, 10),
    );
  const order9 = { requiredSkills: Array.from({ length: 9 }, (_, i) => `S${i}`) };
  assert.equal(run(make(9), order9), null);
  const order8 = { requiredSkills: Array.from({ length: 8 }, (_, i) => `S${i}`) };
  assert.deepEqual(run(make(8), order8), {
    memberIds: [1, 2, 3, 4, 5, 6, 7, 8],
    foremanId: 1,
    totalCost: 80,
  });
});

test("无解：技能无法覆盖、无领班、资格不足、名册为空", () => {
  // 技能 B 无人覆盖
  assert.equal(
    run([worker(1, ["A"], true, 10), worker(2, ["A"], false, 10)], {
      requiredSkills: ["A", "B"],
    }),
    null,
  );
  // 无人可任领班
  assert.equal(
    run([worker(1, ["A"], false, 10), worker(2, ["A"], false, 10)], {
      requiredSkills: ["A"],
    }),
    null,
  );
  // 仅 1 名合格工人
  assert.equal(
    run([worker(1, ["A"], true, 10), worker(2, ["A"], false, 10, { available: false })], {
      requiredSkills: ["A"],
    }),
    null,
  );
  // 空名册
  assert.equal(run([], { requiredSkills: ["A"] }), null);
});

test("名册整体替换后推荐基于新名册", () => {
  const planner = new CrewPlanner();
  const ctxOf = (cost) => ({
    available: true,
    oneWayMiles: 0,
    roundTripMinutes: cost,
  });
  const order = {
    client: "客户甲",
    startsAt: T0,
    endsAt: T1,
    workMinutes: 60,
    requiredSkills: ["A"],
  };
  planner.replaceRoster([
    {
      id: 1,
      skills: [{ skill: "A", certExpiresAt: T1 + 1000 }],
      canLead: true,
      workedMinutes: 0,
      creditScore: 100,
      oneWayRadiusMiles: 1000,
      avoidedClients: [],
    },
    {
      id: 2,
      skills: [],
      canLead: false,
      workedMinutes: 0,
      creditScore: 100,
      oneWayRadiusMiles: 1000,
      avoidedClients: [],
    },
  ]);
  assert.deepEqual(planner.recommendCrew(order, { 1: ctxOf(10), 2: ctxOf(20) }), {
    memberIds: [1, 2],
    foremanId: 1,
    totalCost: 30,
  });
  // 替换为空名册后无解
  planner.replaceRoster([]);
  assert.equal(planner.recommendCrew(order, {}), null);
});
