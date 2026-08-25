// セッション抽象：盤面UIはこのインターフェースだけを相手にする．
// CpuSession … エンジン全体を内包し，botが相手を務める
// NetSession … Transport越しに震えだけをやり取りする（各自が自分の手札のみ保持）

import {
  createGame,
  applyAction,
  observableOf,
  foreignOf,
  botView,
  canXswap,
  canFakeXswap,
  judgeHands,
  drawCard,
  DEFAULT_CONFIG,
  type GameState,
  type Action,
  type Card,
  type Lane,
  type PlayerId,
  type Config,
  type Rng,
} from './engine.ts';
import { makeGreedyBot, mulberry32 } from './bot.ts';

// ---- UIへ流すイベント ----
export type SessionEvent =
  | { t: 'start' }
  // drew … 相手がヤマから引いた札（一瞬だけ両者に開示される）
  | { t: 'oppShake'; lanes: Lane[]; myLanes?: Lane[]; drew?: Card }
  | { t: 'oppPass' }
  | {
      t: 'finished';
      myHand: Card[];
      oppHand: Card[];
      laneWinners: ('me' | 'opp' | null)[];
      score: [number, number]; // [自分, 相手]
      winner: 'me' | 'opp' | null;
      byCap: boolean;
    }
  | { t: 'error'; message: string };

export type ClientView = {
  myInitial: Card[];
  oppInitial: Card[];
  myHand: Card[];
  myKnown: boolean[];
  isMyTurn: boolean;
  canPass: boolean;
  canXswap: boolean; // 本物の交換が打てるか
  canFakeXswap: boolean; // 奪うふりが打てるか（回数を使い切っていても可）
  turn: number;
};

export interface Session {
  readonly view: ClientView;
  /** 自分の行動．change/swapは内部で解決され，viewに反映される */
  myAction(a: Action): void;
  subscribe(cb: (e: SessionEvent) => void): () => void;
  close(): void;
}

// ---- 通信メッセージ（対人モード） ----
export type NetMsg =
  | { t: 'join'; nonce: string }
  | { t: 'init'; hands: [Card[], Card[]]; first: PlayerId }
  // foreign は見せかけの交換のときだけ載る（本物の交換は 'xswap' で送る）
  | {
      t: 'shake';
      turn: number;
      player: PlayerId;
      lanes: Lane[];
      pass: boolean;
      foreign?: Lane;
      drew?: Card;
    }
  | {
      t: 'xswap';
      turn: number;
      player: PlayerId;
      mine: Lane;
      theirs: Lane;
      gave: Card;
    }
  | { t: 'xack'; player: PlayerId; mine: Lane; took: Card }
  | { t: 'reveal'; player: PlayerId; hand: Card[]; log: Action[] };

export interface Transport {
  send(msg: NetMsg): void;
  onMessage(fn: (msg: NetMsg) => void): void;
  close(): void;
}

/** WebSocketトランスポート（Durable Objects向け）
 *  接続後，サーバーが先着順で host / join を割り当てて {t:'role'} を送ってくる．
 *  onMessage登録前に届いたメッセージはバッファし，取りこぼさない． */
export class WsTransport implements Transport {
  private ws: WebSocket;
  private fn: ((m: NetMsg) => void) | null = null;
  private inbox: NetMsg[] = [];
  private outbox: NetMsg[] = [];
  private opened = false;
  readonly role: Promise<'host' | 'join'>;

  constructor(roomId: string, baseUrl?: string) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url =
      baseUrl ?? `${proto}://${location.host}/ws/${encodeURIComponent(roomId)}`;
    this.ws = new WebSocket(url);
    let ok: (r: 'host' | 'join') => void;
    let ng: (e: Error) => void;
    this.role = new Promise((res, rej) => ((ok = res), (ng = rej)));
    this.ws.onopen = () => {
      this.opened = true;
      for (const m of this.outbox) this.ws.send(JSON.stringify(m));
      this.outbox = [];
    };
    this.ws.onmessage = (e) => {
      const m = JSON.parse(e.data) as NetMsg | { t: 'role'; role: 'host' | 'join' };
      if (m.t === 'role') {
        ok((m as any).role);
        return;
      }
      if (this.fn) this.fn(m as NetMsg);
      else this.inbox.push(m as NetMsg);
    };
    this.ws.onerror = () => ng(new Error('つながらない'));
    this.ws.onclose = () => ng(new Error('せつぞくがきれた'));
  }

  send(msg: NetMsg) {
    if (this.opened) this.ws.send(JSON.stringify(msg));
    else this.outbox.push(msg);
  }
  onMessage(fn: (msg: NetMsg) => void) {
    this.fn = fn;
    for (const m of this.inbox) fn(m);
    this.inbox = [];
  }
  close() {
    this.ws.close();
  }
}

