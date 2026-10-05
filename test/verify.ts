import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { splitByWeek, overlaps, WEEKLY_CAP_MINUTES } from '../src/time.ts';

/**
 * 独立一致性校验：直接从 SQLite 读出固定排班与邀约，
 * 按当前时刻重算有效占用，断言无超额、无重叠、空缺不重复占用。
 */
export function verifyConsistent(dbPath: string, nowMin: number): void {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const shifts = db
      .prepare('SELECT employee_id AS emp, start_min AS s, end_min AS e FROM shifts')
      .all() as unknown as Array<{ emp: string; s: number; e: number }>;
    const valid = db
      .prepare(
        `SELECT i.id AS id, i.gap_id AS gap, i.employee_id AS emp,
                g.start_min AS s, g.end_min AS e
         FROM invitations i JOIN gaps g ON g.id = i.gap_id
         WHERE i.status = 'accepted'
            OR (i.status = 'pending' AND i.deadline_min > ?)`,
      )
      .all(nowMin) as unknown as Array<{
      id: string; gap: string; emp: string; s: number; e: number;
    }>;

    // 每个空缺至多一个有效邀约
    const byGap = new Map<string, number>();
    for (const v of valid) byGap.set(v.gap, (byGap.get(v.gap) ?? 0) + 1);
    for (const [gap, count] of byGap) {
      assert.ok(count <= 1, `gap ${gap} occupied by ${count} valid invitations`);
    }

    // 每名员工：区间不重叠、每周不超 2400 分钟
    const byEmp = new Map<string, Array<{ s: number; e: number }>>();
    const push = (emp: string, s: number, e: number): void => {
      const list = byEmp.get(emp) ?? [];
      list.push({ s, e });
      byEmp.set(emp, list);
    };
    for (const shift of shifts) push(shift.emp, shift.s, shift.e);
    for (const v of valid) push(v.emp, v.s, v.e);
    for (const [emp, intervals] of byEmp) {
      const sorted = [...intervals].sort((a, b) => a.s - b.s);
      for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1]!;
        const curr = sorted[i]!;
        assert.ok(
          !overlaps(prev.s, prev.e, curr.s, curr.e),
          `employee ${emp} has overlapping occupations`,
        );
      }
      const weekMinutes = new Map<number, number>();
      for (const { s, e } of intervals) {
        for (const slice of splitByWeek(s, e)) {
          weekMinutes.set(slice.week, (weekMinutes.get(slice.week) ?? 0) + slice.minutes);
        }
      }
      for (const [week, minutes] of weekMinutes) {
        assert.ok(
          minutes <= WEEKLY_CAP_MINUTES,
          `employee ${emp} week ${week} has ${minutes} minutes > ${WEEKLY_CAP_MINUTES}`,
        );
      }
    }
  } finally {
    db.close();
  }
}
