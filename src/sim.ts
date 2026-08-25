// ヘッドレスシミュレータ：バランス検証用
// node --experimental-strip-types src/sim.ts

import {
  createGame,
  applyAction,
  botView,
  DEFAULT_CONFIG,
  type GameState,
  type Config,
  type Rng,
} from './engine.ts';
import { mulberry32, makeGreedyBot, randomBot, type Bot } from './bot.ts';

// ---- 1試合実行 ----
export function playGame(
  bots: [Bot, Bot],
  rng: Rng,
  cfg: Config = DEFAULT_CONFIG,
) {
  let s = createGame(rng, cfg);
  const firstPlayer = s.current;
  while (s.phase === 'magic') {
    const a = bots[s.current](botView(s, s.current, cfg), rng, cfg);
    s = applyAction(s, a, rng, cfg);
  }
  return { state: s, firstPlayer };
}

// ---- 統計 ----
type Stats = {
  games: number;
  wins: [number, number];
  draws: number;
  firstMoverWins: number;
  firstMoverGames: number;
  higherTotalWins: number; // 初期合計が高い側の勝ち数（同値除く）
  higherTotalGames: number;
  totalTurns: number;
  turnsHist: Map<number, number>;
  passEnded: number;
  actionFreq: Record<string, number>;
};

function runMatch(
  label: string,
  bots: [Bot, Bot],
  n: number,
  seed: number,
  cfg: Config = DEFAULT_CONFIG,
) {
  const rng = mulberry32(seed);
  const st: Stats = {
    games: n,
    wins: [0, 0],
    draws: 0,
    firstMoverWins: 0,
    firstMoverGames: 0,
    higherTotalWins: 0,
    higherTotalGames: 0,
    totalTurns: 0,
    turnsHist: new Map(),
    passEnded: 0,
    actionFreq: { swap: 0, xswap: 0, change: 0, bluff2: 0, bluffx: 0, pass: 0 },
  };

  for (let i = 0; i < n; i++) {
    const { state: s, firstPlayer } = playGame(bots, rng, cfg);
    const r = s.result!;
    if (r.winner === null) st.draws++;
    else {
      st.wins[r.winner]++;
      st.firstMoverGames++;
      if (r.winner === firstPlayer) st.firstMoverWins++;
      const t0 = s.initialHands[0].reduce((a, b) => a + b, 0);
      const t1 = s.initialHands[1].reduce((a, b) => a + b, 0);
      if (t0 !== t1) {
        st.higherTotalGames++;
        const higher = t0 > t1 ? 0 : 1;
        if (r.winner === higher) st.higherTotalWins++;
      }
    }
    st.totalTurns += s.turn;
    st.turnsHist.set(s.turn, (st.turnsHist.get(s.turn) ?? 0) + 1);
    const last = s.eventLog[s.eventLog.length - 1];
    if (last?.actual.type === 'pass') st.passEnded++;
    for (const ev of s.eventLog) {
      const a = ev.actual;
      if (a.type === 'bluff')
        st.actionFreq[
          a.foreign !== undefined ? 'bluffx' : `bluff${a.lanes.length}`
        ]++;
      else st.actionFreq[a.type]++;
    }
  }

  const pct = (x: number, d: number) => ((100 * x) / d).toFixed(1) + '%';
  console.log(`\n=== ${label} (n=${n}) ===`);
  console.log(
    `P0勝 ${pct(st.wins[0], n)} / P1勝 ${pct(st.wins[1], n)} / 引分 ${pct(st.draws, n)}`,
  );
  console.log(`先手勝率（決着局中） ${pct(st.firstMoverWins, st.firstMoverGames)}`);
  console.log(
    `初期合計が高い側の勝率（決着・非同値局中） ${pct(st.higherTotalWins, st.higherTotalGames)}`,
  );
  console.log(`平均ターン数 ${(st.totalTurns / n).toFixed(2)}`);
  console.log(`パス終了率 ${pct(st.passEnded, n)}（残りは打ち切り）`);
  const total = Object.values(st.actionFreq).reduce((a, b) => a + b, 0);
  const freq = Object.entries(st.actionFreq)
    .map(([k, v]) => `${k} ${pct(v, total)}`)
    .join(' / ');
  console.log(`行動分布 ${freq}`);
  const hist = [...st.turnsHist.entries()].sort((a, b) => a[0] - b[0]);
  console.log(
    'ターン分布 ' + hist.map(([t, c]) => `${t}:${pct(c, n)}`).join(' '),
  );
  return st;
}

// ---- 実行 ----
const N = 20000;
const greedy = makeGreedyBot();
const greedyNoBluff = makeGreedyBot({ bluffRate: 0 });

runMatch('Greedy vs Greedy', [greedy, greedy], N, 1);
runMatch('Greedy(ブラフなし) vs Greedy(ブラフなし)', [greedyNoBluff, greedyNoBluff], N, 2);
runMatch('Greedy vs Random', [greedy, randomBot], N, 3);
runMatch('Random vs Random', [randomBot, randomBot], N, 4);

// xswap制約の比較
runMatch('xswap各自1回', [greedy, greedy], N, 21, {
  ...DEFAULT_CONFIG,
  xswapPerPlayer: 1,
});
runMatch('xswapコウのみ', [greedy, greedy], N, 22, {
  ...DEFAULT_CONFIG,
  xswapKo: true,
});
runMatch('xswap各自1回＋コウ', [greedy, greedy], N, 23, {
  ...DEFAULT_CONFIG,
  xswapPerPlayer: 1,
  xswapKo: true,
});
runMatch('xswap各自2回＋コウ', [greedy, greedy], N, 24, {
  ...DEFAULT_CONFIG,
  xswapPerPlayer: 2,
  xswapKo: true,
});
runMatch('xswapなし（参照）', [greedy, greedy], N, 25, {
  ...DEFAULT_CONFIG,
  xswapPerPlayer: 0,
});
