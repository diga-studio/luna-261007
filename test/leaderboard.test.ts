import { test, describe } from "node:test";
import { equal, deepEqual, throws } from "node:assert/strict";
import { GpaLeaderboard } from "../src/index";

describe("deterministic cases", () => {
  test("mathematically equal GPA with different total credits are tied", () => {
    const board = new GpaLeaderboard();
    // alice: 3.00 * 2.00 / 2.00 = 3.00, total credits 2.00
    board.upsertGrade("alice", "c1", "3.00", "2.00");
    // bob: (4.00*2.00 + 2.00*2.00) / 4.00 = 3.00, total credits 4.00
    board.upsertGrade("bob", "c1", "4.00", "2.00");
    board.upsertGrade("bob", "c2", "2.00", "2.00");

    deepEqual(board.studentRank("alice"), { studentId: "alice", gpa: "3.00", rank: 1 });
    deepEqual(board.studentRank("bob"), { studentId: "bob", gpa: "3.00", rank: 1 });
    deepEqual(
      board.leaderboard(0, 10).map((e) => [e.studentId, e.rank]),
      [["alice", 1], ["bob", 1]],
    );
  });

  test("same display GPA but different exact values are not tied", () => {
    const board = new GpaLeaderboard();
    // alice: exactly 3.75
    board.upsertGrade("alice", "c1", "3.75", "1.00");
    // bob: (4.00 + 3.49) / 2 = 3.745, displays 3.75 half-up but is strictly lower
    board.upsertGrade("bob", "c1", "4.00", "1.00");
    board.upsertGrade("bob", "c2", "3.49", "1.00");

    deepEqual(board.studentRank("alice"), { studentId: "alice", gpa: "3.75", rank: 1 });
    deepEqual(board.studentRank("bob"), { studentId: "bob", gpa: "3.75", rank: 2 });
  });

  test("half-up rounding of display GPA", () => {
    const board = new GpaLeaderboard();
    // 3.755 exactly -> 3.76
    board.upsertGrade("up", "c1", "4.00", "1.00");
    board.upsertGrade("up", "c2", "3.51", "1.00");
    equal(board.studentRank("up")!.gpa, "3.76");
    // 3.754 exactly -> 3.75
    board.upsertGrade("down", "c1", "4.00", "1.00");
    board.upsertGrade("down", "c2", "3.51", "1.01");
    // (4.00*1.00 + 3.51*1.01) / 2.01 = 7.5451/2.01 = 3.75378... -> 3.75
    equal(board.studentRank("down")!.gpa, "3.75");
  });

  test("upsert replaces the previous grade of the same course", () => {
    const board = new GpaLeaderboard();
    board.upsertGrade("alice", "c1", "4.00", "3.00");
    board.upsertGrade("alice", "c1", "1.00", "1.00");
    // If appended instead of replaced, GPA would be (12+1)/4 = 3.25.
    deepEqual(board.studentRank("alice"), { studentId: "alice", gpa: "1.00", rank: 1 });
  });

  test("removing the last course drops the student from the board", () => {
    const board = new GpaLeaderboard();
    board.upsertGrade("alice", "c1", "4.00", "2.00");
    board.upsertGrade("bob", "c1", "3.00", "2.00");
    board.removeGrade("alice", "c1");
    equal(board.studentRank("alice"), null);
    deepEqual(board.leaderboard(0, 10).map((e) => e.studentId), ["bob"]);
    // Removing again or removing unknown grades is a no-op.
    board.removeGrade("alice", "c1");
    board.removeGrade("bob", "nope");
    board.removeGrade("nobody", "c1");
    deepEqual(board.leaderboard(0, 10).map((e) => e.studentId), ["bob"]);
  });

  test("competition ranking skips after ties", () => {
    const board = new GpaLeaderboard();
    board.upsertGrade("a", "c1", "4.00", "1.00");
    board.upsertGrade("b", "c1", "4.00", "2.00");
    board.upsertGrade("c", "c1", "3.00", "1.00");
    board.upsertGrade("d", "c1", "2.00", "1.00");
    deepEqual(
      board.leaderboard(0, 10).map((e) => [e.studentId, e.rank]),
      [["a", 1], ["b", 1], ["c", 3], ["d", 4]],
    );
  });

  test("ties are ordered by studentId ASCII ascending", () => {
    const board = new GpaLeaderboard();
    board.upsertGrade("b", "c1", "3.00", "1.00");
    board.upsertGrade("A", "c1", "3.00", "1.00");
    board.upsertGrade("a", "c1", "3.00", "1.00");
    deepEqual(board.leaderboard(0, 10).map((e) => e.studentId), ["A", "a", "b"]);
  });

  test("pagination slices match the full board across tie groups", () => {
    const board = new GpaLeaderboard();
    board.upsertGrade("s1", "c1", "4.00", "1.00");
    board.upsertGrade("s2", "c1", "3.50", "1.00");
    board.upsertGrade("s3", "c1", "3.50", "3.00");
    board.upsertGrade("s4", "c1", "3.00", "1.00");
    board.upsertGrade("s5", "c1", "2.00", "1.00");

    const full = board.leaderboard(0, 100);
    deepEqual(full.map((e) => [e.studentId, e.rank]), [
      ["s1", 1], ["s2", 2], ["s3", 2], ["s4", 4], ["s5", 5],
    ]);
    // Page size 2 splits the tie group {s2, s3} across pages.
    const pages = [board.leaderboard(0, 2), board.leaderboard(2, 2), board.leaderboard(4, 2)];
    deepEqual(pages.flat(), full);
    deepEqual(pages[1].map((e) => [e.studentId, e.rank]), [["s3", 2], ["s4", 4]]);
    // Offsets past the end and zero limit yield empty pages.
    deepEqual(board.leaderboard(5, 3), []);
    deepEqual(board.leaderboard(0, 0), []);
  });

  test("re-entry after dropping out and tie break-up by update", () => {
    const board = new GpaLeaderboard();
    board.upsertGrade("alice", "c1", "3.00", "1.00");
    board.upsertGrade("bob", "c1", "3.00", "1.00");
    deepEqual(board.leaderboard(0, 10).map((e) => [e.studentId, e.rank]), [
      ["alice", 1], ["bob", 1],
    ]);
    // Break the tie by replacing bob's grade.
    board.upsertGrade("bob", "c1", "4.00", "1.00");
    deepEqual(board.leaderboard(0, 10).map((e) => [e.studentId, e.rank]), [
      ["bob", 1], ["alice", 2],
    ]);
    // Bob drops out and re-enters with a lower GPA.
    board.removeGrade("bob", "c1");
    equal(board.studentRank("bob"), null);
    board.upsertGrade("bob", "c2", "2.00", "1.00");
    deepEqual(board.leaderboard(0, 10).map((e) => [e.studentId, e.rank]), [
      ["alice", 1], ["bob", 2],
    ]);
  });

  test("input validation", () => {
    const board = new GpaLeaderboard();
    throws(() => board.upsertGrade("a", "c1", "3.5", "1.00"));
    throws(() => board.upsertGrade("a", "c1", "3.50", "1.5"));
    throws(() => board.upsertGrade("a", "c1", "3.50", "0.00"));
    throws(() => board.upsertGrade("a", "c1", "-1.00", "1.00"));
    throws(() => board.upsertGrade("a", "c1", "abc", "1.00"));
    throws(() => board.upsertGrade("", "c1", "3.50", "1.00"));
    throws(() => board.upsertGrade("a", "", "3.50", "1.00"));
    throws(() => board.leaderboard(-1, 10));
    throws(() => board.leaderboard(0, -1));
    throws(() => board.leaderboard(0.5, 10));
    equal(board.studentRank("ghost"), null);
    deepEqual(board.leaderboard(0, 10), []);
  });
});
