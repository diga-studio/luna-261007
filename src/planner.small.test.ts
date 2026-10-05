import { assert, test } from "./testkit";
import { CrewPlanner } from "./planner";
import type { Worker, WorkerOrderContext, WorkOrder } from "./types";

const T0 = Date.parse("2026-10-06T08:00:00Z");
const T1 = Date.parse("2026-10-06T12:00:00Z");

interface WorkerSpec {
  id: number;
  skills?: Array<[string, number]>;
  leader?: boolean;
  worked?: number;
  credit?: number;
  radius?: number;
  avoided?: string[];
}

function mkWorker(spec: WorkerSpec): Worker {
  return {
    id: spec.id,
    skills: (spec.skills ?? []).map(([skill, exp]) => ({
      skill,
      certExpiresAt: exp,
    })),
    leaderCapable: spec.leader ?? false,
    workedMinutes: spec.worked ?? 0,
    creditScore: spec.credit ?? 100,
    maxOneWayMiles: spec.radius ?? 1000,
    avoidedCustomers: spec.avoided ?? [],
  };
}

function mkOrder(requiredSkills: string[], workMinutes = 60): WorkOrder {
  return {
    customer: "cust-1",
    startAt: T0,
    endAt: T1,
    workMinutes,
    requiredSkills,
  };
}

/** 默认 context：可用、里程 0、往返 0，个人代价 = worked + (100 - credit)。 */
function mkContexts(
  workers: Worker[],
  overrides: Map<number, Partial<WorkerOrderContext>> = new Map(),
): WorkerOrderContext[] {
  return workers.map((w) => ({
    workerId: w.id,
    available: true,
    oneWayMiles: 0,
    roundTripMinutes: 0,
    ...(overrides.get(w.id) ?? {}),
  }));
}

test("最便宜的工人不属于最优班组", () => {
  // W1、W2 个人代价最低(0)，但都不能任领班；单独挑最便宜的两人没有领班。
  // 最优：{1, 3}，代价 5；{1,2,3} 同为代价 5 但人数更多，被人数规则淘汰。
  const workers = [
    mkWorker({ id: 1, skills: [["a", T1]] }), // 代价 0
    mkWorker({ id: 2, skills: [["b", T1]] }), // 代价 0
    mkWorker({ id: 3, skills: [["a", T1], ["b", T1]], leader: true, credit: 95 }), // 代价 5
  ];
  const planner = new CrewPlanner();
  planner.replaceRoster(workers);
  const res = planner.recommend(mkOrder(["a", "b"]), mkContexts(workers));
  assert.deepEqual(res, { ok: true, members: [1, 3], leader: 3, totalCost: 5 });
});

test("总代价相同先比人数，人数相同再比编号序列字典序", () => {
  // 四人两两组合代价都是 3、人数都是 2，字典序最小的是 [10, 20]。
  const workers = [
    mkWorker({ id: 10, skills: [["a", T1]], leader: true, credit: 98 }), // 代价 2
    mkWorker({ id: 11, skills: [["a", T1]], leader: true, credit: 98 }), // 代价 2
    mkWorker({ id: 20, credit: 99 }), // 代价 1，无技能
    mkWorker({ id: 21, credit: 99 }), // 代价 1，无技能
  ];
  const planner = new CrewPlanner();
  planner.replaceRoster(workers);
  const res = planner.recommend(mkOrder(["a"]), mkContexts(workers));
  assert.deepEqual(res, { ok: true, members: [10, 20], leader: 10, totalCost: 3 });
});

test("个人代价 = 往返分钟 + 已排分钟 + (100 - 信用分)", () => {
  const workers = [
    mkWorker({ id: 1, skills: [["a", T1]], leader: true, worked: 30, credit: 80 }),
    mkWorker({ id: 2, worked: 10, credit: 90 }),
  ];
  const planner = new CrewPlanner();
  planner.replaceRoster(workers);
  const ctx = mkContexts(workers, new Map([[1, { roundTripMinutes: 22 }]]));
  const res = planner.recommend(mkOrder(["a"]), ctx);
  // 工人1: 22 + 30 + 20 = 72；工人2: 0 + 10 + 10 = 20；合计 92。
  assert.deepEqual(res, { ok: true, members: [1, 2], leader: 1, totalCost: 92 });
});

