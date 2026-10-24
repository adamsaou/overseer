import assert from "node:assert/strict";
import { test } from "node:test";
import { divergence, divergenceP, formatP, minP } from "../lib/entropy.ts";

// Every split of the pooled answers, one by one: the definition divergenceP computes cluster by cluster.
function bruteP(a: number[], b: number[]) {
  const labels = a.flatMap((x, i) => Array.from({ length: x + b[i] }, () => i));
  const na = a.reduce((s, x) => s + x, 0);
  const observed = divergence(a, b);
  let hits = 0;
  let total = 0;
  for (let mask = 0; mask < 1 << labels.length; mask++) {
    let bits = 0;
    for (let m = mask; m; m &= m - 1) bits++;
    if (bits !== na) continue;
    const ca = a.map(() => 0);
    const cb = a.map(() => 0);
    labels.forEach((label, i) => (mask & (1 << i) ? ca : cb)[label]++);
    total++;
    if (divergence(ca, cb) >= observed - 1e-9) hits++;
  }
  return hits / total;
}

test("divergenceP matches enumerating every split", () => {
  const cases = [
    [[4, 0], [0, 4]],
    [[3, 1, 0, 0], [0, 0, 3, 1]],
    [[2, 2, 0], [0, 1, 3]],
    [[3, 1], [3, 1]],
    [[1, 1, 1, 1], [1, 1, 1, 1]],
    [[5, 1, 0], [2, 2, 2]],
    [[6, 0, 0], [1, 4, 1]],
    [[2, 1, 1, 1, 1], [0, 2, 2, 1, 1]],
    [[3, 0, 1], [1, 2, 0]],
  ];
  // And some random ones, with up to 7 answers a side.
  let seed = 7;
  const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
  for (let i = 0; i < 40; i++) {
    const k = 1 + rand(5);
    const a = Array.from({ length: k }, () => rand(3));
    const b = Array.from({ length: k }, () => rand(3));
    if (a.some((x) => x) && b.some((x) => x)) cases.push([a, b]);
  }
  for (const [a, b] of cases) assert.ok(Math.abs(divergenceP(a, b) - bruteP(a, b)) < 1e-12, `${JSON.stringify([a, b])}: ${divergenceP(a, b)} vs ${bruteP(a, b)}`);
});

test("the smallest p is the fully separated split and its mirror", () => {
  assert.equal(divergenceP([4, 0], [0, 4]), 2 / 70);
  assert.equal(minP(4), 2 / 70);
  assert.equal(formatP(minP(4)), "0.029");
  assert.equal(formatP(minP(6)), "0.0022");
  assert.equal(formatP(minP(8)), "0.00016");
  assert.ok(Math.abs(divergenceP([6, 0], [0, 6]) - minP(6)) < 1e-15);
  assert.equal(minP(3, 4), 1 / 35);
  // Two clusters per side that never overlap can be paired four ways at n=4, so it's weaker evidence.
  assert.equal(divergenceP([3, 1, 0, 0], [0, 0, 3, 1]), 4 / 70);
});

test("identical answers, or an empty side, give p 1", () => {
  assert.equal(divergenceP([4], [4]), 1);
  assert.equal(divergenceP([2, 2], [2, 2]), 1);
  assert.equal(divergenceP([0, 0], [3, 1]), 1);
});

test("divergenceP stays exact and fast at the largest n a scan allows", () => {
  const started = performance.now();
  // 16 answers in one cluster against 16 different ones: only that split and its mirror are as extreme.
  const one = [16, ...Array(16).fill(0)];
  const spread = [0, ...Array(16).fill(1)];
  assert.ok(Math.abs(divergenceP(one, spread) - minP(16)) < 1e-20);
  const messy = divergenceP([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 3, 3]);
  assert.ok(messy > 0 && messy <= 1);
  assert.ok(performance.now() - started < 2000);
});
