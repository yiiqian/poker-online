'use strict';
// 验证 poker-core.js：牌型评估、胜率、边池分配
const PC = require('./poker-core');
function C(s){ return {rank:s.slice(0,-1), suit:s.slice(-1)}; }
function hand(...a){ return a.map(C); }
let pass=0, fail=0;
function ok(d,c){ if(c){pass++;} else {fail++; console.log('✗ '+d);} }
function near(d,g,e,t){ const c=Math.abs(g-e)<=t; if(c)pass++; else {fail++; console.log(`✗ ${d}: got ${(g*100).toFixed(1)}% exp ~${(e*100).toFixed(0)}%`);} }

// 牌型类别
const cat=(d,cards,exp)=>ok(`${d}=>${exp}`, PC.evaluate(cards).name===exp);
cat('皇家同花顺',hand('A♠','K♠','Q♠','J♠','10♠','2♥','3♦'),'皇家同花顺');
cat('同花顺',hand('9♥','8♥','7♥','6♥','5♥','A♣','K♦'),'同花顺');
cat('轮顺同花',hand('A♠','2♠','3♠','4♠','5♠','K♦','9♣'),'同花顺');
cat('四条',hand('Q♠','Q♥','Q♦','Q♣','5♠','2♥','3♦'),'四条');
cat('葫芦',hand('K♠','K♥','K♦','7♣','7♠','2♥','3♦'),'葫芦');
cat('同花',hand('A♦','J♦','8♦','5♦','2♦','K♠','Q♥'),'同花');
cat('顺子',hand('5♠','6♥','7♦','8♣','9♠','2♥','K♦'),'顺子');
cat('轮顺',hand('A♠','2♥','3♦','4♣','5♠','K♥','9♦'),'顺子');
cat('三条',hand('8♠','8♥','8♦','K♣','5♠','2♥','3♦'),'三条');
cat('两对',hand('J♠','J♥','4♦','4♣','A♠','2♥','3♦'),'两对');
cat('一对',hand('10♠','10♥','K♦','7♣','3♠','2♥','5♦'),'一对');
cat('高牌',hand('A♠','J♥','8♦','6♣','3♠','2♥','9♦'),'高牌');

// 胜率（对照公认值）
const T=20000;
near('AA vs 1对手(翻前)', PC.winEquity(hand('A♠','A♥'),[],1,1.0), 0.85, 0.04);
// 注意：winEquity 对阵的是“随机对手”，不是特定的成手牌。
// 坚果同花听牌+A高张 面对 1 个随机对手 ≈ 70%（很强）。
near('坚果同花听牌 vs 1随机对手(翻牌)', PC.winEquity(hand('A♠','9♠'),hand('K♠','7♠','2♣'),1,4), 0.70, 0.06);
near('暗三条 vs 1对手(翻牌)', PC.winEquity(hand('7♦','7♣'),hand('7♥','K♦','2♣'),1,4), 0.93, 0.05);
ok('对手越多胜率越低', PC.winEquity(hand('A♠','A♥'),hand('K♦','Q♣','2♠'),5,2) < PC.winEquity(hand('A♠','A♥'),hand('K♦','Q♣','2♠'),1,2));

// 边池：简单单池，最佳牌通吃
(function(){
  const players=[
    {id:'a', folded:false, totalBet:100, score:PC.evaluate(hand('A♠','A♥','K♦','Q♣','2♠'))}, // 一对A
    {id:'b', folded:false, totalBet:100, score:PC.evaluate(hand('K♠','K♣','K♦','Q♣','2♠'))}, // 三条K
    {id:'c', folded:true,  totalBet:20,  score:null}
  ];
  const {winnings, winnerIds}=PC.distributePots(players);
  ok('单池：三条K 赢家', winnerIds.has('b') && !winnerIds.has('a'));
  ok('单池：赢家拿全部 220', winnings['b']===220);
  ok('单池：输家拿0', winnings['a']===0 && winnings['c']===0);
})();

// 边池：全压边池场景
// a 全压20, b/c 各下100。主池 a/b/c 各20=60；边池 b/c 各80=160
(function(){
  const players=[
    {id:'a', folded:false, totalBet:20,  score:PC.evaluate(hand('A♠','A♥','3♦','4♣','9♠'))}, // 一对A(最好)
    {id:'b', folded:false, totalBet:100, score:PC.evaluate(hand('K♠','K♣','3♦','4♣','9♠'))}, // 一对K
    {id:'c', folded:false, totalBet:100, score:PC.evaluate(hand('Q♠','Q♣','3♦','4♣','9♠'))}  // 一对Q
  ];
  const {winnings}=PC.distributePots(players);
  // a 只能赢主池60；边池160由 b(一对K) 赢
  ok('边池：全压者a只赢主池60', winnings['a']===60);
  ok('边池：b赢边池160', winnings['b']===160);
  ok('边池：c输光', winnings['c']===0);
  ok('边池：总额守恒=220', winnings['a']+winnings['b']+winnings['c']===220);
})();

// AI 决策返回合法动作
(function(){
  const {decision}=PC.aiDecide({
    holeCards:hand('A♠','A♥'), board:[], stage:'preflop',
    pot:30, currentBet:20, minRaise:20, myBet:0, myStack:1000, oppLive:3,
    persona:PC.AI_PERSONALITIES[0]
  });
  ok('AI 返回合法动作类型', ['fold','check','call','raise'].includes(decision.type));
  ok('AI 强牌AA不会弃牌', decision.type!=='fold');
})();

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail>0?1:0);
