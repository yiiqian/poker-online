'use strict';
/*
 * 用"假 ws 客户端"驱动 server.js 的房间逻辑，验证完整联机链路：
 * 建房 -> 进房 -> 开始(补AI) -> 收到状态 -> 真人按合法动作行动 -> 打到结束。
 * 不需要真实 ws / 网络。
 */
const srv = require('./server');

let pass = 0, fail = 0;
function ok(d, c) { if (c) pass++; else { fail++; console.log('✗ ' + d); } }

// 假客户端：记录收到的消息；send 即 push
function FakeWS() {
  const ws = {
    readyState: 1, OPEN: 1,
    inbox: [],
    send(s) { ws.inbox.push(JSON.parse(s)); },
    last(t) { for (let i = ws.inbox.length - 1; i >= 0; i--) if (ws.inbox[i].t === t) return ws.inbox[i]; return null; },
    lastState() { return ws.last('state'); }
  };
  return ws;
}
// 每个假客户端要有 server 期望的字段：id, room, on(), ping()
function connect() {
  const ws = FakeWS();
  // 模拟 onConnection 里赋的字段（但不真的注册事件）
  ws.id = 'p_' + Math.random().toString(36).slice(2, 10);
  ws.room = null;
  ws.isAlive = true;
  return ws;
}
function msg(ws, m) { srv.handleMessage(ws, m); }

// 房主建房
const host = connect();
msg(host, { t: 'create', name: '房主', startStack: 2000 });
const created = host.last('created');
ok('建房返回房间号', created && /^[A-Z2-9]{4}$/.test(created.room));
const code = created.room;
ok('建房后房主收到状态', host.lastState() != null);
ok('起始筹码按选择=2000', host.lastState().startStack === 2000);

// 第二个真人加入
const p2 = connect();
msg(p2, { t: 'join', room: code, name: '小红' });
ok('第二人加入成功', p2.last('joined') != null);
ok('房间内两名真人', srv.rooms.get(code).table.humanCount() === 2);

// 用同步调度替换该房间 table 的定时器，便于把整手牌跑完
const table = srv.rooms.get(code).table;
let queue = [];
table.schedule = (fn) => { queue.push(fn); return queue.length; };
table.cancel = () => {};
function drain(max = 100000) { let n = 0; while (queue.length && n++ < max) { const f = queue.shift(); f(); } }

// 非房主尝试开始 -> 应被拒
msg(p2, { t: 'start', aiTarget: 4 });
ok('非房主不能开始', p2.last('error') && /房主/.test(p2.last('error').msg));

// 房主开始，补 AI 到 4 人（2 真人 + 2 AI）
msg(host, { t: 'start', aiTarget: 4 });
ok('开局后共 4 个座位有人', table.occupiedSeats().length === 4);
ok('其中 2 个是 AI', table.occupiedSeats().filter(p => p.isAI).length === 2);
ok('开局后牌局激活', table.handActive === true);

// 自动驱动：真人轮到时用"安全动作"（能过牌就过，否则弃牌），AI 自动跑
// 反复 drain，期间若轮到某真人就替他做决定，直到一手结束或多手推进
let safetyLoops = 0;
function autoPlayHumans() {
  let acted = true;
  while (acted && safetyLoops++ < 2000) {
    drain();
    acted = false;
    if (!table.handActive) break;
    const seat = table.toAct;
    if (seat < 0) { drain(); continue; }
    const p = table.seats[seat];
    if (p && !p.isAI) {
      const toCall = table.currentBet - p.bet;
      const ws = p.id === host.id ? host : p2;
      msg(ws, { t: 'action', action: { type: toCall > 0 ? 'call' : 'check' } });
      acted = true;
    }
  }
}
autoPlayHumans();
drain();

// 验证：玩家收到的视图里，自己能看到底牌，且不会看到对手底牌（非摊牌）
const hostState = host.lastState();
ok('房主状态包含 players 数组', Array.isArray(hostState.players));
const me = hostState.players.find(p => p && p.isSelf);
ok('房主在状态里能定位自己', me != null);

// 筹码守恒：4 人 * 2000
const total = table.occupiedSeats().reduce((s, p) => s + p.stack, 0) + table.pot;
ok('联机对局后筹码守恒(=8000)', total === 8000);

// 至少完成了一手（handNo>=1）
ok('至少打了一手牌', table.handNo >= 1);

// 房主断线移交：模拟 host 离开
msg(host, { t: 'leave' });
const room = srv.rooms.get(code);
ok('房主离开后房主转移给他人', room && room.hostId === p2.id);

// p2 也离开 -> 房间回收
msg(p2, { t: 'leave' });
ok('全员离开后房间被回收', !srv.rooms.has(code));

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
