'use strict';
/*
 * table.js —— 单桌德州扑克游戏引擎（服务器端权威逻辑）。
 * 负责：座位、发牌、四轮下注、AI 补位决策、街道推进、摊牌分池、自动开下一手。
 * 不直接碰网络：通过注入的 onState() 回调广播状态；用注入的 schedule() 安排 AI/延迟。
 *
 * 座位模型：seats 是长度 MAX_SEATS 的数组，元素为 null（空）或 player 对象。
 * player = { id, name, isAI, persona, stack, cards, bet, totalBet,
 *            folded, allIn, out, actedThisRound, connected, lastAction, sittingOut }
 */
const PC = require('./poker-core');

const STAGE_NEXT = { preflop: 'flop', flop: 'turn', turn: 'river' };

class Table {
  // opts: { startStack, maxSeats, onState, schedule, log }
  constructor(opts) {
    this.startStack = opts.startStack || 1000;
    // 桌子座位数，2–6，默认 6。每个房间可不同。
    this.maxSeats = Math.min(PC.MAX_SEATS, Math.max(2, opts.maxSeats || PC.MAX_SEATS));
    this.onState = opts.onState || (() => {});
    // schedule(fn, ms) -> 返回可取消的 handle；默认用 setTimeout
    this.schedule = opts.schedule || ((fn, ms) => setTimeout(fn, ms));
    this.cancel = opts.cancel || ((h) => clearTimeout(h));
    this.log = opts.log || (() => {});

    this.seats = new Array(this.maxSeats).fill(null);
    this.deck = [];
    this.board = [];
    this.pot = 0;
    this.stage = 'idle';   // idle | preflop | flop | turn | river | showdown
    this.currentBet = 0;
    this.minRaise = PC.BIG_BLIND;
    this.dealerSeat = -1;
    this.toAct = -1;       // 座位号
    this.handActive = false;
    this.handNo = 0;
    this.lastResult = null; // 上一手摊牌结果（给前端展示）
    this.waitingReady = false;  // 是否处于"等待准备"阶段
    this.readyDeadline = 0;     // 准备倒计时截止时间戳
    this._aiTimer = null;
    this._autoTimer = null;
    this._readyTimer = null;
  }

  /* ---------- 座位管理 ---------- */
  occupiedSeats() { return this.seats.filter(p => p); }
  humanCount() { return this.seats.filter(p => p && !p.isAI).length; }
  seatOf(id) { return this.seats.findIndex(p => p && p.id === id); }

  firstEmptySeat() { return this.seats.findIndex(s => s === null); }

  addHuman(id, name) {
    let seat = this.firstEmptySeat();
    if (seat === -1) {
      // 没有空位：尝试踢掉一个 AI
      seat = this.seats.findIndex(p => p && p.isAI);
      if (seat === -1) return -1; // 满了
    }
    this.seats[seat] = {
      id, name, isAI: false, persona: null,
      stack: this.startStack, cards: [], bet: 0, totalBet: 0,
      folded: true, allIn: false, out: false, actedThisRound: false,
      connected: true, lastAction: '', sittingOut: true,
      totalRebuy: 0, ready: false
    };
    this.log(`玩家 ${name} 坐到座位 ${seat}`);
    return seat;
  }

  removeHuman(id) {
    const seat = this.seatOf(id);
    if (seat === -1) return;
    const p = this.seats[seat];
    this.log(`玩家 ${p.name} 离开座位 ${seat}`);
    // 牌局进行中：标记弃牌+出局，座位空出留待结算
    if (this.handActive && !p.folded) p.folded = true;
    this.seats[seat] = null;
  }

  setConnected(id, val) {
    const seat = this.seatOf(id);
    if (seat !== -1) this.seats[seat].connected = val;
  }