test("证书到期时刻等于工单结束时刻可用，早于结束时刻该技能失效但不影响其他技能", () => {
  const workers = [
    // 技能 a 证书恰好到期于结束时刻：有效。
    mkWorker({ id: 1, skills: [["a", T1]], leader: true }),
    // 技能 b 证书早于结束时刻：失效；技能 c 有效。
    mkWorker({ id: 2, skills: [["b", T1 - 1], ["c", T1]] }),
    mkWorker({ id: 3, skills: [["b", T1]] }),
  ];
  const planner = new CrewPlanner();
  planner.replaceRoster(workers);
  const res = planner.recommend(mkOrder(["a", "b", "c"]), mkContexts(workers));
  assert.deepEqual(res, {
    ok: true,
    members: [1, 2, 3],
    leader: 1,
    totalCost: 0,
  });
  // 若只要求 b 和 c，工人 2 只能贡献 c；2、3 都不可任领班，需带上工人 1。
  const res2 = planner.recommend(mkOrder(["b", "c"]), mkContexts(workers));
  assert.deepEqual(res2, { ok: true, members: [1, 2, 3], leader: 1, totalCost: 0 });
});

test("资格过滤：不可用、超半径、避配客户、超 600 分钟均不可入选", () => {
  const workers = [
    mkWorker({ id: 1, skills: [["a", T1]], leader: true }),
    mkWorker({ id: 2, skills: [["a", T1]], leader: true }),
    mkWorker({ id: 3, skills: [["a", T1]], leader: true }),
    mkWorker({ id: 4, skills: [["a", T1]], leader: true, radius: 5 }),
    mkWorker({ id: 5, skills: [["a", T1]], leader: true, avoided: ["cust-1"] }),
    mkWorker({ id: 6, skills: [["a", T1]], leader: true, worked: 550 }),
  ];
  const planner = new CrewPlanner();
  planner.replaceRoster(workers);
  const ctx = mkContexts(
    workers,
    new Map([
      [2, { available: false }],
      [4, { oneWayMiles: 6 }],
    ]),
  );
  // 工单 60 分钟：工人6 已排 550，550+60=610 > 600，不可入选。
  const res = planner.recommend(mkOrder(["a"], 60), ctx);
  assert.deepEqual(res, { ok: true, members: [1, 3], leader: 1, totalCost: 0 });
});

test("已排分钟加本次等于 600 可以入选", () => {
  const workers = [
    mkWorker({ id: 1, skills: [["a", T1]], leader: true, worked: 540 }),
    mkWorker({ id: 2, worked: 100 }),
  ];
  const planner = new CrewPlanner();
  planner.replaceRoster(workers);
  const res = planner.recommend(mkOrder(["a"], 60), mkContexts(workers));
  assert.equal(res.ok, true);
  if (res.ok) assert.deepEqual(res.members, [1, 2]);
});

test("无人可任领班时无解", () => {
  const workers = [
    mkWorker({ id: 1, skills: [["a", T1]] }),
    mkWorker({ id: 2, skills: [["a", T1]] }),
  ];
  const planner = new CrewPlanner();
  planner.replaceRoster(workers);
  const res = planner.recommend(mkOrder(["a"]), mkContexts(workers));
  assert.deepEqual(res, { ok: false, reason: "no-feasible-crew" });
});

test("技能无法覆盖时无解，不少覆盖、不放宽资格", () => {
  const workers = [
    mkWorker({ id: 1, skills: [["a", T1]], leader: true }),
    mkWorker({ id: 2, skills: [["a", T1]], leader: true }),
  ];
  const planner = new CrewPlanner();
  planner.replaceRoster(workers);
  const res = planner.recommend(mkOrder(["a", "b"]), mkContexts(workers));
  assert.deepEqual(res, { ok: false, reason: "no-feasible-crew" });
});

