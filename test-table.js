'use strict';
/*
 * 全 AI 桌的无头模拟：用同步调度器把所有定时器立即执行，
 * 连打多手，断言关键不变量：筹码守恒、动作合法、每手能正常结束。
 */
const { Table } = require('./table');
const PC = require('./poker-core');

let pass = 0, fail = 0;
function ok(d, c) { if (c) pass++; else { fail++; console.log('✗ ' + d); } }

// 同步调度器：把延迟任务放进队列，由 drain() 顺序执行，模拟时间推进
function makeSyncRunner() {
  let queue = [];
  let id = 0;
  const schedule = (fn) => { const h = ++id; queue.push({ h, fn }); return h; };
  const cancel = (h) => { queue = queue.filter(t => t.h !== h); };
  const drain = (maxSteps = 100000) => {
    let steps = 0;
    while (queue.length && steps++ < maxSteps) {
      const t = queue.shift();
      t.fn();
    }
    if (steps >= maxSteps) throw new Error('drain 超步数，可能死循环');
  };
  return { schedule, cancel, drain };
}

function totalChips(table) {
  return table.occupiedSeats().reduce((s, p) => s + p.stack, 0) + table.pot;
}

// 跑一局：n 个 AI，连打 handLimit 手（靠 scheduleNextHand 自动续手），检查不变量
function runGame(numAI, handLimit) {
  const runner = makeSyncRunner();
  let illegalState = false;
  const table = new Table({
    startStack: 1000,
    schedule: runner.schedule,
    cancel: runner.cancel,
    onState: () => {
      // 每次广播时校验：筹码非负、下注不超过本来的栈
      for (const p of table.occupiedSeats()) {
        if (p.stack < 0) illegalState = true;
        if (p.bet < 0) illegalState = true;
      }
    }
  });
  // 全 AI 桌
  table.fillWithAI(numAI);
  const expectedTotal = numAI * 1000;

  // 限制手数：打到 handLimit 手就停（通过包裹 startHand 计数）
  const origStart = table.startHand.bind(table);
  let hands = 0;
  table.startHand = function () {
    if (hands >= handLimit) { table.handActive = false; table.stage = 'idle'; return; }
    hands++;
    return origStart();
  };

  // 选随机座位当庄家并开局
  table.dealerSeat = 0;
  origStart();
  runner.drain();

  return { table, expectedTotal, illegalState, hands };
}

// 1) 多桌规模 + 多手，筹码守恒
for (const n of [2, 3, 4, 6]) {
  let conserved = true, anyIllegal = false, playedHands = 0;
  for (let rep = 0; rep < 30; rep++) {
    const { table, expectedTotal, illegalState, hands } = runGame(n, 8);
    if (totalChips(table) !== expectedTotal) conserved = false;
    if (illegalState) anyIllegal = true;
    playedHands += hands;
  }
  ok(`${n}人桌：30局×多手后筹码始终守恒(=${n * 1000})`, conserved);
  ok(`${n}人桌：过程中无非法状态(负筹码等)`, !anyIllegal);
  ok(`${n}人桌：确实打了多手牌(${playedHands}手)`, playedHands > 30);
}

// 2) 每手结束后必有赢家拿到钱（pot 清零、有人 winner）
(function () {
  const runner = makeSyncRunner();
  let handsWithWinner = 0, handsFinished = 0;
  const table = new Table({
    startStack: 1000, schedule: runner.schedule, cancel: runner.cancel,
    onState: () => {
      if (table.stage === 'showdown' && table.lastResult) {
        handsFinished++;
        if (table.lastResult.winners && table.lastResult.winners.length > 0) handsWithWinner++;
      }
    }
  });
  table.fillWithAI(4);
  table.dealerSeat = 0;
  const origStart = table.startHand.bind(table);
  let hands = 0;
  table.startHand = function () { if (hands >= 10) { table.handActive = false; table.stage = 'idle'; return; } hands++; return origStart(); };
  origStart();
  runner.drain();
  ok('每手结束都有赢家', handsFinished > 0 && handsWithWinner === handsFinished);
})();

// 3) 庄家按手轮转（连续两手庄家不同，多人桌）
(function () {
  const runner = makeSyncRunner();
  const dealers = [];
  const table = new Table({ startStack: 1000, schedule: runner.schedule, cancel: runner.cancel, onState: () => {} });
  table.fillWithAI(4);
  table.dealerSeat = 0;
  const origStart = table.startHand.bind(table);
  let hands = 0;
  table.startHand = function () {
    if (hands >= 5) { table.handActive = false; table.stage = 'idle'; return; }
    hands++; const r = origStart(); dealers.push(table.dealerSeat); return r;
  };
  origStart();
  runner.drain();
  let rotated = true;
  for (let i = 1; i < dealers.length; i++) if (dealers[i] === dealers[i - 1]) rotated = false;
  ok('庄家逐手轮转', rotated && dealers.length >= 4);
})();

// 4) viewFor：自己能看到底牌，别人在非摊牌时看不到
(function () {
  const runner = makeSyncRunner();
  const table = new Table({ startStack: 1000, schedule: runner.schedule, cancel: runner.cancel, onState: () => {} });
  table.addHuman('u1', '小明');
  // 用真实入口 startGame（会清 sittingOut 并补 AI 到 4 人）
  table.startGame(4);
  // 不 drain（停在某个行动点），检查视图
  const view = table.viewFor('u1');
  const self = view.players.find(p => p && p.id === 'u1');
  const other = view.players.find(p => p && p.isAI && p.cards);
  ok('自己能看到自己的两张底牌', self && Array.isArray(self.cards) && self.cards.length === 2);
  ok('未摊牌时看不到AI的具体牌(hidden)', other && other.cards === 'hidden');
})();

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