  // 中途补码：每次补"一整份起始筹码"（如起始2000则 +2000，不论当前剩多少）。
  // 进行中申请则下一手生效。返回 { ok, err, immediate }。
  requestRebuy(id) {
    const seat = this.seatOf(id);
    if (seat === -1) return { ok: false, err: '你不在座位上' };
    const p = this.seats[seat];
    if (p.isAI) return { ok: false, err: '电脑玩家不能补码' };
    // 补码门槛：筹码必须低于 REBUY_THRESHOLD 才能补
    if (p.stack >= Table.REBUY_THRESHOLD) return { ok: false, err: `筹码需低于 ${Table.REBUY_THRESHOLD} 才能补码（当前 ${p.stack}）` };
    // 当前手牌进行中且该玩家还在这手里：标记待处理，下一手生效
    if (this.handActive && !p.folded && !p.out) {
      p.pendingRebuy = true;
      return { ok: true, immediate: false };
    }
    // 否则（手间/已出局/已弃牌且想下手回来）立即补一份起始筹码，并解除出局/坐出
    p.totalRebuy = (p.totalRebuy || 0) + this.startStack;
    p.stack += this.startStack;
    p.out = false;
    p.sittingOut = false;
    p.pendingRebuy = false;
    return { ok: true, immediate: true };
  }

  // 把所有待处理的补码兑现（在 startHand 开头调用），每份 +startStack
  applyPendingRebuys() {
    for (const p of this.occupiedSeats()) {
      if (p.pendingRebuy) {
        p.totalRebuy = (p.totalRebuy || 0) + this.startStack;
        p.stack += this.startStack;
        p.out = false;
        p.sittingOut = false;
        p.pendingRebuy = false;
      }
    }
  }

  // 用 AI 把空座位补满到目标人数（至少 2 人能开局），不超过本桌座位数
  fillWithAI(targetCount) {
    targetCount = Math.min(targetCount, this.maxSeats);
    const usedNames = new Set(this.occupiedSeats().filter(p => p.isAI).map(p => p.persona.name));
    let personaIdx = 0;
    while (this.occupiedSeats().length < targetCount) {
      const seat = this.firstEmptySeat();
      if (seat === -1) break;
      // 取一个未使用的性格
      let persona = null;
      while (personaIdx < PC.AI_PERSONALITIES.length) {
        const cand = PC.AI_PERSONALITIES[personaIdx++];
        if (!usedNames.has(cand.name)) { persona = cand; break; }
      }
      if (!persona) persona = PC.AI_PERSONALITIES[seat % PC.AI_PERSONALITIES.length];
      usedNames.add(persona.name);
      this.seats[seat] = {
        id: 'ai_' + seat, name: persona.name + '(电脑)', isAI: true, persona,
        stack: this.startStack, cards: [], bet: 0, totalBet: 0,
        folded: true, allIn: false, out: false, actedThisRound: false,
        connected: true, lastAction: '', sittingOut: false
      };
    }
  }

  // 移除所有 AI（真人够了想清场时用；保留有筹码的不强制）
  removeAllAI() {
    for (let i = 0; i < this.seats.length; i++) {
      if (this.seats[i] && this.seats[i].isAI) this.seats[i] = null;
    }
  }

  /* ---------- 开局 ---------- */
  // 由房主触发。aiTarget：补 AI 到几人（2..6）；0 表示不补
  startGame(aiTarget) {
    // 让坐着的真人重新入局
    for (const p of this.occupiedSeats()) { p.sittingOut = false; p.out = false; if (p.stack <= 0) p.stack = this.startStack; }
    if (aiTarget && aiTarget > this.occupiedSeats().length) this.fillWithAI(aiTarget);
    if (this.occupiedSeats().length < 2) { return false; }
    if (this.dealerSeat === -1) {
      // 随机选一个庄家
      const occ = this.seats.map((p, i) => p ? i : -1).filter(i => i >= 0);
      this.dealerSeat = occ[Math.floor(Math.random() * occ.length)];
    }
    this.startHand();
    return true;
  }

  // 还能继续游戏的玩家（有筹码、没坐出）
  alivePlayers() { return this.occupiedSeats().filter(p => !p.out && p.stack > 0 && !p.sittingOut); }

