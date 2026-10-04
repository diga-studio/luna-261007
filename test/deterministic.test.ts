import test from "node:test";
import assert from "node:assert/strict";
import { WaitlistEngine } from "../src/index.ts";
import type { RegistrationStatus } from "../src/index.ts";

function statusMap(engine: WaitlistEngine): Map<number, RegistrationStatus> {
  const map = new Map<number, RegistrationStatus>();
  for (const registration of engine.inspect().registrations) {
    map.set(registration.id, registration.status);
  }
  return map;
}

test("队首团队人数超过容量时，后续小团队仍可录取", () => {
  const engine = new WaitlistEngine({ capacities: [3] });
  const tooBig = engine.register(0, ["a", "b", "c", "d"]);
  const fits = engine.register(0, ["e", "f", "g"]);
  const alsoFits = engine.register(0, ["h"]);

  const statuses = statusMap(engine);
  assert.equal(statuses.get(tooBig), "waitlisted");
  assert.equal(statuses.get(fits), "admitted");
  assert.equal(statuses.get(alsoFits), "waitlisted");
  assert.equal(engine.inspect().tracks[0]?.occupied, 3);
});

test("队首候补因成员冲突不可录取时，后续无冲突报名照常录取", () => {
  const engine = new WaitlistEngine({ capacities: [2, 2] });
  const holder = engine.register(0, ["x"]);
  const blocked = engine.register(0, ["x", "y"]);
  const free = engine.register(1, ["z"]);

  const statuses = statusMap(engine);
  assert.equal(statuses.get(holder), "admitted");
  assert.equal(statuses.get(blocked), "waitlisted");
  assert.equal(statuses.get(free), "admitted");
});

test("撤回A赛道团队后：更早的B候补先录取并阻断A候补，C赛道继续递补", () => {
  // A(0) 与 B(1) 冲突，A(0) 与 C(2) 冲突，B(1) 与 C(2) 不冲突。
  const engine = new WaitlistEngine({
    capacities: [2, 1, 1],
    conflicts: [
      [0, 1],
      [0, 2],
    ],
  });

  const aHolder = engine.register(0, ["x", "z"]); // 录取到 A，占用成员 x、z
  const bWait = engine.register(1, ["x"]); // 候补：x 已录取在冲突赛道 A
  const aWait = engine.register(0, ["x"]); // 候补：A 已满且 x 冲突
  const cWait = engine.register(2, ["z"]); // 候补：z 已录取在冲突赛道 A

  const statuses = statusMap(engine);
  assert.equal(statuses.get(aHolder), "admitted");
  assert.equal(statuses.get(bWait), "waitlisted");
  assert.equal(statuses.get(aWait), "waitlisted");
  assert.equal(statuses.get(cWait), "waitlisted");

  engine.withdraw(aHolder);
  // 释放 A 的容量与成员 x、z 后按序号递补：
  // bWait(seq 1) 先录取到 B；x 随即使 aWait 在冲突维度上再次被阻断；
  // cWait(seq 3) 与 B 不冲突，继续递补到 C。
  const after = statusMap(engine);
  assert.equal(after.get(bWait), "admitted");
  assert.equal(after.get(aWait), "waitlisted");
  assert.equal(after.get(cWait), "admitted");
  const tracks = engine.inspect().tracks;
  assert.equal(tracks[0]?.occupied, 0);
  assert.equal(tracks[1]?.occupied, 1);
  assert.equal(tracks[2]?.occupied, 1);
});

