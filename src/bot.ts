// AI（相手役）：人間と同じ情報だけを見て打つ．
//
// 見えるもの … 開始時に相互公開された6枚／震えの履歴／自分がいま正体を
//               知っているレーンの値（初期値の記憶とヤマから引いた札）／自分の着手履歴．
// 見えないもの … 相手の現在の手札，自分が正体を失った札，相手の手が本物か見せかけか．
//
// 信念は点推定ではなく「各レーンの値の確率分布」で持つ．目的関数は期待勝率そのもの
// （3レーンの取得数の分布から算出）で，作り変えの当たり外れやxswapで渡す損も
// 分布のまま評価される．sim.ts と UI の両方から使う．

import {
  DEFAULT_CONFIG,
  makeDeck,
  type Action,
  type BotView,
  type Card,
  type Config,
  type Rng,
  type ShakeRecord,
} from './engine.ts';

// 決定的PRNG（mulberry32）
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// =====================================================================
// 値の分布
// =====================================================================
export type Dist = number[]; // 添字0が cardMin

function deckDist(cfg: Config): Dist {
  const n = cfg.cardMax - cfg.cardMin + 1;
  return new Array(n).fill(1 / n);
}
/** 山の残り．公開情報だけから求まる（初期の6枚と，引かれて開示された札） */
export function restPile(v: BotView, cfg: Config): Card[] {
  const rest = makeDeck(cfg);
  const take = (c: Card) => {
    const i = rest.indexOf(c);
    if (i >= 0) rest.splice(i, 1);
  };
  for (const c of v.myInitial) take(c);
  for (const c of v.oppInitial) take(c);
  for (const r of v.shakeLog) if (r.drew !== undefined) take(r.drew);
  return rest;
}

/** ひきなおしで出る札の分布．1〜9が一枚ずつなので，山の残りの一様分布になる */
function pileDist(pile: Card[], cfg: Config): Dist {
  const d = new Array(cfg.cardMax - cfg.cardMin + 1).fill(0);
  for (const c of pile) d[c - cfg.cardMin] += 1 / pile.length;
  return d;
}
function pointDist(v: Card, cfg: Config): Dist {
  const d = new Array(cfg.cardMax - cfg.cardMin + 1).fill(0);
  d[v - cfg.cardMin] = 1;
  return d;
}
/** w の重みで a，残りで b（「本物ならa，見せかけならb」の周辺化） */
function mixDist(a: Dist, b: Dist, w: number): Dist {
  return a.map((x, i) => w * x + (1 - w) * b[i]);
}
export function meanOf(d: Dist, cfg: Config): number {
  let m = 0;
  for (let i = 0; i < d.length; i++) m += d[i] * (cfg.cardMin + i);
  return m;
}

/** 1レーンの勝ち・分け・負けの確率 */
function laneOdds(a: Dist, b: Dist) {
  let win = 0,
    tie = 0,
    below = 0; // below = P(相手 < いま見ている値)
  for (let i = 0; i < a.length; i++) {
    win += a[i] * below;
    tie += a[i] * b[i];
    below += b[i];
  }
  return { win, tie, lose: Math.max(0, 1 - win - tie) };
}

/** 試合の勝率（引き分けは0.5として数える） */
export function winProb(mine: Dist[], opp: Dist[]): number {
  let acc = new Float64Array(7); // 添字 = 取得レーン差 + 3
  acc[3] = 1;
  for (let l = 0; l < 3; l++) {
    const { win, tie, lose } = laneOdds(mine[l], opp[l]);
    const nxt = new Float64Array(7);
    for (let k = 0; k < 7; k++) {
      const p = acc[k];
      if (!p) continue;
      nxt[k + 1] += p * win;
      nxt[k] += p * tie;
      nxt[k - 1] += p * lose;
    }
    acc = nxt;
  }
  return acc[4] + acc[5] + acc[6] + 0.5 * acc[3];
}

// =====================================================================
// 信念
// =====================================================================
export type Belief = {
  mine: Dist[]; // 自分の札についての自分の推定
  opp: Dist[]; // 相手の札についての自分の推定
  seen: Dist[]; // 相手から見えているであろう自分の札（見せかけの効き目を測る）
  oppSure: boolean[]; // 相手が自分の札の正体を保っていそうか
};