  startHand() {
    // 先兑现上一手期间提交的补码请求
    this.applyPendingRebuys();
    // 淘汰没钱的
    for (const p of this.occupiedSeats()) { if (p.stack <= 0) p.out = true; }
    const alive = this.alivePlayers();
    if (alive.length < 2) {
      this.handActive = false;
      this.stage = 'idle';
      this.broadcast({ msg: '人数不足，等待更多玩家或补充 AI。' });
      return;
    }
    this.handNo++;
    this.deck = PC.shuffle(PC.makeDeck());
    this.board = [];
    this.pot = 0;
    this.currentBet = 0;
    this.minRaise = PC.BIG_BLIND;
    this.stage = 'preflop';
    this.handActive = true;
    this.lastResult = null;
    for (const p of this.occupiedSeats()) {
      p.cards = []; p.bet = 0; p.totalBet = 0;
      p.folded = p.out || p.stack <= 0 || p.sittingOut;
      p.allIn = false; p.actedThisRound = false; p.lastAction = '';
      p.winner = false; p.revealRank = '';
    }
    // 移动庄家到下一个 alive 座位
    this.dealerSeat = this.nextAliveSeat(this.dealerSeat);

    // 发牌顺序：从庄家下家开始
    const order = this.aliveOrderFrom(this.nextAliveSeat(this.dealerSeat, true));
    for (let r = 0; r < 2; r++) for (const s of order) this.seats[s].cards.push(this.deck.pop());

    // 盲注
    const sbSeat = order[0];
    const bbSeat = order[1 % order.length];
    this.postBlind(sbSeat, PC.SMALL_BLIND, '小盲');
    this.postBlind(bbSeat, PC.BIG_BLIND, '大盲');
    this.currentBet = PC.BIG_BLIND;
    // 翻前首个行动 = 大盲下家
    const bbPos = order.indexOf(bbSeat);
    this.toAct = order[(bbPos + 1) % order.length];

    this.broadcast({ msg: `第 ${this.handNo} 手开始` });
    this.proceed();
  }

  postBlind(seat, amount, label) {
    const p = this.seats[seat];
    const pay = Math.min(amount, p.stack);
    p.stack -= pay; p.bet += pay; p.totalBet += pay; this.pot += pay;
    if (p.stack === 0) p.allIn = true;
    p.lastAction = label;
  }

  /* ---------- 座位顺序工具 ---------- */
  // 下一个"还在游戏中"的座位（用于庄家移动）。includeForFirstAction: 仅排除 out/空
  nextAliveSeat(from, forDeal) {
    for (let i = 1; i <= this.seats.length; i++) {
      const idx = (from + i) % this.seats.length;
      const p = this.seats[idx];
      if (p && !p.out && p.stack > 0 && !p.sittingOut) return idx;
    }
    return from;
  }
  aliveOrderFrom(startSeat) {
    const order = [];
    for (let i = 0; i < this.seats.length; i++) {
      const idx = (startSeat + i) % this.seats.length;
      const p = this.seats[idx];
      if (p && !p.out && p.stack >= 0 && !p.sittingOut && !p.folded) order.push(idx);
    }
    // 上面已排除 folded，但开局时 folded 仅对 out/sittingOut 为 true，正常玩家 folded=false
    return order;
  }

  inHand() { return this.occupiedSeats().filter(p => !p.folded && !p.out); }

  /* ---------- 核心循环 ---------- */
  proceed() {
    const live = this.inHand();
    if (live.length === 1) { this.endHandSingle(live[0]); return; }
    if (this.bettingComplete()) { this.nextStreet(); return; }

    if (this.toAct === -1 || !this.needsToAct(this.seats[this.toAct])) {
      this.toAct = this.nextToAct(this.toAct);
    }
    if (this.toAct === -1) { this.nextStreet(); return; }

    const p = this.seats[this.toAct];
    this.broadcast();
    if (p.isAI) {
      this._aiTimer = this.schedule(() => this.aiAct(this.toAct), 750 + Math.random() * 600);
    }
    // 真人：等待客户端发来 action
  }

  needsToAct(p) {
    if (!p || p.folded || p.out || p.allIn) return false;
    return p.bet < this.currentBet || !p.actedThisRound;
  }
  nextToAct(from) {
    const base = from < 0 ? this.dealerSeat : from;
    for (let i = 1; i <= this.seats.length; i++) {
      const idx = (base + i) % this.seats.length;
      const p = this.seats[idx];
      if (p && !p.folded && !p.out && !p.allIn && this.needsToAct(p)) return idx;
    }
    return -1;
  }
  bettingComplete() {
    const contenders = this.occupiedSeats().filter(p => !p.folded && !p.out && !p.allIn);
    if (contenders.length === 0) return true;
    return contenders.every(p => p.bet === this.currentBet && p.actedThisRound);
  }
  resetRoundFlags() { for (const p of this.occupiedSeats()) p.actedThisRound = false; }