export class BroadcastTransport implements Transport {
  private ch: BroadcastChannel;
  constructor(roomId: string) {
    this.ch = new BroadcastChannel(`tremor:${roomId}`);
  }
  send(msg: NetMsg) {
    this.ch.postMessage(msg);
  }
  onMessage(fn: (msg: NetMsg) => void) {
    this.ch.onmessage = (e) => fn(e.data as NetMsg);
  }
  close() {
    this.ch.close();
  }
}

// ---- 共通の小物 ----
type Emitter = {
  subs: Set<(e: SessionEvent) => void>;
  emit: (e: SessionEvent) => void;
  /** 購読者が付く前に流れたイベントを，最初の購読者に渡す */
  drain: (cb: (e: SessionEvent) => void) => void;
};
function makeEmitter(): Emitter {
  const subs = new Set<(e: SessionEvent) => void>();
  const pending: SessionEvent[] = [];
  return {
    subs,
    emit: (e) => {
      if (subs.size === 0) {
        pending.push(e); // 盤がまだ現れていない：取りこぼさずに溜める
        return;
      }
      subs.forEach((f) => f(e));
    },
    drain: (cb) => {
      while (pending.length > 0) cb(pending.shift()!);
    },
  };
}

// =====================================================================
// CPU対戦
// =====================================================================
export class CpuSession implements Session {
  private s: GameState;
  private rng: Rng;
  private cfg: Config;
  private bot = makeGreedyBot();
  private em = makeEmitter();
  private thinkMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  readonly me: PlayerId = 0;

  constructor(opts?: { seed?: number; thinkMs?: number; cfg?: Config }) {
    this.cfg = opts?.cfg ?? DEFAULT_CONFIG;
    this.rng = mulberry32(opts?.seed ?? Date.now() >>> 0);
    this.thinkMs = opts?.thinkMs ?? 1400;
    this.s = createGame(this.rng, this.cfg);
  }

  get view(): ClientView {
    return {
      myInitial: this.s.initialHands[0].slice(),
      oppInitial: this.s.initialHands[1].slice(),
      myHand: this.s.hands[0].slice(),
      myKnown: this.s.known[0].slice(),
      isMyTurn: this.s.phase === 'magic' && this.s.current === this.me,
      canPass:
        this.s.actionCount[0] >= this.cfg.minActionsBeforePass &&
        this.s.actionCount[1] >= this.cfg.minActionsBeforePass,
      canXswap:
        this.s.current === this.me &&
        ([0, 1, 2] as Lane[]).some((m) =>
          ([0, 1, 2] as Lane[]).some((t) =>
            canXswap(this.s, m, t, this.cfg),
          ),
        ),
      canFakeXswap:
        this.s.current === this.me &&
        ([0, 1, 2] as Lane[]).some((m) =>
          ([0, 1, 2] as Lane[]).some((t) =>
            canFakeXswap(this.s, m, t, this.cfg),
          ),
        ),
      turn: this.s.turn,
    };
  }

  start() {
    this.em.emit({ t: 'start' });
    if (this.s.current !== this.me) this.scheduleBot();
  }

  myAction(a: Action) {
    if (this.s.current !== this.me || this.s.phase !== 'magic') return;
    this.s = applyAction(this.s, a, this.rng, this.cfg);
    if (this.s.phase === 'reveal') this.finish(a.type !== 'pass');
    else this.scheduleBot();
  }

