'use strict';
/* 验证：可变桌大小（2–6）。座位数组长度、补AI上限、满员判断、发牌、筹码守恒。 */
const { Table } = require('./table');

let pass = 0, fail = 0;
function ok(d, c) { if (c) pass++; else { fail++; console.log('✗ ' + d); } }

// 同步调度器
function runner() {
  let q = [], id = 0;
  return {
    schedule: (fn) => { q.push({ id: ++id, fn }); return id; },
    cancel: (h) => { q = q.filter(t => t.id !== h); },
    drain: (max = 100000) => { let n = 0; while (q.length && n++ < max) q.shift().fn(); }
  };
}

// 1) 各种桌大小：座位数组长度正确，maxSeats 被 clamp 到 2–6
for (const [req, expect] of [[2,2],[3,3],[4,4],[5,5],[6,6],[1,2],[9,6]]) {
  const t = new Table({ startStack: 1000, maxSeats: req, onState: () => {} });
  ok(`maxSeats=${req} -> 实际 ${expect}`, t.maxSeats === expect && t.seats.length === expect);
}

// 2) 5 人桌：补 AI 不超过 5；满员后再加人失败
(function () {
  const r = runner();
  const t = new Table({ startStack: 1000, maxSeats: 5, schedule: r.schedule, cancel: r.cancel, onState: () => {} });
  t.addHuman('u1', '甲');
  t.fillWithAI(6);  // 请求 6，但桌子只有 5 座
  ok('5人桌补AI上限=5', t.occupiedSeats().length === 5);
  const seat = t.addHuman('u2', '乙'); // 已满（1真人+4AI），应踢AI补进或失败
  // addHuman 会踢一个 AI 让真人进来，所以仍是 5 人但多了一个真人
  ok('5人桌满员时真人仍可顶替AI入座', t.occupiedSeats().length === 5 && t.humanCount() === 2);
})();

// 3) 各桌大小都能正常发一手并筹码守恒
for (const seats of [2, 3, 5, 6]) {
  const r = runner();
  const t = new Table({ startStack: 1000, maxSeats: seats, schedule: r.schedule, cancel: r.cancel, onState: () => {} });
  t.fillWithAI(seats);
  t.dealerSeat = 0;
  // 限制只打 3 手
  const orig = t.startHand.bind(t);
  let hands = 0;
  t.startHand = function () { if (hands >= 3) { t.handActive = false; t.stage = 'idle'; return; } hands++; return orig(); };
  orig();
  r.drain();
  const total = t.occupiedSeats().reduce((s, p) => s + p.stack, 0) + t.pot;
  ok(`${seats}人桌：发牌正常且筹码守恒(=${seats*1000})`, total === seats * 1000);
  ok(`${seats}人桌：每人发到2张底牌`, t.occupiedSeats().every(p => p.cards.length === 2 || p.out));
}

// 4) 2 人桌（单挑）能正常进行
(function () {
  const r = runner();
  const t = new Table({ startStack: 1000, maxSeats: 2, schedule: r.schedule, cancel: r.cancel, onState: () => {} });
  t.fillWithAI(2);
  t.dealerSeat = 0;
  const orig = t.startHand.bind(t);
  let hands = 0;
  t.startHand = function () { if (hands >= 2) { t.handActive = false; t.stage = 'idle'; return; } hands++; return orig(); };
  orig();
  r.drain();
  ok('2人桌单挑：筹码守恒', t.occupiedSeats().reduce((s, p) => s + p.stack, 0) + t.pot === 2000);
})();

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
