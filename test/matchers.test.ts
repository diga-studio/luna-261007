import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hasEdgeWhitespace,
  matchBoolean,
  matchDate,
  matchEmail,
  matchFloat,
  matchInteger,
  matchUrl,
} from '../src/typeMatchers.js';

const cases = <T extends unknown[]>(
  fn: (...args: T) => boolean,
  yes: T[],
  no: T[],
) => {
  for (const args of yes) assert.equal(fn(...args), true, JSON.stringify(args));
  for (const args of no) assert.equal(fn(...args), false, JSON.stringify(args));
};

test('boolean：仅不区分大小写的 true/false', () => {
  cases(matchBoolean, [['true'], ['FALSE'], ['True']], [
    ['tru'], ['1'], [' true'], ['true '], [''], ['yes'],
  ]);
});

test('integer：可带符号十进制整数，须在安全整数范围', () => {
  cases(
    matchInteger,
    [['0'], ['+0'], ['-12'], ['007'], ['9007199254740991'], ['-9007199254740991']],
    [
      ['9007199254740992'], ['-9007199254740992'], ['1.0'], ['+'], ['--1'],
      ['1e3'], [''], [' 1'], ['1 '], ['１２'],
    ],
  );
});

test('float：整数/小数/指数，须有限；超安全范围纯整数不匹配', () => {
  cases(
    matchFloat,
    [
      ['1'], ['+1'], ['-0.5'], ['1.5'], ['1e5'], ['1E+5'], ['1.5e-10'],
      ['9007199254740992.0'], ['1e308'], ['0.000'],
    ],
    [
      ['1.'], ['.5'], ['1e'], ['1e+'], ['1e400'], ['-1e400'],
      ['9007199254740992'], ['-9007199254740992'],
      ['Infinity'], ['NaN'], ['0x10'], ['1,000'], [''], ['.'],
    ],
  );
});

test('date：严格 MM/DD/YYYY 真实公历日期，年 0001-9999', () => {
  cases(
    matchDate,
    [['01/01/0001'], ['12/31/9999'], ['02/29/2000'], ['02/29/2024'], ['02/28/1900']],
    [
      ['02/29/1900'], ['02/29/2100'], ['04/31/2024'], ['00/10/2024'],
      ['13/01/2024'], ['01/32/2024'], ['1/1/2024'], ['01/1/2024'],
      ['01/01/0000'], ['01/01/10000'], ['2024-01-01'], ['01/01/2024 '], [''],
    ],
  );
});

test('url：WHATWG 语义，http(s):// 开头且主机非空', () => {
  cases(
    matchUrl,
    [
      ['http://example.com'], ['HTTPS://EXAMPLE.COM/x?q=1'],
      ['http://例え.jp/パス'], ['http://user:pass@host:8080/'],
      ['https://127.0.0.1:3000/a'],
    ],
    [
      ['http://'], ['http://?a'], ['ftp://example.com'], ['http:example.com'],
      ['//example.com'], ['http://exa mple.com'], ['http://example.com:99999'],
      ['example.com'], [''],
    ],
  );
});

test('email：单 @、本地字符集、域名段与 TLD 规则', () => {
  cases(
    matchEmail,
    [
      ['a@b.co'], ['a.b%c+d_e@x-y.example.museum'], ['a1@b-c.d-e.fg'],
    ],
    [
      ['a@b.c'], ['a@b'], ['a b@c.de'], ['a@@b.de'], ['@b.de'], ['a@'],
      ['a@-b.de'], ['a@b-.de'], ['a@b..de'], ['ü@b.de'], ['a@b.c_d'],
      ['a@b.c1'], ['a,b@c.de'], [''],
    ],
  );
});

test('hasEdgeWhitespace：Unicode White_Space', () => {
  cases(
    hasEdgeWhitespace,
    [
      [' x'], ['x '], ['\u00A0x'], ['x\u00A0'], ['\u3000x'],
      ['\tx'], ['x\n'], ['\u0085x'], ['x\u1680'], ['\u2007x'],
    ],
    [['x'], [''], ['x y'], ['x\u200By'], ['x\u200By\u200B']],
  );
});