  private scheduleBot() {
    this.timer = setTimeout(() => {
      if (this.s.phase !== 'magic') return;
      const a = this.bot(botView(this.s, this.s.current, this.cfg), this.rng, this.cfg);
      this.s = applyAction(this.s, a, this.rng, this.cfg);
      if (a.type === 'pass') this.em.emit({ t: 'oppPass' });
      else {
        const rec = this.s.shakeLog[this.s.shakeLog.length - 1];
        this.em.emit({
          t: 'oppShake',
          lanes: observableOf(a),
          myLanes: foreignOf(a), // 相手が奪ってきたレーン
          ...(rec?.drew !== undefined ? { drew: rec.drew } : {}),
        });
      }
      if (this.s.phase === 'reveal') this.finish(a.type !== 'pass');
    }, this.thinkMs);
  }

  private finish(byCap: boolean) {
    const r = judgeHands(this.s.hands[0], this.s.hands[1]);
    this.em.emit({
      t: 'finished',
      myHand: this.s.hands[0].slice(),
      oppHand: this.s.hands[1].slice(),
      laneWinners: r.laneWinners.map((w) =>
        w === null ? null : w === this.me ? 'me' : 'opp',
      ),
      score: [r.score[0], r.score[1]],
      winner: r.winner === null ? null : r.winner === this.me ? 'me' : 'opp',
      byCap,
    });
  }

  peekOppHand(): Card[] {
    return this.s.hands[1].slice();
  }

  subscribe(cb: (e: SessionEvent) => void) {
    this.em.subs.add(cb);
    this.em.drain(cb);
    return () => this.em.subs.delete(cb);
  }
  close() {
    if (this.timer) clearTimeout(this.timer);
    this.em.subs.clear();
  }
}

// =====================================================================
// 対人戦：各クライアントは自分の手札だけを保持し，震えを送り合う
// =====================================================================
export class NetSession implements Session {
  private t: Transport;
  private cfg: Config;
  private rng: Rng = () => Math.random();
  private em = makeEmitter();
  private role: 'host' | 'join';
  private nonce = Math.random().toString(36).slice(2);

  me: PlayerId = 0; // hostは0，joinerは1
  private initial: [Card[], Card[]] | null = null;
  private myHand: Card[] = [];
  private myKnown: boolean[] = [true, true, true];
  private current: PlayerId = 0;
  private turn = 0;
  private actionCount: [number, number] = [0, 0];
  private phase: 'lobby' | 'magic' | 'reveal' = 'lobby';
  private myLog: Action[] = [];
  private xswapUsed: [number, number] = [0, 0];
  private lastXswap: { player: PlayerId; mine: Lane; theirs: Lane } | null = null;
  private pendingX: Lane | null = null; // ack待ちの自分のレーン
  private passed = false; // 誰かがパスした（reveal交換待ち）
  private oppReveal: { hand: Card[]; log: Action[] } | null = null;
  private myRevealSent = false;
  private endedByCap = false;

  constructor(role: 'host' | 'join', transport: Transport, cfg?: Config) {
    this.role = role;
    this.cfg = cfg ?? DEFAULT_CONFIG;
    this.t = transport;
    this.me = role === 'host' ? 0 : 1;
    this.t.onMessage((m) => this.onMsg(m));
  }

  get view(): ClientView {
    const opp = (1 - this.me) as PlayerId;
    return {
      myInitial: this.initial ? this.initial[this.me].slice() : [],
      oppInitial: this.initial ? this.initial[opp].slice() : [],
      myHand: this.myHand.slice(),
      myKnown: this.myKnown.slice(),
      isMyTurn: this.phase === 'magic' && this.current === this.me,
      canPass:
        this.actionCount[0] >= this.cfg.minActionsBeforePass &&
        this.actionCount[1] >= this.cfg.minActionsBeforePass,
      canXswap: this.xswapUsed[this.me] < this.cfg.xswapPerPlayer,
      canFakeXswap: true, // コウは組み合わせごとの判定なので，ここでは開けておく
      turn: this.turn,
    };
  }

  /** 交換の信号を出せるか（コウだけ）．見せかけはこれだけ満たせば打てる */
  fakeXswapOk(mine: Lane, theirs: Lane): boolean {
    if (this.cfg.xswapKo && this.lastXswap && this.lastXswap.player !== this.me) {
      if (this.lastXswap.theirs === mine && this.lastXswap.mine === theirs)
        return false;
    }
    return true;
  }