  nextStreet() {
    for (const p of this.occupiedSeats()) {
      p.bet = 0;
      p.lastAction = p.folded ? (p.lastAction === '弃牌' ? '弃牌' : '') : (p.allIn ? '全压' : '');
    }
    this.currentBet = 0;
    this.minRaise = PC.BIG_BLIND;
    this.resetRoundFlags();

    if (STAGE_NEXT[this.stage]) {
      if (this.stage === 'preflop') { this.deck.pop(); this.board.push(this.deck.pop(), this.deck.pop(), this.deck.pop()); }
      else { this.deck.pop(); this.board.push(this.deck.pop()); }
      this.stage = STAGE_NEXT[this.stage];
    } else if (this.stage === 'river') { this.showdown(); return; }

    // 翻后首个行动：庄家下家起第一个未弃牌未全压者
    const order = this.aliveOrderFrom(this.nextAliveSeat(this.dealerSeat, true));
    this.toAct = -1;
    for (const s of order) { const p = this.seats[s]; if (!p.folded && !p.allIn) { this.toAct = s; break; } }
    this.broadcast();
    if (this.toAct === -1) { this._autoTimer = this.schedule(() => this.nextStreet(), 1200); return; }
    this._autoTimer = this.schedule(() => this.proceed(), 800);
  }

  /* ---------- 动作执行 ---------- */
  doFold(p) { p.folded = true; p.lastAction = '弃牌'; p.actedThisRound = true; }
  doCheckCall(p) {
    const toCall = this.currentBet - p.bet;
    if (toCall <= 0) p.lastAction = '过牌';
    else {
      const pay = Math.min(toCall, p.stack);
      p.stack -= pay; p.bet += pay; p.totalBet += pay; this.pot += pay;
      if (p.stack === 0) { p.allIn = true; p.lastAction = '全压跟注'; }
      else p.lastAction = '跟注 ' + pay;
    }
    p.actedThisRound = true;
  }
  doRaise(p, raiseTo) {
    const allInTo = p.bet + p.stack;          // 该玩家全压能到的总额
    // 先抬到最小合法加注线，再用全压封顶。若全压都不够最小加注线，则为"短码全压"（合法）
    raiseTo = Math.max(raiseTo, this.currentBet + this.minRaise);
    raiseTo = Math.min(raiseTo, allInTo);     // 全压是最终上限，绝不超过自己的筹码
    const add = raiseTo - p.bet;
    p.stack -= add; p.bet += add; p.totalBet += add; this.pot += add;
    const raiseAmount = raiseTo - this.currentBet;
    if (raiseAmount >= this.minRaise) this.minRaise = raiseAmount;
    this.currentBet = Math.max(this.currentBet, p.bet);
    if (p.stack === 0) { p.allIn = true; p.lastAction = '全压 ' + raiseTo; }
    else p.lastAction = '加注到 ' + raiseTo;
    for (const q of this.occupiedSeats()) if (q !== p && !q.folded && !q.out && !q.allIn) q.actedThisRound = false;
    p.actedThisRound = true;
  }

  // 处理真人动作。action = {type:'fold'|'check'|'call'|'raise', amount?}
  humanAction(id, action) {
    if (!this.handActive) return { ok: false, err: '当前没有进行中的牌局' };
    const seat = this.seatOf(id);
    if (seat === -1) return { ok: false, err: '你不在座位上' };
    if (seat !== this.toAct) return { ok: false, err: '还没轮到你' };
    const p = this.seats[seat];
    if (p.isAI || p.folded || p.allIn) return { ok: false, err: '你当前无法行动' };

    if (this._aiTimer) { this.cancel(this._aiTimer); this._aiTimer = null; }

    if (action.type === 'fold') this.doFold(p);
    else if (action.type === 'check' || action.type === 'call') this.doCheckCall(p);
    else if (action.type === 'raise') {
      const toCall = this.currentBet - p.bet;
      if (p.stack <= toCall) this.doCheckCall(p); // 不够加注就当跟（全压）
      else this.doRaise(p, Math.round(action.amount));
    } else return { ok: false, err: '未知动作' };

    this.toAct = -1;
    this._autoTimer = this.schedule(() => this.proceed(), 250);
    return { ok: true };
  }

