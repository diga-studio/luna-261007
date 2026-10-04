import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  exactProduct,
  feeOf,
  formatProduct,
  formatUnits,
  isValidDecimal,
  parseUnits,
} from '../src/index.js';

test('parseUnits and formatUnits round-trip', () => {
  assert.equal(parseUnits('0.00000001'), 1n);
  assert.equal(parseUnits('1.5'), 150_000_000n);
  assert.equal(parseUnits('25000'), 2_500_000_000_000n);
  assert.equal(parseUnits('0'), 0n);
  assert.equal(formatUnits(1n), '0.00000001');
  assert.equal(formatUnits(150_000_000n), '1.50000000');
  assert.equal(formatUnits(0n), '0.00000000');
});

test('isValidDecimal accepts only <= 8 fractional digits, non-negative', () => {
  for (const ok of ['0', '1', '1.5', '0.00000001', '123456.12345678']) {
    assert.ok(isValidDecimal(ok), ok);
  }
  for (const bad of ['', 'abc', '-1', '1.', '.5', '1.123456789', '01', '1e3', 'NaN', '1,5']) {
    assert.ok(!isValidDecimal(bad), bad);
  }
});

test('feeOf: 0.1% rounded up to the smallest unit, floored at 0.00010000', () => {
  assert.equal(formatUnits(feeOf(parseUnits('1'))), '0.00100000');
  assert.equal(formatUnits(feeOf(parseUnits('0.01'))), '0.00010000'); // min fee
  assert.equal(formatUnits(feeOf(parseUnits('0.1'))), '0.00010000'); // exactly min
  assert.equal(formatUnits(feeOf(parseUnits('1.00000001'))), '0.00100001'); // ceil
  assert.equal(formatUnits(feeOf(parseUnits('0.05'))), '0.00010000'); // ceil then min
  assert.equal(formatUnits(feeOf(parseUnits('25000'))), '25.00000000');
});

test('exactProduct keeps full precision, formatProduct trims zeros', () => {
  assert.equal(formatProduct(exactProduct(parseUnits('1.5'), parseUnits('20000'))), '30000');
  assert.equal(
    formatProduct(exactProduct(parseUnits('0.00000001'), parseUnits('0.00000001'))),
    '0.0000000000000001',
  );
  assert.equal(
    formatProduct(exactProduct(parseUnits('0.33333333'), parseUnits('3'))),
    '0.99999999',
  );
});