  /** 個別の交換が許されるか（回数＋コウ） */
  xswapOk(mine: Lane, theirs: Lane): boolean {
    if (this.xswapUsed[this.me] >= this.cfg.xswapPerPlayer) return false;
    return this.fakeXswapOk(mine, theirs);
  }

  start() {
    if (this.role === 'join') this.t.send({ t: 'join', nonce: this.nonce });
    // hostはjoinを待つ
  }

  private onMsg(m: NetMsg) {
    if (m.t === 'join' && this.role === 'host' && this.phase === 'lobby') {
      // 配牌して開始を通知
      const rng = this.rng;
      const g = createGame(rng, this.cfg);
      this.t.send({ t: 'init', hands: g.initialHands, first: g.current });
      this.beginWith(g.initialHands, g.current);
    } else if (m.t === 'init' && this.role === 'join' && this.phase === 'lobby') {
      this.beginWith(m.hands, m.first);
    } else if (m.t === 'xswap' && m.player !== this.me) {
      // 相手が奪いに来た：自分の札を渡し，受け取った札で上書きしてackを返す
      const took = this.myHand[m.theirs];
      this.myHand[m.theirs] = m.gave;
      this.myKnown[m.theirs] = false; // 伏せたまま受け取る
      this.t.send({ t: 'xack', player: this.me, mine: m.mine, took });
      this.actionCount[m.player]++;
      this.xswapUsed[m.player]++;
      this.lastXswap = { player: m.player, mine: m.mine, theirs: m.theirs };
      this.turn++;
      this.current = this.me;
      this.em.emit({ t: 'oppShake', lanes: [m.mine], myLanes: [m.theirs] });
      this.checkCap();
    } else if (m.t === 'xack' && m.player !== this.me) {
      if (this.pendingX !== null) {
        this.myHand[this.pendingX] = m.took;
        this.pendingX = null;
      }
      // ack待ちで保留していたrevealをここで送る
      if (this.phase === 'reveal') {
        this.sendReveal();
        this.tryFinish();
      }
    } else if (m.t === 'shake' && m.player !== this.me) {
      this.applyRemote(m);
    } else if (m.t === 'reveal' && m.player !== this.me) {
      this.oppReveal = { hand: m.hand, log: m.log };
      this.tryFinish();
    }
  }

  private beginWith(hands: [Card[], Card[]], first: PlayerId) {
    this.initial = [hands[0].slice(), hands[1].slice()];
    this.myHand = hands[this.me].slice();
    this.myKnown = [true, true, true];
    this.current = first;
    this.phase = 'magic';
    this.em.emit({ t: 'start' });
  }

  myAction(a: Action) {
    if (this.phase !== 'magic' || this.current !== this.me) return;
    if (a.type === 'pass') {
      if (!this.view.canPass) return;
      this.passed = true;
      this.t.send({
        t: 'shake',
        turn: this.turn,
        player: this.me,
        lanes: [],
        pass: true,
      });
      this.phase = 'reveal';
      this.sendReveal();
      return;
    }
    if (a.type === 'xswap') {
      if (!this.xswapOk(a.mine, a.theirs)) return;
      // 渡す札だけ送り，受け取る札はackで返してもらう
      this.pendingX = a.mine;
      this.myKnown[a.mine] = false; // 伏せたまま受け取る
      this.t.send({
        t: 'xswap',
        turn: this.turn,
        player: this.me,
        mine: a.mine,
        theirs: a.theirs,
        gave: this.myHand[a.mine],
      });
      this.myLog.push(a);
      this.actionCount[this.me]++;
      this.xswapUsed[this.me]++;
      this.lastXswap = { player: this.me, mine: a.mine, theirs: a.theirs };
      this.turn++;
      this.current = (1 - this.me) as PlayerId;
      this.checkCap();
      return;
    }
    if (a.type === 'bluff' && a.foreign !== undefined) {
      // 見せかけの交換：本物が打てる組み合わせでなければ嘘だと即バレる
      if (a.lanes.length !== 1 || !this.fakeXswapOk(a.lanes[0], a.foreign)) return;
      this.lastXswap = { player: this.me, mine: a.lanes[0], theirs: a.foreign };
    }
    // ローカルで解決してから震えだけ送る
    if (a.type === 'change') {
      this.myHand[a.lane] = drawCard(this.rng, this.cfg);
      this.myKnown[a.lane] = true; // 引いた札は自分だけが見る
    } else if (a.type === 'swap') {
      const [x, y] = a.lanes;
      [this.myHand[x], this.myHand[y]] = [this.myHand[y], this.myHand[x]];
      [this.myKnown[x], this.myKnown[y]] = [this.myKnown[y], this.myKnown[x]];
    }
    this.myLog.push(a);
    this.actionCount[this.me]++;
    this.t.send({
      t: 'shake',
      turn: this.turn,
      player: this.me,
      lanes: observableOf(a),
      pass: false,
      ...(a.type === 'bluff' && a.foreign !== undefined
        ? { foreign: a.foreign }
        : {}),
      // 引いた札は一瞬だけ相手にも見せる
      ...(a.type === 'change' ? { drew: this.myHand[a.lane] } : {}),
    });
    this.turn++;
    this.current = (1 - this.me) as PlayerId;
    this.checkCap();
  }

