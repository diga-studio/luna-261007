import { test } from 'node:test';
import { deepEqual, equal, throws } from 'node:assert/strict';
import { GpaLeaderboard, RankEntry } from '../src/index';

function fullBoard(board: GpaLeaderboard): RankEntry[] {
  return board.leaderboard(0, Number.MAX_SAFE_INTEGER);
}

test('exact GPA tie with different total credits shares one rank', () => {
  const board = new GpaLeaderboard();
  // alice: 3.00 exactly, 2.00 total credits.
  board.upsertGrade('alice', 'c1', '3.00', '2.00');
  // bob: 3.00 exactly, 4.00 total credits.
  board.upsertGrade('bob', 'c1', '3.00', '1.00');
  board.upsertGrade('bob', 'c2', '3.00', '3.00');

  deepEqual(board.studentRank('alice'), { studentId: 'alice', gpa: '3.00', rank: 1 });
  deepEqual(board.studentRank('bob'), { studentId: 'bob', gpa: '3.00', rank: 1 });
  deepEqual(fullBoard(board), [
    { studentId: 'alice', gpa: '3.00', rank: 1 },
    { studentId: 'bob', gpa: '3.00', rank: 1 },
  ]);
});

test('same displayed GPA but different exact values must not tie', () => {
  const board = new GpaLeaderboard();
  // alice: exactly 3.000...
  board.upsertGrade('alice', 'c1', '3.00', '1.00');
  // carol: (3.00*1.00 + 3.50*0.01) / 1.01 = 3.00445544... -> displays 3.00 but is strictly higher.
  board.upsertGrade('carol', 'c1', '3.00', '1.00');
  board.upsertGrade('carol', 'c2', '3.50', '0.01');

  deepEqual(board.studentRank('carol'), { studentId: 'carol', gpa: '3.00', rank: 1 });
  deepEqual(board.studentRank('alice'), { studentId: 'alice', gpa: '3.00', rank: 2 });
});

test('display rounding is half-up on the exact value', () => {
  const board = new GpaLeaderboard();
  // (3.00 + 3.01) / 2.00 = 3.005 exactly -> half-up gives 3.01.
  board.upsertGrade('frank', 'c1', '3.00', '1.00');
  board.upsertGrade('frank', 'c2', '3.01', '1.00');
  equal(board.studentRank('frank')!.gpa, '3.01');
  // 3.0049... rounds down to 3.00.
  board.upsertGrade('grace', 'c1', '3.00', '1.00');
  board.upsertGrade('grace', 'c2', '3.49', '0.01');
  equal(board.studentRank('grace')!.gpa, '3.00');
});

test('competition ranking skips ranks after a tie group', () => {
  const board = new GpaLeaderboard();
  board.upsertGrade('dave', 'c1', '4.00', '1.00');
  board.upsertGrade('alice', 'c1', '3.00', '2.00');
  board.upsertGrade('bob', 'c1', '3.00', '4.00');
  board.upsertGrade('erin', 'c1', '2.00', '1.00');

  deepEqual(fullBoard(board), [
    { studentId: 'dave', gpa: '4.00', rank: 1 },
    { studentId: 'alice', gpa: '3.00', rank: 2 },
    { studentId: 'bob', gpa: '3.00', rank: 2 },
    { studentId: 'erin', gpa: '2.00', rank: 4 },
  ]);
});

test('upsert replaces points and credits instead of appending a retake', () => {
  const board = new GpaLeaderboard();
  board.upsertGrade('dave', 'c1', '4.00', '1.00');
  board.upsertGrade('alice', 'c1', '3.00', '1.00');

  // Replace both points and credits of the same course.
  board.upsertGrade('dave', 'c1', '1.00', '3.00');
  deepEqual(board.studentRank('dave'), { studentId: 'dave', gpa: '1.00', rank: 2 });
  deepEqual(board.studentRank('alice'), { studentId: 'alice', gpa: '3.00', rank: 1 });

  // Replacing credits alone keeps the GPA but changes total credits.
  board.upsertGrade('alice', 'c1', '3.00', '6.00');
  deepEqual(board.studentRank('alice'), { studentId: 'alice', gpa: '3.00', rank: 1 });
});

test('removing the last grade drops the student; re-adding re-enters', () => {
  const board = new GpaLeaderboard();
  board.upsertGrade('erin', 'c1', '2.00', '1.00');
  board.upsertGrade('erin', 'c2', '4.00', '1.00');
  board.upsertGrade('alice', 'c1', '3.00', '1.00');
  deepEqual(board.studentRank('erin'), { studentId: 'erin', gpa: '3.00', rank: 1 });

  board.removeGrade('erin', 'c1');
  deepEqual(board.studentRank('erin'), { studentId: 'erin', gpa: '4.00', rank: 1 });

  board.removeGrade('erin', 'c2');
  equal(board.studentRank('erin'), null);
  deepEqual(fullBoard(board), [{ studentId: 'alice', gpa: '3.00', rank: 1 }]);

  // Removing a non-existent grade or student is a no-op.
  board.removeGrade('erin', 'c2');
  board.removeGrade('nobody', 'c1');
  deepEqual(fullBoard(board), [{ studentId: 'alice', gpa: '3.00', rank: 1 }]);

  board.upsertGrade('erin', 'c3', '4.00', '1.00');
  deepEqual(board.studentRank('erin'), { studentId: 'erin', gpa: '4.00', rank: 1 });
});

test('leaderboard pages are exact slices of the full board, across tie groups', () => {
  const board = new GpaLeaderboard();
  board.upsertGrade('s5', 'c1', '4.00', '1.00');
  board.upsertGrade('s1', 'c1', '3.00', '1.00');
  board.upsertGrade('s3', 'c1', '3.00', '2.00');
  board.upsertGrade('s2', 'c1', '3.00', '3.00');
  board.upsertGrade('s4', 'c1', '2.00', '1.00');

  const full = fullBoard(board);
  deepEqual(full, [
    { studentId: 's5', gpa: '4.00', rank: 1 },
    { studentId: 's1', gpa: '3.00', rank: 2 },
    { studentId: 's2', gpa: '3.00', rank: 2 },
    { studentId: 's3', gpa: '3.00', rank: 2 },
    { studentId: 's4', gpa: '2.00', rank: 5 },
  ]);

  // Every page, including ones cutting through the tie group, matches the slice.
  for (let offset = 0; offset <= full.length + 1; offset += 1) {
    for (let limit = 0; limit <= full.length + 1; limit += 1) {
      deepEqual(board.leaderboard(offset, limit), full.slice(offset, offset + limit));
    }
  }
});

test('invalid inputs are rejected', () => {
  const board = new GpaLeaderboard();
  throws(() => board.upsertGrade('a', 'c1', '3.5', '1.00'));
  throws(() => board.upsertGrade('a', 'c1', '3.50', '1.0'));
  throws(() => board.upsertGrade('a', 'c1', '3.50', '0.00'));
  throws(() => board.upsertGrade('a', 'c1', '-1.00', '1.00'));
  throws(() => board.upsertGrade('', 'c1', '3.50', '1.00'));
  throws(() => board.upsertGrade('a', '', '3.50', '1.00'));
  throws(() => board.leaderboard(-1, 10));
  throws(() => board.leaderboard(0, -1));
  throws(() => board.leaderboard(0.5, 10));
});