  aiAct(seat) {
    if (!this.handActive) return;
    const p = this.seats[seat];
    if (!p || !p.isAI || p.folded || p.out || p.allIn) { this.proceed(); return; }
    const oppLive = this.inHand().filter(q => q !== p).length;
    const { decision } = PC.aiDecide({
      holeCards: p.cards, board: this.board, stage: this.stage,
      pot: this.pot, currentBet: this.currentBet, minRaise: this.minRaise,
      myBet: p.bet, myStack: p.stack, oppLive, persona: p.persona
    });
    if (decision.type === 'fold') this.doFold(p);
    else if (decision.type === 'check' || decision.type === 'call') this.doCheckCall(p);
    else if (decision.type === 'raise') this.doRaise(p, decision.size);
    this.toAct = -1;
    this._autoTimer = this.schedule(() => this.proceed(), 350);
  }

  /* ---------- 结算 ---------- */
  endHandSingle(winner) {
    this.handActive = false;
    winner.stack += this.pot;
    winner.winner = true;
    winner.lastAction = '赢得底池';
    this.stage = 'showdown';
    // 亮所有未出局玩家的牌型（弃牌者是否亮由前端开关控制，这里都算好）
    for (const p of this.occupiedSeats()) {
      if (!p.out && p.cards.length === 2) p.revealRank = PC.evaluate([...p.cards, ...this.board]).name;
    }
    this.lastResult = { type: 'fold-win', winners: [winner.name], pot: this.pot };
    this.broadcast({ msg: `🏆 ${winner.name} 赢得底池 ${this.pot}（其他人都弃牌了）` });
    this.pot = 0;
    this.scheduleNextHand();
  }

  showdown() {
    this.stage = 'showdown';
    this.handActive = false;
    const contenders = this.inHand();
    const scored = contenders.map(p => ({ p, score: PC.evaluate([...p.cards, ...this.board]) }));
    for (const s of scored) s.p.revealRank = s.score.name;
    // 弃牌者也标注牌型（前端按开关决定是否亮）
    for (const p of this.occupiedSeats()) {
      if (!p.out && p.folded && p.cards.length === 2) p.revealRank = PC.evaluate([...p.cards, ...this.board]).name;
    }
    // 分池
    const potPlayers = this.occupiedSeats().filter(p => p.totalBet > 0).map(p => ({
      id: p.id, folded: p.folded, totalBet: p.totalBet,
      score: p.folded ? null : PC.evaluate([...p.cards, ...this.board])
    }));
    const { winnings, winnerIds } = PC.distributePots(potPlayers);
    for (const p of this.occupiedSeats()) {
      if (winnings[p.id]) p.stack += winnings[p.id];
      if (winnerIds.has(p.id)) p.winner = true;
    }
    let best = scored[0];
    for (const s of scored) if (PC.cmpScore(s.score, best.score) > 0) best = s;
    const winnerNames = scored.filter(s => PC.cmpScore(s.score, best.score) === 0).map(s => s.p.name);
    this.lastResult = { type: 'showdown', winners: winnerNames, handName: best.score.name, pot: this.pot };
    this.broadcast({ msg: `摊牌！${winnerNames.join('、')} 以「${best.score.name}」获胜` });
    this.pot = 0;
    this.scheduleNextHand();
  }

  scheduleNextHand() {
    this.broadcast();
    // 给玩家几秒看摊牌结果，然后进入"准备"阶段
    this._autoTimer = this.schedule(() => this.beginReadyPhase(), 4000);
  }

  // 进入准备阶段：清空所有人准备状态，开始 READY_TIMEOUT 倒计时，等真人点准备。
  beginReadyPhase() {
    // 有筹码的真人需要准备；筹码为 0 的标记出局（需补码才回来）
    for (const p of this.occupiedSeats()) {
      if (p.stack <= 0 && !p.isAI) p.out = true;
      p.ready = false;
    }
    // 没有任何能玩的真人（全是AI或没人）就直接尝试开（纯AI桌不需要准备）
    const humansCanPlay = this.occupiedSeats().filter(p => !p.isAI && !p.out && p.stack > 0);
    if (humansCanPlay.length === 0) {
      this.tryStartAfterReady();
      return;
    }
    this.waitingReady = true;
    this.stage = 'waiting';
    this.readyDeadline = Date.now() + Table.READY_TIMEOUT;
    this.broadcast({ msg: '请点击「准备」开始下一手' });
    // 倒计时到点：未准备的真人坐出，然后开局
    this._readyTimer = this.schedule(() => {
      for (const p of this.occupiedSeats()) {
        if (!p.isAI && !p.out && p.stack > 0 && !p.ready) {
          p.sittingOut = true;   // 超时未准备 -> 本局坐出（可下次再准备回来）
        }
      }
      this.finishReadyPhase();
    }, Table.READY_TIMEOUT);
  }