  private applyRemote(m: Extract<NetMsg, { t: 'shake' }>) {
    if (m.pass) {
      this.passed = true;
      this.phase = 'reveal';
      this.em.emit({ t: 'oppPass' });
      this.sendReveal();
      return;
    }
    this.actionCount[m.player]++;
    this.turn++;
    this.current = this.me;
    if (m.foreign !== undefined) {
      // 見せかけの交換．本物と区別できないので，渡されたつもりの札の
      // 正体をこちらは失う（相手のxswap回数もそのぶん使われたように見える）
      this.myKnown[m.foreign] = false;
      this.xswapUsed[m.player]++;
      this.lastXswap = { player: m.player, mine: m.lanes[0], theirs: m.foreign };
      this.em.emit({ t: 'oppShake', lanes: m.lanes, myLanes: [m.foreign] });
    } else {
      this.em.emit({
        t: 'oppShake',
        lanes: m.lanes,
        ...(m.drew !== undefined ? { drew: m.drew } : {}),
      });
    }
    this.checkCap();
  }

  private checkCap() {
    if (
      this.actionCount[0] >= this.cfg.maxActionsPerPlayer &&
      this.actionCount[1] >= this.cfg.maxActionsPerPlayer
    ) {
      this.endedByCap = true;
      this.phase = 'reveal';
      this.sendReveal();
    }
  }

  private sendReveal() {
    if (this.myRevealSent) return;
    if (this.pendingX !== null) {
      // 交換のackがまだ戻っていない：手札が未確定なので待つ
      return;
    }
    this.myRevealSent = true;
    this.t.send({
      t: 'reveal',
      player: this.me,
      hand: this.myHand.slice(),
      log: this.myLog.slice(),
    });
    this.tryFinish();
  }

  private tryFinish() {
    // パス／打ち切りで自分のrevealが済んでいない場合に備える
    if (this.phase === 'reveal' && !this.myRevealSent) this.sendReveal();
    if (!this.myRevealSent || !this.oppReveal) return;
    const h0 = this.me === 0 ? this.myHand : this.oppReveal.hand;
    const h1 = this.me === 0 ? this.oppReveal.hand : this.myHand;
    const r = judgeHands(h0, h1);
    this.em.emit({
      t: 'finished',
      myHand: this.myHand.slice(),
      oppHand: this.oppReveal.hand.slice(),
      laneWinners: r.laneWinners.map((w) =>
        w === null ? null : w === this.me ? 'me' : 'opp',
      ),
      score:
        this.me === 0
          ? [r.score[0], r.score[1]]
          : [r.score[1], r.score[0]],
      winner: r.winner === null ? null : r.winner === this.me ? 'me' : 'opp',
      byCap: this.endedByCap,
    });
  }

  subscribe(cb: (e: SessionEvent) => void) {
    this.em.subs.add(cb);
    this.em.drain(cb);
    return () => this.em.subs.delete(cb);
  }
  close() {
    this.em.subs.clear();
    this.t.close();
  }
}

// 開発用：CPUの真の手札を覗く（対人セッションでは提供されない）
export interface Peekable {
  peekOppHand(): Card[];
}
export function isPeekable(s: Session): s is Session & Peekable {
  return typeof (s as any).peekOppHand === 'function';
}
