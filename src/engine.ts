// ルールエンジン（UI非依存・純粋TypeScript）
// 仕様v4に対応

export type Lane = 0 | 1 | 2;
export type Card = number; // 1-10
export type PlayerId = 0 | 1;

export type Action =
  | { type: 'swap'; lanes: [Lane, Lane] } // 自分の2レーンを交換
  | { type: 'xswap'; mine: Lane; theirs: Lane } // 相手のレーンと交換（隠蔽不能）
  | { type: 'change'; lane: Lane }
  // 見せかけ．入れ替えのふり（自分の2レーン）か，
  // 奪うふり（自分の1レーン＋foreignに相手の1レーン）のいずれか．
  // 作り変えのふりは無い：ヤマから引いた札はその場で開示されるので嘘が通らない
  | { type: 'bluff'; lanes: Lane[]; foreign?: Lane }
  | { type: 'pass' };

/** 相手に観測される情報だけを持つレコード */
export type ShakeRecord = {
  turn: number;
  player: PlayerId;
  lanes: Lane[]; // 行動者側で震えたレーン（0枚＝パス）
  foreign?: Lane[]; // 相手側で震えたレーン（本物／見せかけの交換）
  drew?: Card; // ヤマから引いた札．一瞬だけ両者に開示される
};

/** 操作の実体と，観測される信号のペア */
export type ResolvedEvent = {
  turn: number;
  player: PlayerId;
  actual: Action;
  observable: ShakeRecord;
};

export type Phase = 'magic' | 'reveal';

export type Result = {
  laneWinners: (PlayerId | null)[]; // null は同値
  score: [number, number];
  winner: PlayerId | null; // null は引き分け
};

export type GameState = {
  hands: [Card[], Card[]]; // 真の値（隠匿情報）
  initialHands: [Card[], Card[]]; // 初期公開値（両者の共有知識）
  /** ヤマの残り．1〜9が一枚ずつしかないので，6枚を配った残りの3枚がこれ．
   *  初期手札は相互公開されるから，山に何が残っているかも両者の共有知識．
   *  引いた札は山から消え，捨てた札は山へ戻らず場から抜ける（＝一枚ずつを保つ）． */
  pile: Card[];
  /** known[p][lane] … プレイヤーpが自分のそのレーンの値を知っているか．
   *  初期公開で全てtrue．ヤマとの交換でtrue，相手との交換で双方falseになる．
   *  見せかけの交換でも渡された側はfalseになる（本物と区別できないため）． */
  known: [boolean[], boolean[]];
  current: PlayerId;
  turn: number;
  actionCount: [number, number]; // パスは含まない
  shakeLog: ShakeRecord[];
  eventLog: ResolvedEvent[]; // デバッグ・リプレイ用
  phase: Phase;
  result: Result | null;
};

export type Config = {
  cardMin: number;
  cardMax: number;
  minActionsBeforePass: number; // 各自がこの数を消化するまでパス不可
  maxActionsPerPlayer: number; // 保険としての打ち切り
  xswapPerPlayer: number; // 相手との交換の回数上限（Infinityで無制限）
  xswapKo: boolean; // 直前の相手のxswapを即座に奪い返すことを禁止
};

export const DEFAULT_CONFIG: Config = {
  cardMin: 1,
  cardMax: 9,
  minActionsBeforePass: 1,
  maxActionsPerPlayer: 8,
  xswapPerPlayer: 1,
  xswapKo: true,
};

export type Rng = () => number;

/** 山札：cardMin〜cardMax を一枚ずつ */
export function makeDeck(cfg: Config): Card[] {
  const d: Card[] = [];
  for (let v = cfg.cardMin; v <= cfg.cardMax; v++) d.push(v);
  return d;
}

/** 山から1枚引く．引いた札は山から消える．[引いた札, 残りの山] を返す */
export function drawFromPile(pile: Card[], rng: Rng): [Card, Card[]] {
  const rest = pile.slice();
  const [c] = rest.splice(Math.floor(rng() * rest.length), 1);
  return [c, rest];
}

/** ヤマから引けるか．尽きたら「ひきなおし」は打てない */
export function canChange(s: GameState): boolean {
  return s.pile.length > 0;
}