test("成员重叠使B候补录取后阻断A候补（冲突非传递）", () => {
  // A(0)-B(1) 冲突，B(1)-C(2) 冲突，A(0)-C(2) 不冲突。
  const engine = new WaitlistEngine({
    capacities: [1, 1, 1],
    conflicts: [
      [0, 1],
      [1, 2],
    ],
  });

  const aHolder = engine.register(0, ["shared"]); // 录取到 A
  const bWait = engine.register(1, ["shared"]); // 候补：shared 在冲突赛道 A 已录取
  const aWait = engine.register(0, ["other"]); // 候补：A 满
  const cWait = engine.register(2, ["shared"]); // 候补：shared 在 A 已录取，但 A 与 C 不冲突 -> 可录取

  let statuses = statusMap(engine);
  assert.equal(statuses.get(cWait), "admitted"); // 非传递：A 录取不阻断 C

  engine.withdraw(aHolder);
  // 释放后按序号递补：bWait(seq 1) 仍被阻断——shared 已录取在 C，而 B 与 C 冲突；
  // aWait(seq 2) 成员是 other，获得 A 的容量后录取。
  statuses = statusMap(engine);
  assert.equal(statuses.get(bWait), "waitlisted");
  assert.equal(statuses.get(aWait), "admitted");

  // 撤回候补 bWait：cWait 已录取不受影响。
  engine.withdraw(bWait);
  statuses = statusMap(engine);
  assert.equal(statuses.get(bWait), "withdrawn");
  assert.equal(statuses.get(cWait), "admitted");
});

test("同一成员被已录取报名占用时，冲突赛道上的候补被阻断", () => {
  const engine = new WaitlistEngine({
    capacities: [2, 2],
    conflicts: [[0, 1]],
  });

  const first = engine.register(0, ["m"]);
  const conflicting = engine.register(1, ["m"]);
  const sameTrack = engine.register(0, ["m"]);
  const unrelated = engine.register(1, ["n"]);

  const statuses = statusMap(engine);
  assert.equal(statuses.get(first), "admitted");
  assert.equal(statuses.get(conflicting), "waitlisted"); // 赛道冲突
  assert.equal(statuses.get(sameTrack), "waitlisted"); // 同赛道即冲突
  assert.equal(statuses.get(unrelated), "admitted");
});

test("撤回已录取报名释放整个团队名额并触发递补", () => {
  const engine = new WaitlistEngine({ capacities: [4] });
  const team = engine.register(0, ["a", "b", "c"]);
  const big = engine.register(0, ["d", "e", "f"]);
  const small = engine.register(0, ["g"]);

  let statuses = statusMap(engine);
  assert.equal(statuses.get(team), "admitted");
  assert.equal(statuses.get(big), "waitlisted");
  assert.equal(statuses.get(small), "admitted");
  assert.equal(engine.inspect().tracks[0]?.occupied, 4);

  engine.withdraw(team);
  statuses = statusMap(engine);
  assert.equal(statuses.get(big), "admitted");
  assert.equal(engine.inspect().tracks[0]?.occupied, 4);
});

test("撤回候补不影响其他报名，且不再参与递补", () => {
  const engine = new WaitlistEngine({ capacities: [1] });
  const holder = engine.register(0, ["a"]);
  const waiting = engine.register(0, ["b"]);

  engine.withdraw(waiting);
  assert.equal(statusMap(engine).get(waiting), "withdrawn");

  engine.withdraw(holder);
  const statuses = statusMap(engine);
  assert.equal(statuses.get(waiting), "withdrawn");
  assert.equal(engine.inspect().tracks[0]?.occupied, 0);
});

test("inspect 返回严格递增且不变的创建序号", () => {
  const engine = new WaitlistEngine({ capacities: [1] });
  const ids = [
    engine.register(0, ["a"]),
    engine.register(0, ["b"]),
    engine.register(0, ["c"]),
  ];
  assert.deepEqual(ids, [0, 1, 2]);
  engine.withdraw(ids[1] as number);
  const snapshot = engine.inspect();
  assert.deepEqual(
    snapshot.registrations.map((registration) => registration.seq),
    [0, 1, 2],
  );
});

test("非法输入被拒绝", () => {
  const engine = new WaitlistEngine({ capacities: [2] });
  assert.throws(() => engine.register(1, ["a"]));
  assert.throws(() => engine.register(0, []));
  assert.throws(() => engine.register(0, ["a", "a"]));
  assert.throws(() => engine.withdraw(999));
  const id = engine.register(0, ["a"]);
  engine.withdraw(id);
  assert.throws(() => engine.withdraw(id));
});