/** 震えの履歴を，本物か見せかけかの混合として畳み込む．
 *  自分が打った手だけは正体が分かるので，そこは真の効果を入れる． */
export function believe(
  v: BotView,
  cfg: Config = DEFAULT_CONFIG,
  pReal = 0.75, // 相手の震えが本物である事前確率
): Belief {
  const mine = v.myInitial.map((c) => pointDist(c, cfg));
  const opp = v.oppInitial.map((c) => pointDist(c, cfg));
  const seen = v.myInitial.map((c) => pointDist(c, cfg));
  const oppSure = [true, true, true];
  const deck = deckDist(cfg);
  const myActs = new Map(v.myLog.map((e) => [e.turn, e.action]));

  /** 観測だけから推定する側の更新（自分の手にも，相手から見た像として使う）．
   *  p は「この震えが本物である確率」． */
  const foldPublic = (
    side: Dist[],
    other: Dist[],
    rec: ShakeRecord,
    p: number,
  ) => {
    if (rec.foreign?.length === 1 && rec.lanes.length === 1) {
      const a = rec.lanes[0],
        b = rec.foreign[0];
      const ea = side[a],
        eb = other[b];
      side[a] = mixDist(eb, ea, p);
      other[b] = mixDist(ea, eb, p);
    } else if (rec.lanes.length === 1) {
      // ヤマとの交換は札が開示される：出たなら確定，出ないなら見せかけ確定
      const l = rec.lanes[0];
      if (rec.drew !== undefined) side[l] = pointDist(rec.drew, cfg);
    } else if (rec.lanes.length === 2) {
      const [a, b] = rec.lanes;
      const ea = side[a],
        eb = side[b];
      side[a] = mixDist(eb, ea, p);
      side[b] = mixDist(ea, eb, p);
    }
  };

  // 交換の信号は本物の回数を超えて出せる．同じ相手からk度目なら，
  // そのうち本物は高々 xswapPerPlayer 回しかないので，本物らしさを割り引く
  const foreignSeen = [0, 0];
  for (const rec of v.shakeLog) {
    let p = pReal;
    if (rec.foreign?.length === 1) {
      const k = ++foreignSeen[rec.player];
      p = pReal * Math.min(1, cfg.xswapPerPlayer / k);
    }
    if (rec.player === v.me) {
      const a = myActs.get(rec.turn);
      if (a?.type === 'swap') {
        const [x, y] = a.lanes;
        [mine[x], mine[y]] = [mine[y], mine[x]];
      } else if (a?.type === 'change') {
        mine[a.lane] = deck; // 直後に myKnown で確定値に上書きされる
      } else if (a?.type === 'xswap') {
        const tmp = mine[a.mine];
        mine[a.mine] = opp[a.theirs];
        opp[a.theirs] = tmp;
        oppSure[a.theirs] = false; // 伏せたまま渡したので相手も正体を失う
      } else if (a?.type === 'bluff' && a.foreign !== undefined) {
        oppSure[a.foreign] = false; // 見せかけでも相手は自分の札を信じられなくなる
      }
      // 相手の目に映る自分の像は，観測だけから作られる
      foldPublic(seen, opp, rec, p);
    } else {
      const gave = opp[rec.lanes[0]]; // 渡してきた（かもしれない）札の像
      foldPublic(opp, mine, rec, p);
      if (rec.foreign?.length === 1) {
        // 本物なら相手は渡した札の正体を知っている．見せかけなら元のまま
        const t = rec.foreign[0];
        seen[t] = mixDist(gave, seen[t], p);
        oppSure[rec.lanes[0]] = false; // 本物なら相手も自分の札を失っている
      }
    }
  }

  // 正体を知っているレーンは確定値に置き換える（記憶と，引いて見た札）
  for (let l = 0; l < 3; l++) {
    const k = v.myKnown[l];
    if (k !== null) mine[l] = pointDist(k, cfg);
  }
  return { mine, opp, seen, oppSure };
}