export function createGame(rng: Rng, cfg: Config = DEFAULT_CONFIG): GameState {
  const deck = makeDeck(cfg);
  if (deck.length < 7) throw new Error('やまが6枚の配り札と残りをまかなえない');
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  const h0 = deck.slice(0, 3);
  const h1 = deck.slice(3, 6);
  const t0 = h0[0] + h0[1] + h0[2];
  const t1 = h1[0] + h1[1] + h1[2];

  // 合計値の低い側が先手，同値ならランダム
  let first: PlayerId;
  if (t0 < t1) first = 0;
  else if (t1 < t0) first = 1;
  else first = rng() < 0.5 ? 0 : 1;

  return {
    hands: [h0.slice(), h1.slice()],
    initialHands: [h0.slice(), h1.slice()],
    pile: deck.slice(6),
    known: [
      [true, true, true],
      [true, true, true],
    ],
    current: first,
    turn: 0,
    actionCount: [0, 0],
    shakeLog: [],
    eventLog: [],
    phase: 'magic',
    result: null,
  };
}

export function canPass(s: GameState, cfg: Config = DEFAULT_CONFIG): boolean {
  return (
    s.actionCount[0] >= cfg.minActionsBeforePass &&
    s.actionCount[1] >= cfg.minActionsBeforePass
  );
}

/** 交換の信号を出せるか（コウだけを見る）．
 *  本物の回数を使い切っていても，見せかけならこの条件だけで打てる．
 *  コウで本物が打てない配置は相手にも分かるので，そこだけは見せかけも禁じる． */
export function canFakeXswap(
  s: GameState,
  mine: Lane,
  theirs: Lane,
  cfg: Config = DEFAULT_CONFIG,
): boolean {
  const me = s.current;
  if (cfg.xswapKo) {
    // 観測された記録で判定する．見せかけの交換も本物と同じ信号なので，
    // 同じように取り返しを禁じないと，禁じられたかどうかで正体が漏れる
    const last = s.shakeLog[s.shakeLog.length - 1];
    if (
      last &&
      last.player !== me &&
      last.lanes.length === 1 &&
      last.foreign?.length === 1 &&
      // 相手の交換(m,t)の逆再生：自分のmine=相手のtheirs, theirs=相手のmine
      last.foreign[0] === mine &&
      last.lanes[0] === theirs
    )
      return false;
  }
  return true;
}

/** xswap(mine, theirs) が現在許されるか（回数＋コウ） */
export function canXswap(
  s: GameState,
  mine: Lane,
  theirs: Lane,
  cfg: Config = DEFAULT_CONFIG,
): boolean {
  const me = s.current;
  const used = s.eventLog.filter(
    (e) => e.player === me && e.actual.type === 'xswap',
  ).length;
  if (used >= cfg.xswapPerPlayer) return false;
  return canFakeXswap(s, mine, theirs, cfg);
}

/** 合法手の列挙 */
export function legalActions(
  s: GameState,
  cfg: Config = DEFAULT_CONFIG,
): Action[] {
  if (s.phase !== 'magic') return [];
  const out: Action[] = [];
  const pairs: [Lane, Lane][] = [
    [0, 1],
    [0, 2],
    [1, 2],
  ];
  for (const p of pairs) out.push({ type: 'swap', lanes: p });
  for (const m of [0, 1, 2] as Lane[])
    for (const t of [0, 1, 2] as Lane[])
      if (canXswap(s, m, t, cfg)) out.push({ type: 'xswap', mine: m, theirs: t });
  if (canChange(s))
    for (const l of [0, 1, 2] as Lane[]) out.push({ type: 'change', lane: l });
  for (const p of pairs) out.push({ type: 'bluff', lanes: [p[0], p[1]] });
  // 見せかけの交換．本物の回数を使い切っていても打てる
  for (const m of [0, 1, 2] as Lane[])
    for (const t of [0, 1, 2] as Lane[])
      if (canFakeXswap(s, m, t, cfg))
        out.push({ type: 'bluff', lanes: [m], foreign: t });
  if (canPass(s, cfg)) out.push({ type: 'pass' });
  return out;
}

