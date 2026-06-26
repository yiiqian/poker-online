'use strict';
/* 验证：准备机制（全员就绪才发牌 / 超时坐出）、补码累计、净赢净输。 */
const { Table } = require('./table');

let pass = 0, fail = 0;
function ok(d, c) { if (c) pass++; else { fail++; console.log('✗ ' + d); } }

// 可控调度器：分别保管普通任务和"准备倒计时"任务，便于精确触发
function makeRunner() {
  let tasks = []; let id = 0;
  const schedule = (fn, ms) => { const h = ++id; tasks.push({ h, fn, ms }); return h; };
  const cancel = (h) => { tasks = tasks.filter(t => t.h !== h); };
  // 执行所有"非长倒计时"任务（ms < 10000），把准备倒计时(20000)留着手动触发
  const drainShort = (max = 100000) => {
    let n = 0;
    while (n++ < max) {
      const idx = tasks.findIndex(t => t.ms == null || t.ms < 10000);
      if (idx < 0) break;
      const t = tasks.splice(idx, 1)[0];
      t.fn();
    }
  };
  // 触发等待中的准备倒计时（模拟 20s 到点）
  const fireReadyTimeout = () => {
    const idx = tasks.findIndex(t => t.ms >= 10000);
    if (idx < 0) return false;
    const t = tasks.splice(idx, 1)[0];
    t.fn();
    return true;
  };
  const pending = () => tasks.slice();
  return { schedule, cancel, drainShort, fireReadyTimeout, pending };
}

/* ---------- A. 两个真人：准备阶段必须全员准备才开下一手 ---------- */
(function () {
  const r = makeRunner();
  const table = new Table({ startStack: 1000, schedule: r.schedule, cancel: r.cancel, onState: () => {} });
  table.addHuman('u1', '甲');
  table.addHuman('u2', '乙');
  // 自动替两个真人在牌局中行动（都过牌/弃牌推进），直到进入准备阶段
  function autoPlay() {
    let guard = 0;
    while (guard++ < 3000) {
      r.drainShort();
      if (table.waitingReady) break;
      if (!table.handActive) break;
      const seat = table.toAct;
      if (seat >= 0 && !table.seats[seat].isAI) {
        table.humanAction(table.seats[seat].id, { type: 'fold' });
      } else break;
    }
  }
  table.startGame(0);   // 仅 2 真人，不补 AI
  autoPlay();
  // 第 1 手结束后应进入准备阶段
  ok('一手结束后进入准备阶段', table.waitingReady === true);
  ok('准备阶段 stage=waiting', table.stage === 'waiting');
  ok('准备阶段未发牌(handActive=false)', table.handActive === false);

  // 只有 u1 准备 -> 不应开局
  table.setReady('u1');
  ok('仅一人准备：仍在等待', table.waitingReady === true);
  ok('仅一人准备：未开新手', table.handActive === false);

  // u2 也准备 -> 立即开局
  table.setReady('u2');
  r.drainShort();
  ok('全员准备后：开始新一手', table.handActive === true);
  ok('全员准备后：退出准备阶段', table.waitingReady === false);
})();

/* ---------- B. 超时未准备 -> 坐出，剩余够人则开局 ---------- */
(function () {
  const r = makeRunner();
  const table = new Table({ startStack: 1000, schedule: r.schedule, cancel: r.cancel, onState: () => {} });
  table.addHuman('u1', '甲');
  table.addHuman('u2', '乙');
  function autoPlay() {
    let guard = 0;
    while (guard++ < 3000) {
      r.drainShort();
      if (table.waitingReady || !table.handActive) break;
      const seat = table.toAct;
      if (seat >= 0 && !table.seats[seat].isAI) table.humanAction(table.seats[seat].id, { type: 'fold' });
      else break;
    }
  }
  table.startGame(2);   // 2 真人 + 0：实际就 2 人（aiTarget=2 不增）
  // 补一个 AI 让超时后仍≥2人可开
  table.fillWithAI(3);
  autoPlay();
  ok('B: 进入准备阶段', table.waitingReady === true);
  // 只有 u1 准备，u2 不准备，触发超时
  table.setReady('u1');
  r.fireReadyTimeout();
  r.drainShort();
  const u2 = table.seats[table.seatOf('u2')];
  ok('B: 超时未准备者被坐出', u2 && u2.sittingOut === true);
  ok('B: 超时后仍开了新一手(u1+AI≥2)', table.handActive === true);
})();

/* ---------- C. 补码累计 totalRebuy 正确 ---------- */
(function () {
  const table = new Table({ startStack: 1000, schedule: (fn)=>setTimeout(fn,0), cancel:()=>{}, onState: () => {} });
  table.addHuman('u1', '甲');
  const p = table.seats[table.seatOf('u1')];
  // 手间：输到 100（低于门槛200），补一份起始筹码 +1000
  p.stack = 100;
  table.requestRebuy('u1');
  ok('C: 首次补码 totalRebuy=1000(一份起始)', p.totalRebuy === 1000);
  ok('C: 补码后筹码 = 100 + 1000 = 1100', p.stack === 1100);
  // 再输到 0，再补一份 +1000，累计应为 2000
  p.stack = 0;
  table.requestRebuy('u1');
  ok('C: 二次补码 totalRebuy 累计=2000', p.totalRebuy === 2000);
  ok('C: 二次补码后筹码 = 0 + 1000 = 1000', p.stack === 1000);
})();

/* ---------- D. 净赢/净输计算（视图） ---------- */
(function () {
  const table = new Table({ startStack: 1000, schedule: (fn)=>setTimeout(fn,0), cancel:()=>{}, onState: () => {} });
  table.addHuman('u1', '甲');
  table.addHuman('u2', '乙');
  const p1 = table.seats[table.seatOf('u1')];
  const p2 = table.seats[table.seatOf('u2')];
  // u1 补过 1000(共投入2000)，现有 2500 -> 净 +500
  p1.totalRebuy = 1000; p1.stack = 2500;
  // u2 没补，现有 600 -> 净 -400
  p2.stack = 600;
  const view = table.viewFor('u1');
  const v1 = view.players.find(x => x && x.id === 'u1');
  const v2 = view.players.find(x => x && x.id === 'u2');
  ok('D: u1 totalRebuy=1000', v1.totalRebuy === 1000);
  ok('D: u1 净赢 = 2500-(1000+1000) = +500', v1.net === 500);
  ok('D: u2 净输 = 600-1000 = -400', v2.net === -400);
})();

/* ---------- E. 补码门槛：筹码 >= 200 拒绝，< 200 才可补 ---------- */
(function () {
  const table = new Table({ startStack: 1000, schedule: (fn)=>setTimeout(fn,0), cancel:()=>{}, onState: () => {} });
  table.addHuman('u1', '甲');
  const p = table.seats[table.seatOf('u1')];
  // 筹码 500，高于门槛 -> 拒绝
  p.stack = 500;
  ok('E: 筹码500(>=200)拒绝补码', table.requestRebuy('u1').ok === false);
  // 恰好 200 -> 拒绝（门槛是"低于200"）
  p.stack = 200;
  ok('E: 筹码恰好200拒绝补码', table.requestRebuy('u1').ok === false);
  // 199 -> 允许
  p.stack = 199;
  ok('E: 筹码199(<200)允许补码', table.requestRebuy('u1').ok === true);
  ok('E: 视图暴露 rebuyThreshold=200', table.viewFor('u1').rebuyThreshold === 200);
})();

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
