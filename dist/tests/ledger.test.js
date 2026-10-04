"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const node_perf_hooks_1 = require("node:perf_hooks");
const ledger_1 = require("../src/ledger");
const reference_1 = require("../src/reference");
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
function checkAll(ledger, reference, appraisal, totalTokens) {
    const expected = reference.allQuotes();
    let sumQ = 0;
    let sumA = 0n;
    for (const [id, want] of expected) {
        const got = ledger.quote(id);
        strict_1.default.equal(got.quantity, want.quantity, `quantity mismatch for ${id}`);
        strict_1.default.equal(got.amount, want.amount, `amount mismatch for ${id}`);
        sumQ += got.quantity;
        sumA += got.amount;
    }
    strict_1.default.equal(sumQ, totalTokens, "token conservation violated");
    strict_1.default.equal(sumA, appraisal, "cent conservation violated");
}
(0, node_test_1.default)("spec example: N=100, V=4, non-participant amount shifts and restores", () => {
    const holdings = [
        { id: "A", quantity: 10 },
        { id: "B", quantity: 20 },
        { id: "C", quantity: 30 },
        { id: "D", quantity: 40 },
    ];
    const ledger = new ledger_1.VaultMintLedger(100, 4n, holdings);
    const expectQuotes = (want) => {
        let sum = 0n;
        for (const id of ["A", "B", "C", "D"]) {
            const got = ledger.quote(id);
            const w = want[id];
            strict_1.default.equal(got.quantity, w.q, `quantity of ${id}`);
            strict_1.default.equal(got.amount, w.a, `amount of ${id}`);
            sum += got.amount;
        }
        strict_1.default.equal(sum, 4n);
    };
    expectQuotes({
        A: { q: 10, a: 0n },
        B: { q: 20, a: 1n },
        C: { q: 30, a: 1n },
        D: { q: 40, a: 2n },
    });
    ledger.transfer("A", "C", 10);
    expectQuotes({
        A: { q: 0, a: 0n },
        B: { q: 20, a: 1n },
        C: { q: 40, a: 2n },
        D: { q: 40, a: 1n },
    });
    ledger.transfer("C", "A", 10);
    expectQuotes({
        A: { q: 10, a: 0n },
        B: { q: 20, a: 1n },
        C: { q: 30, a: 1n },
        D: { q: 40, a: 2n },
    });
});
(0, node_test_1.default)("randomized cross-check against full-recompute reference", () => {
    const SAFE = BigInt(Number.MAX_SAFE_INTEGER);
    const scenarios = [
        { n: 100, v: 4n, holders: 4, ops: 400, seed: 1 },
        { n: 1000, v: 500n, holders: 40, ops: 1500, seed: 2 },
        { n: 997, v: 1000003n, holders: 60, ops: 1500, seed: 3 },
        { n: 4096, v: SAFE + 123456789n, holders: 80, ops: 1500, seed: 4 },
        { n: 10000, v: (1n << 70n) + 987654321n, holders: 120, ops: 1500, seed: 5 },
        { n: 100, v: 7n, holders: 100, ops: 1200, seed: 6 },
    ];
    for (const sc of scenarios) {
        const rand = mulberry32(sc.seed);
        const holdings = [];
        let remaining = sc.n;
        for (let i = 0; i < sc.holders; i++) {
            const left = sc.holders - i;
            const q = left === 1 ? remaining : 1 + Math.floor(rand() * (remaining - left));
            holdings.push({ id: `h${i}`, quantity: q });
            remaining -= q;
        }
        let appraisal = sc.v;
        const ledger = new ledger_1.VaultMintLedger(sc.n, appraisal, holdings);
        const reference = new reference_1.ReferenceLedger(sc.n, appraisal, holdings);
        checkAll(ledger, reference, appraisal, sc.n);
        let newIdCounter = 0;
        for (let op = 0; op < sc.ops; op++) {
            const roll = rand();
            if (roll < 0.12) {
                const pick = rand();
                if (pick < 0.3) {
                    appraisal = BigInt(1 + Math.floor(rand() * 2 * sc.n));
                }
                else if (pick < 0.6) {
                    appraisal = BigInt(1 + Math.floor(rand() * 1000000));
                }
                else if (pick < 0.8) {
                    appraisal = SAFE + BigInt(1 + Math.floor(rand() * 1000000));
                }
                else {
                    appraisal = (1n << 64n) + BigInt(Math.floor(rand() * 1000000));
                }
                ledger.reappraise(appraisal);
                reference.reappraise(appraisal);
            }
            else {
                const ids = reference.holderIds();
                const from = ids[Math.floor(rand() * ids.length)];
                let to;
                const toRoll = rand();
                if (toRoll < 0.15 || ids.length === 1) {
                    to = `new${newIdCounter++}`;
                }
                else {
                    to = ids[Math.floor(rand() * ids.length)];
                    if (to === from) {
                        to = `new${newIdCounter++}`;
                    }
                }
                const fromQ = reference.quote(from).quantity;
                const quantity = rand() < 0.3 ? fromQ : 1 + Math.floor(rand() * fromQ);
                ledger.transfer(from, to, quantity);
                reference.transfer(from, to, quantity);
            }
            checkAll(ledger, reference, appraisal, sc.n);
        }
        const gone = ledger.quote("h0");
        const goneRef = reference.quote("h0");
        strict_1.default.equal(gone.quantity, goneRef.quantity);
        strict_1.default.equal(gone.amount, goneRef.amount);
        strict_1.default.deepEqual(ledger.quote("never-existed"), { quantity: 0, amount: 0n });
    }
});
(0, node_test_1.default)("tie-heavy remainders and id lexicographic priority", () => {
    const holdings = [];
    for (let i = 0; i < 50; i++) {
        holdings.push({ id: `id${String(i).padStart(3, "0")}`, quantity: 2 });
    }
    const ledger = new ledger_1.VaultMintLedger(100, 50n, holdings);
    const reference = new reference_1.ReferenceLedger(100, 50n, holdings);
    checkAll(ledger, reference, 50n, 100);
    ledger.transfer("id049", "id000", 1);
    reference.transfer("id049", "id000", 1);
    checkAll(ledger, reference, 50n, 100);
    ledger.reappraise(101n);
    reference.reappraise(101n);
    checkAll(ledger, reference, 101n, 100);
});
(0, node_test_1.default)("scale: 100k holders, 20k transfers with interleaved quotes", () => {
    const holderCount = 100000;
    const perHolder = 10;
    const totalTokens = holderCount * perHolder;
    const appraisal = 9999999999999n;
    const holdings = new Array(holderCount);
    const balances = new Map();
    const liveIds = new Array(holderCount);
    for (let i = 0; i < holderCount; i++) {
        const id = `holder${i}`;
        holdings[i] = { id, quantity: perHolder };
        balances.set(id, perHolder);
        liveIds[i] = id;
    }
    const t0 = node_perf_hooks_1.performance.now();
    const ledger = new ledger_1.VaultMintLedger(totalTokens, appraisal, holdings);
    const t1 = node_perf_hooks_1.performance.now();
    const rand = mulberry32(42);
    let currentAppraisal = appraisal;
    let newIdCounter = 0;
    let quoteChecks = 0;
    const conservationCheck = () => {
        let sumQ = 0;
        let sumA = 0n;
        for (const id of liveIds) {
            const q = ledger.quote(id);
            sumQ += q.quantity;
            sumA += q.amount;
        }
        strict_1.default.equal(sumQ, totalTokens);
        strict_1.default.equal(sumA, currentAppraisal);
    };
    for (let op = 0; op < 20000; op++) {
        const roll = rand();
        if (roll < 0.0003) {
            currentAppraisal = appraisal + BigInt(op) * 1000003n;
            ledger.reappraise(currentAppraisal);
        }
        else {
            const fromIdx = Math.floor(rand() * liveIds.length);
            const from = liveIds[fromIdx];
            const fromBal = balances.get(from);
            const quantity = rand() < 0.25 ? fromBal : 1 + Math.floor(rand() * fromBal);
            let to;
            if (rand() < 0.1) {
                to = `joined${newIdCounter++}`;
            }
            else {
                to = liveIds[Math.floor(rand() * liveIds.length)];
                if (to === from)
                    to = `joined${newIdCounter++}`;
            }
            ledger.transfer(from, to, quantity);
            const remaining = fromBal - quantity;
            if (remaining === 0) {
                balances.delete(from);
                liveIds[fromIdx] = liveIds[liveIds.length - 1];
                liveIds.pop();
            }
            else {
                balances.set(from, remaining);
            }
            if (!balances.has(to))
                liveIds.push(to);
            balances.set(to, (balances.get(to) ?? 0) + quantity);
        }
        if (op % 100 === 0) {
            for (let i = 0; i < 20; i++) {
                const id = liveIds[Math.floor(rand() * liveIds.length)];
                const got = ledger.quote(id);
                strict_1.default.equal(got.quantity, balances.get(id));
                quoteChecks++;
            }
        }
        if (op % 5000 === 4999) {
            conservationCheck();
        }
    }
    conservationCheck();
    const t2 = node_perf_hooks_1.performance.now();
    console.log(`[scale] create(${holderCount} holders): ${(t1 - t0).toFixed(1)}ms, ` +
        `20k transfers + ${quoteChecks} quotes + reappraisals: ${(t2 - t1).toFixed(1)}ms, ` +
        `final holders: ${liveIds.length}`);
});