/** 操作から観測される震えレーンを導く（本物とブラフが同じ信号になることを保証） */
export function observableOf(a: Action): Lane[] {
  switch (a.type) {
    case 'swap':
      return [a.lanes[0], a.lanes[1]].sort() as Lane[];
    case 'xswap':
      return [a.mine];
    case 'change':
      return [a.lane];
    case 'bluff':
      return a.lanes.slice().sort() as Lane[];
    case 'pass':
      return [];
  }
}

/** 相手側で震えるレーン（xswapのみ非空） */
export function foreignOf(a: Action): Lane[] {
  if (a.type === 'xswap') return [a.theirs];
  if (a.type === 'bluff' && a.foreign !== undefined) return [a.foreign];
  return [];
}

export function applyAction(
  s: GameState,
  a: Action,
  rng: Rng,
  cfg: Config = DEFAULT_CONFIG,
): GameState {
  if (s.phase !== 'magic') throw new Error('まほうふぇーずではない');

  const next: GameState = {
    ...s,
    hands: [s.hands[0].slice(), s.hands[1].slice()] as [Card[], Card[]],
    known: [s.known[0].slice(), s.known[1].slice()] as [boolean[], boolean[]],
    pile: s.pile.slice(),
    shakeLog: s.shakeLog.slice(),
    eventLog: s.eventLog.slice(),
    actionCount: [s.actionCount[0], s.actionCount[1]] as [number, number],
  };

  const me = s.current;

  if (a.type === 'xswap' && !canXswap(s, a.mine, a.theirs, cfg)) {
    throw new Error('そのこうかんはいまできない');
  }
  if (a.type === 'bluff') {
    if (a.foreign !== undefined) {
      if (a.lanes.length !== 1)
        throw new Error('すりかえのふりはじぶんの1れーんだけ');
      if (!canFakeXswap(s, a.lanes[0], a.foreign, cfg))
        throw new Error('そのこうかんはいまできない');
    } else if (a.lanes.length !== 2) {
      throw new Error('ぶらふは2まいのいれかえか，すりかえのふり');
    }
  }

  if (a.type === 'pass') {
    if (!canPass(s, cfg)) throw new Error('まだぱすできない');
    next.shakeLog.push({ turn: s.turn, player: me, lanes: [] });
    next.eventLog.push({
      turn: s.turn,
      player: me,
      actual: a,
      observable: { turn: s.turn, player: me, lanes: [] },
    });
    next.phase = 'reveal';
    next.result = judge(next, cfg);
    return next;
  }

  if (a.type === 'swap') {
    // 位置の入れ替え：知識も札に付いて動く
    const [x, y] = a.lanes;
    const h = next.hands[me];
    const k = next.known[me];
    [h[x], h[y]] = [h[y], h[x]];
    [k[x], k[y]] = [k[y], k[x]];
  } else if (a.type === 'xswap') {
    // 相手との交換：互いに伏せたまま受け取るので，双方が正体を失う
    const opp = (1 - me) as PlayerId;
    const gave = next.hands[me][a.mine];
    next.hands[me][a.mine] = next.hands[opp][a.theirs];
    next.hands[opp][a.theirs] = gave;
    next.known[me][a.mine] = false;
    next.known[opp][a.theirs] = false;
  } else if (a.type === 'change') {
    // ヤマとの交換：引いた札は一瞬だけ両者に開示される．
    // 捨てた札は山へ戻さず場から抜く（1〜9が一枚ずつという約束を保つ）
    if (!canChange(s)) throw new Error('やまがもうない');
    const [c, rest] = drawFromPile(next.pile, rng);
    next.hands[me][a.lane] = c;
    next.pile = rest;
    next.known[me][a.lane] = true;
  } else if (a.type === 'bluff' && a.foreign !== undefined) {
    // 見せかけの交換：札は動かないが，渡された側は本物と区別できないので
    // 自分のその札の正体を失う（ここだけが見せかけの残す痕跡）
    const opp = (1 - me) as PlayerId;
    next.known[opp][a.foreign] = false;
  }
  // 震えだけの見せかけは状態を変えない

  const obs = observableOf(a);
  const frn = foreignOf(a);
  const rec: ShakeRecord = {
    turn: s.turn,
    player: me,
    lanes: obs,
    ...(frn.length ? { foreign: frn } : {}),
    ...(a.type === 'change' ? { drew: next.hands[me][a.lane] } : {}),
  };
  next.shakeLog.push(rec);
  next.eventLog.push({ turn: s.turn, player: me, actual: a, observable: rec });
  next.actionCount[me] += 1;
  next.turn = s.turn + 1;
  next.current = (1 - me) as PlayerId;

  // 打ち切り
  if (
    next.actionCount[0] >= cfg.maxActionsPerPlayer &&
    next.actionCount[1] >= cfg.maxActionsPerPlayer
  ) {
    next.phase = 'reveal';
    next.result = judge(next, cfg);
  }
  return next;
}