// =====================================================================
// 方策
// =====================================================================
export type Bot = (v: BotView, rng: Rng, cfg: Config) => Action;

export const randomBot: Bot = (v, rng) =>
  v.legal[Math.floor(rng() * v.legal.length)] ?? { type: 'pass' };

/** 手を打った後の分布（本物の手のみ．見せかけは盤面を変えない） */
function afterAction(
  b: Belief,
  a: Action,
  cfg: Config,
  drawDist: Dist,
): { mine: Dist[]; opp: Dist[] } {
  const mine = b.mine.slice();
  const opp = b.opp.slice();
  if (a.type === 'change') mine[a.lane] = drawDist;
  else if (a.type === 'swap') {
    const [x, y] = a.lanes;
    [mine[x], mine[y]] = [mine[y], mine[x]];
  } else if (a.type === 'xswap') {
    const tmp = mine[a.mine];
    mine[a.mine] = opp[a.theirs];
    opp[a.theirs] = tmp;
  }
  return { mine, opp };
}

/** 見せかけの値打ち＝相手の像をどれだけ真実から引き離せるか */
function bluffGain(b: Belief, a: Action, cfg: Config): number {
  if (a.type !== 'bluff') return -Infinity;
  const truth = b.mine.map((d) => meanOf(d, cfg));
  const view = b.seen.map((d) => meanOf(d, cfg));
  const err = (l: number, shown: number) => Math.abs(shown - truth[l]);

  if (a.foreign !== undefined) {
    const m = a.lanes[0];
    // 相手は「自分の札を渡された」と見る．自分のレーンの像は相手の札の像になる
    const after = meanOf(b.opp[a.foreign], cfg);
    let g = err(m, after) - err(m, view[m]);
    // 相手が正体を保っているレーンを狙うと，その確信ごと崩せる
    if (b.oppSure[a.foreign]) g += 1.5;
    return g;
  }
  const [x, y] = a.lanes;
  return (
    err(x, view[y]) + err(y, view[x]) - err(x, view[x]) - err(y, view[y])
  );
}

export function makeGreedyBot(opts?: {
  bluffRate?: number; // 改善手があるときでも見せかけに逃げる確率
  passEdge?: number; // この勝率を超えていれば止めてよい
  pReal?: number;
  gainFloor?: number; // これ未満の改善しかない手は「伸びしろなし」とみなす
}): Bot {
  const bluffRate = opts?.bluffRate ?? 0.15;
  const passEdge = opts?.passEdge ?? 0.62;
  const pReal = opts?.pReal ?? 0.75;
  const gainFloor = opts?.gainFloor ?? 0.015;

  return (v, rng, cfg) => {
    const b = believe(v, cfg, pReal);
    // 引けば何が出るかは山の残りで決まる．重複がないので当たり外れが読める
    const drawDist = pileDist(restPile(v, cfg), cfg);
    const now = winProb(b.mine, b.opp);

    let best: { a: Action; val: number } | null = null;
    for (const a of v.legal) {
      if (a.type === 'bluff' || a.type === 'pass') continue;
      const { mine, opp } = afterAction(b, a, cfg, drawDist);
      const val = winProb(mine, opp);
      if (!best || val > best.val) best = { a, val };
    }

    const canPass = v.legal.some((a) => a.type === 'pass');
    // パスは即座に開帳．いま止めるのが最善なら止める
    if (canPass && now >= passEdge && now >= (best?.val ?? 0) - 0.01) {
      return { type: 'pass' };
    }

    const improvable = best !== null && best.val > now + gainFloor;
    if (!improvable || rng() < bluffRate) {
      let bb: { a: Action; g: number } | null = null;
      for (const a of v.legal) {
        if (a.type !== 'bluff') continue;
        const g = bluffGain(b, a, cfg);
        if (!bb || g > bb.g) bb = { a, g };
      }
      if (bb && bb.g > 0) return bb.a;
    }
    if (best) return best.a;
    return canPass ? { type: 'pass' } : { type: 'bluff', lanes: [0, 1] };
  };
}