test("领班为成员中编号最小的可任领班者", () => {
  const workers = [
    mkWorker({ id: 5, skills: [["a", T1]], leader: true, credit: 90 }), // 代价 10
    mkWorker({ id: 9, skills: [["a", T1]], leader: true, credit: 90 }), // 代价 10
    mkWorker({ id: 3, credit: 99 }), // 代价 1，凑人数
  ];
  const planner = new CrewPlanner();
  planner.replaceRoster(workers);
  const res = planner.recommend(mkOrder(["a"]), mkContexts(workers));
  // {3,5} 与 {3,9} 同代价同人数，字典序选 {3,5}，领班 5。
  assert.deepEqual(res, { ok: true, members: [3, 5], leader: 5, totalCost: 11 });
});

test("名册整体替换后，旧名册不再生效", () => {
  const planner = new CrewPlanner();
  planner.replaceRoster([
    mkWorker({ id: 1, skills: [["a", T1]], leader: true }),
    mkWorker({ id: 2, skills: [["a", T1]], leader: true }),
  ]);
  const workers2 = [
    mkWorker({ id: 7, skills: [["b", T1]], leader: true }),
    mkWorker({ id: 8, skills: [["b", T1]], leader: true }),
  ];
  planner.replaceRoster(workers2);
  const res = planner.recommend(mkOrder(["b"]), mkContexts(workers2));
  assert.deepEqual(res, { ok: true, members: [7, 8], leader: 7, totalCost: 0 });
});

test("班组人数上限为 8：最低代价覆盖需 9 人时不能违规", () => {
  // 9 项技能各由一名零代价工人独占，9 人才能覆盖，超过上限 → 无解。
  const workers: Worker[] = [];
  for (let i = 0; i < 9; i++) {
    workers.push(
      mkWorker({ id: i + 1, skills: [[`s${i}`, T1]], leader: i === 0 }),
    );
  }
  const planner = new CrewPlanner();
  planner.replaceRoster(workers);
  const order = mkOrder(
    Array.from({ length: 9 }, (_, i) => `s${i}`),
  );
  const res = planner.recommend(order, mkContexts(workers));
  assert.deepEqual(res, { ok: false, reason: "no-feasible-crew" });
});

test("人数上限约束下，次优但合法的 8 人内方案被选中", () => {
  // 9 名零代价工人可覆盖全部 9 项技能（违规，9 人）；
  // 工人 10 一人覆盖全部技能但代价 100，配最便宜的凑人数工人（代价 0）。
  const workers: Worker[] = [];
  for (let i = 0; i < 9; i++) {
    workers.push(mkWorker({ id: i + 1, skills: [[`s${i}`, T1]] }));
  }
  workers.push(
    mkWorker({
      id: 10,
      skills: Array.from({ length: 9 }, (_, i) => [`s${i}`, T1] as [string, number]),
      leader: true,
      credit: 0, // 代价 100
    }),
  );
  const planner = new CrewPlanner();
  planner.replaceRoster(workers);
  const order = mkOrder(Array.from({ length: 9 }, (_, i) => `s${i}`));
  const res = planner.recommend(order, mkContexts(workers));
  assert.deepEqual(res, { ok: true, members: [1, 10], leader: 10, totalCost: 100 });
});

test("非法输入被明确拒绝", () => {
  const planner = new CrewPlanner();
  // 重复编号
  assert.ok(() => {
    let threw = false;
    try {
      planner.replaceRoster([mkWorker({ id: 1 }), mkWorker({ id: 1 })]);
    } catch {
      threw = true;
    }
    return threw;
  });
  // 信用分越界
  assert.ok(() => {
    let threw = false;
    try {
      planner.replaceRoster([mkWorker({ id: 1, credit: 101 })]);
    } catch {
      threw = true;
    }
    return threw;
  });
  // 必需技能超过 16 项
  planner.replaceRoster([mkWorker({ id: 1, leader: true })]);
  assert.ok(() => {
    let threw = false;
    try {
      planner.recommend(
        mkOrder(Array.from({ length: 17 }, (_, i) => `s${i}`)),
        [],
      );
    } catch {
      threw = true;
    }
    return threw;
  });
  // 必需技能为空
  assert.ok(() => {
    let threw = false;
    try {
      planner.recommend(mkOrder([]), []);
    } catch {
      threw = true;
    }
    return threw;
  });
});