/** 手札のペアだけから判定する（クライアント側の対人モードでも使う） */
export function judgeHands(h0: Card[], h1: Card[]): Result {
  const laneWinners: (PlayerId | null)[] = [];
  const score: [number, number] = [0, 0];
  for (let i = 0; i < 3; i++) {
    if (h0[i] > h1[i]) {
      laneWinners.push(0);
      score[0]++;
    } else if (h1[i] > h0[i]) {
      laneWinners.push(1);
      score[1]++;
    } else {
      laneWinners.push(null);
    }
  }
  // 取得レーン数の多い方が勝ち（同数は引き分け）
  let winner: PlayerId | null = null;
  if (score[0] > score[1]) winner = 0;
  else if (score[1] > score[0]) winner = 1;
  return { laneWinners, score, winner };
}

export function judge(s: GameState, cfg: Config = DEFAULT_CONFIG): Result {
  return judgeHands(s.hands[0], s.hands[1]);
}

/** あるプレイヤーから見える情報だけを抽出したビュー */
export type PlayerView = {
  me: PlayerId;
  myHand: Card[];
  myKnown: boolean[];
  opponentInitial: Card[];
  myInitial: Card[];
  shakeLog: ShakeRecord[];
  turn: number;
  isMyTurn: boolean;
  actionCount: [number, number];
  phase: Phase;
};

export function viewFor(s: GameState, me: PlayerId): PlayerView {
  const opp = (1 - me) as PlayerId;
  return {
    me,
    myHand: s.hands[me].slice(),
    myKnown: s.known[me].slice(),
    myInitial: s.initialHands[me].slice(),
    opponentInitial: s.initialHands[opp].slice(),
    shakeLog: s.shakeLog.slice(),
    turn: s.turn,
    isMyTurn: s.current === me,
    actionCount: [s.actionCount[0], s.actionCount[1]],
    phase: s.phase,
  };
}

/** CPUに渡す情報集合．人間のプレイヤーと同じものだけを持つ：
 *  - 開始時に相互公開された6枚
 *  - 震えの履歴（本物か見せかけかは含まれない）
 *  - 自分がいま正体を知っているレーンの値（初期値の記憶＋ヤマから引いた札）
 *  真の手札もeventLogも渡さない．合法手だけはエンジンが列挙して渡す
 *  （合法性は相手にも観測可能な情報だけから決まるので，これは漏洩ではない）． */
export type BotView = {
  me: PlayerId;
  myInitial: Card[];
  oppInitial: Card[];
  myKnown: (Card | null)[]; // 知らないレーンはnull
  shakeLog: ShakeRecord[];
  myLog: { turn: number; action: Action }[]; // 自分が何を打ったかは自分だけが知る
  turn: number;
  actionCount: [number, number];
  legal: Action[];
};

export function botView(
  s: GameState,
  me: PlayerId,
  cfg: Config = DEFAULT_CONFIG,
): BotView {
  const opp = (1 - me) as PlayerId;
  return {
    me,
    myInitial: s.initialHands[me].slice(),
    oppInitial: s.initialHands[opp].slice(),
    myKnown: [0, 1, 2].map((l) => (s.known[me][l] ? s.hands[me][l] : null)),
    shakeLog: s.shakeLog.slice(),
    myLog: s.eventLog
      .filter((e) => e.player === me)
      .map((e) => ({ turn: e.turn, action: e.actual })),
    turn: s.turn,
    actionCount: [s.actionCount[0], s.actionCount[1]],
    legal: s.current === me ? legalActions(s, cfg) : [],
  };
}
