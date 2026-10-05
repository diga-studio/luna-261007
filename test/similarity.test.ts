import { test } from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { levenshtein, similarity } from '../src';

test('levenshtein computes unit-cost edit distance', () => {
  equal(levenshtein('abcdefghij', 'abcdefghij'), 0);
  equal(levenshtein('abcdefghij', 'abxdefghij'), 1); // substitution
  equal(levenshtein('abcdefghij', 'abxyefghij'), 2); // two substitutions
  equal(levenshtein('abcdefghij', 'abcdefghj'), 1); // deletion
  equal(levenshtein('abcdefghij', 'abcdefghiyj'), 1); // insertion
  equal(levenshtein('kittenabc', 'sittingab'), 4);
});

test('adjacent transposition is not a single edit', () => {
  equal(levenshtein('abcd', 'abdc'), 2);
  equal(similarity('abcd', 'abdc'), 0.5);
});

test('similarity is 1 - d / maxLen', () => {
  equal(similarity('abcdefghij', 'abcdefghij'), 1);
  equal(similarity('abcdefghij', 'abxdefghij'), 0.9);
  equal(similarity('abcdefghij', 'abxyefghij'), 0.8);
  equal(similarity('aaaaaaaaaa', 'aaaaaaaaa'), 0.9);
  ok(Math.abs(similarity('aaaaaaaaa', 'aaaaaaaa') - (1 - 1 / 9)) < 1e-12);
});

test('threshold boundary: 10 * d <= maxLen is the exact cut', () => {
  // d = 1, maxLen = 10 -> similar (10 <= 10)
  ok(10 * levenshtein('abcdefghij', 'xbcdefghij') <= 10);
  // d = 1, maxLen = 9 -> not similar (10 > 9)
  ok(10 * levenshtein('abcdefghi', 'xbcdefghi') > 9);
  // d = 2, maxLen = 20 -> similar (20 <= 20)
  ok(10 * levenshtein('abcdefghijklmnopqrst', 'abcdefghijklmnopqr') <= 20);
  // d = 2, maxLen = 19 -> not similar (20 > 19)
  ok(10 * levenshtein('abcdefghijklmnopqrs', 'abcdefghijklmnopq') > 19);
});