  // 真人点准备
  setReady(id) {
    const seat = this.seatOf(id);
    if (seat === -1) return { ok: false, err: '你不在座位上' };
    if (!this.waitingReady) return { ok: false, err: '现在不是准备阶段' };
    const p = this.seats[seat];
    p.ready = true;
    p.sittingOut = false;   // 准备了就重新入局
    this.broadcast({ msg: `${p.name} 已准备` });
    this.checkAllReady();
    return { ok: true };
  }

  // 若所有"能玩的真人"都已准备，则提前结束准备阶段开局
  checkAllReady() {
    const humansCanPlay = this.occupiedSeats().filter(p => !p.isAI && !p.out && p.stack > 0 && !p.sittingOut);
    if (humansCanPlay.length > 0 && humansCanPlay.every(p => p.ready)) {
      if (this._readyTimer) { this.cancel(this._readyTimer); this._readyTimer = null; }
      this.finishReadyPhase();
    }
  }

  finishReadyPhase() {
    this.waitingReady = false;
    this.readyDeadline = 0;
    this.tryStartAfterReady();
  }

  tryStartAfterReady() {
    const alive = this.alivePlayers();
    if (alive.length >= 2) this.startHand();
    else { this.stage = 'idle'; this.handActive = false; this.broadcast({ msg: '人数不足，等待更多玩家加入或补充 AI 后继续。' }); }
  }

  /* ---------- 状态视图（给前端） ---------- */
  // forId: 接收方玩家 id。只把该玩家自己的底牌明发，其余牌在非摊牌时隐藏。
  viewFor(forId) {
    const showdown = this.stage === 'showdown';
    const players = this.seats.map((p, seat) => {
      if (!p) return null;
      const isSelf = p.id === forId;
      let cards = null;       // null=不显示具体牌（显示牌背或无）
      if (p.cards.length === 2) {
        if (isSelf) cards = p.cards;
        else if (showdown && !p.out) cards = p.cards; // 摊牌时其余玩家亮牌（含弃牌者，前端开关决定显隐）
        else cards = 'hidden'; // 有牌但不该看到
      }
      return {
        seat, id: p.id, name: p.name, isAI: p.isAI,
        style: p.persona ? p.persona.style : '',
        stack: p.stack, bet: p.bet, folded: p.folded, allIn: p.allIn,
        out: p.out, connected: p.connected, sittingOut: p.sittingOut,
        isDealer: seat === this.dealerSeat,
        isActive: seat === this.toAct && this.handActive,
        isSelf, lastAction: p.lastAction || '',
        winner: !!p.winner, revealRank: showdown ? (p.revealRank || '') : '',
        pendingRebuy: !!p.pendingRebuy,
        totalRebuy: p.isAI ? 0 : (p.totalRebuy || 0),
        // 净赢/净输 = 当前筹码 - 总投入(起始 + 累计补码)。AI 不计
        net: p.isAI ? 0 : (p.stack - (this.startStack + (p.totalRebuy || 0))),
        ready: !!p.ready,
        cards
      };
    });
    return {
      players, board: this.board, pot: this.pot, stage: this.stage,
      currentBet: this.currentBet, minRaise: this.minRaise,
      handActive: this.handActive, handNo: this.handNo,
      toActSeat: this.toAct, dealerSeat: this.dealerSeat,
      bigBlind: PC.BIG_BLIND, smallBlind: PC.SMALL_BLIND,
      startStack: this.startStack,
      maxSeats: this.maxSeats,
      rebuyThreshold: Table.REBUY_THRESHOLD,
      lastResult: this.lastResult,
      waitingReady: this.waitingReady,
      readyDeadline: this.readyDeadline || 0,
      yourSeat: this.seatOf(forId)
    };
  }

  broadcast(extra) { this.onState(extra || {}); }
}

// 准备阶段倒计时（毫秒）：超时未准备的真人本局坐出
Table.READY_TIMEOUT = 20000;
// 补码门槛：筹码低于此值才能补码（防止筹码充裕时反复补码）
Table.REBUY_THRESHOLD = 200;

module.exports = { Table };
