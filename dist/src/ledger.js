"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VaultMintLedger = void 0;
function better(a, b) {
    if (a.rem !== b.rem)
        return a.rem > b.rem;
    return a.id < b.id;
}
class Heap {
    constructor(less) {
        this.less = less;
        this.items = [];
    }
    get length() {
        return this.items.length;
    }
    peek() {
        return this.items[0];
    }
    push(entry) {
        const items = this.items;
        items.push(entry);
        let i = items.length - 1;
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (!this.less(items[i], items[parent]))
                break;
            const tmp = items[i];
            items[i] = items[parent];
            items[parent] = tmp;
            i = parent;
        }
    }
    pop() {
        const items = this.items;
        const top = items[0];
        const last = items.pop();
        if (items.length > 0 && last !== undefined) {
            items[0] = last;
            let i = 0;
            for (;;) {
                const left = i * 2 + 1;
                const right = left + 1;
                let best = i;
                if (left < items.length && this.less(items[left], items[best]))
                    best = left;
                if (right < items.length && this.less(items[right], items[best]))
                    best = right;
                if (best === i)
                    break;
                const tmp = items[i];
                items[i] = items[best];
                items[best] = tmp;
                i = best;
            }
        }
        return top;
    }
    reset(entries) {
        this.items = entries;
        for (let i = (entries.length >> 1) - 1; i >= 0; i--) {
            let j = i;
            for (;;) {
                const left = j * 2 + 1;
                const right = left + 1;
                let best = j;
                if (left < entries.length && this.less(entries[left], entries[best]))
                    best = left;
                if (right < entries.length && this.less(entries[right], entries[best]))
                    best = right;
                if (best === j)
                    break;
                const tmp = entries[j];
                entries[j] = entries[best];
                entries[best] = tmp;
                j = best;
            }
        }
    }
}
class VaultMintLedger {
    constructor(totalTokens, appraisalCents, holdings) {
        this.records = new Map();
        this.holderCount = 0;
        this.sumBases = 0n;
        this.k = 0;
        this.topCount = 0;
        this.topHeap = new Heap((a, b) => better(b, a));
        this.restHeap = new Heap((a, b) => better(a, b));
        this.totalTokens = totalTokens;
        this.nBig = BigInt(totalTokens);
        this.appraisal = appraisalCents;
        for (const h of holdings) {
            this.records.set(h.id, { q: h.quantity, ver: 0, inTop: false });
        }
        this.holderCount = this.records.size;
        this.rebuildRanking();
    }
    transfer(from, to, quantity) {
        const fromRec = this.records.get(from);
        if (fromRec === undefined || fromRec.q < quantity || from === to) {
            throw new Error("invalid transfer");
        }
        this.applyDelta(from, -quantity);
        this.applyDelta(to, quantity);
        this.k = Number(this.appraisal - this.sumBases);
        this.rebalance();
        this.maybeCompact();
    }
    reappraise(appraisalCents) {
        this.appraisal = appraisalCents;
        this.rebuildRanking();
    }
    quote(holderId) {
        const rec = this.records.get(holderId);
        if (rec === undefined)
            return { quantity: 0, amount: 0n };
        const amount = this.baseOf(rec.q) + (rec.inTop ? 1n : 0n);
        return { quantity: rec.q, amount };
    }
    baseOf(q) {
        return (this.appraisal * BigInt(q)) / this.nBig;
    }
    remOf(q) {
        return Number((this.appraisal * BigInt(q)) % this.nBig);
    }
    applyDelta(id, delta) {
        let rec = this.records.get(id);
        if (rec === undefined) {
            rec = { q: 0, ver: 0, inTop: false };
            this.records.set(id, rec);
            this.holderCount++;
        }
        else {
            this.sumBases -= this.baseOf(rec.q);
            this.removeLive(rec);
        }
        rec.q += delta;
        if (rec.q === 0) {
            this.records.delete(id);
            this.holderCount--;
            return;
        }
        this.sumBases += this.baseOf(rec.q);
        this.insertLive(id, rec);
    }
    removeLive(rec) {
        rec.ver++;
        if (!rec.inTop)
            return;
        rec.inTop = false;
        this.topCount--;
        if (this.topCount < this.k) {
            this.discardStale(this.restHeap);
            const promoted = this.restHeap.peek();
            if (promoted !== undefined) {
                this.restHeap.pop();
                this.topHeap.push(promoted);
                this.records.get(promoted.id).inTop = true;
                this.topCount++;
            }
        }
    }
    insertLive(id, rec) {
        const entry = { id, rem: this.remOf(rec.q), ver: rec.ver };
        if (this.topCount < this.k) {
            this.topHeap.push(entry);
            rec.inTop = true;
            this.topCount++;
            return;
        }
        if (this.k === 0) {
            this.restHeap.push(entry);
            return;
        }
        this.discardStale(this.topHeap);
        const worst = this.topHeap.peek();
        if (better(entry, worst)) {
            const demoted = this.topHeap.pop();
            this.restHeap.push(demoted);
            this.records.get(demoted.id).inTop = false;
            this.topHeap.push(entry);
            rec.inTop = true;
        }
        else {
            this.restHeap.push(entry);
        }
    }
    discardStale(heap) {
        for (;;) {
            const top = heap.peek();
            if (top === undefined)
                return;
            const rec = this.records.get(top.id);
            if (rec !== undefined && rec.ver === top.ver)
                return;
            heap.pop();
        }
    }
    rebalance() {
        const target = Math.min(this.k, this.holderCount);
        while (this.topCount > target) {
            this.discardStale(this.topHeap);
            const demoted = this.topHeap.pop();
            this.restHeap.push(demoted);
            this.records.get(demoted.id).inTop = false;
            this.topCount--;
        }
        while (this.topCount < target) {
            this.discardStale(this.restHeap);
            const promoted = this.restHeap.pop();
            this.topHeap.push(promoted);
            this.records.get(promoted.id).inTop = true;
            this.topCount++;
        }
    }
    maybeCompact() {
        const total = this.topHeap.length + this.restHeap.length;
        if (total > 4 * this.holderCount + 64) {
            this.rebuildRanking();
        }
    }
    rebuildRanking() {
        const entries = [];
        this.sumBases = 0n;
        for (const [id, rec] of this.records) {
            this.sumBases += this.baseOf(rec.q);
            rec.inTop = false;
            entries.push({ id, rem: this.remOf(rec.q), ver: rec.ver });
        }
        this.k = Number(this.appraisal - this.sumBases);
        entries.sort((a, b) => {
            if (a.rem !== b.rem)
                return b.rem - a.rem;
            return a.id < b.id ? -1 : 1;
        });
        const target = Math.min(this.k, this.holderCount);
        const topEntries = entries.slice(0, target);
        const restEntries = entries.slice(target);
        for (const e of topEntries) {
            this.records.get(e.id).inTop = true;
        }
        this.topCount = topEntries.length;
        this.topHeap.reset(topEntries);
        this.restHeap.reset(restEntries);
    }
}
exports.VaultMintLedger = VaultMintLedger;
