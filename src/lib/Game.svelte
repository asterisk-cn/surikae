<script lang="ts">
  import { fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import Card from './Card.svelte';
  import {
    observableOf,
    foreignOf,
    type Action,
    type Lane,
    type Card as CardV,
  } from '../engine.ts';
  import {
    type Session,
    type SessionEvent,
    type ClientView,
  } from '../session.ts';

  let {
    session,
    onExit,
  }: { session: Session; onExit: () => void } = $props();

  const SHAKE_MS = 950; // 全アクション共通の演出長（固定）
  const FLIP_MS = 560; // Card.svelte の .flip と揃える
  const FLIP_GAP = 120; // 伏せるときのレーンごとのずらし
  const PREVIEW_MS = 3000; // 開始時，6枚を覚えるための時間
  const REVEAL_MS = 1000; // ヤマから引いた札を両者に見せる時間
  const BANNER_MS = 420; // 先攻／後攻が横切る時間

  let view = $state<ClientView>(session.view);
  let scene = $state<'wait' | 'preview' | 'magic' | 'reveal'>('wait');
  let busy = $state(false);
  let selMine = $state<Lane[]>([]);
  let selOpp = $state<Lane[]>([]);
  let shakingMe = $state([false, false, false]);
  let shakingOpp = $state([false, false, false]);
  let flipped = $state([false, false, false]);
  // 開始時は6枚とも表．「伏せる」で自分の3枚も裏返る（以降は記憶が頼り）
  let openMe = $state([true, true, true]);
  let openOpp = $state([true, true, true]);
  // ヤマから引いた札の開示．一瞬だけ両者に見えて，すぐ伏せられる
  let flashMe = $state([false, false, false]);
  let flashOpp = $state([false, false, false]);
  let oppFlashVal = $state<(CardV | null)[]>([null, null, null]);
  let live = $state(false); // 伏せ終わるまで相手の動きは進めない
  let toast = $state('');
  let banner = $state(''); // 先攻／後攻を画面中央に横切らせる
  let fin = $state<Extract<SessionEvent, { t: 'finished' }> | null>(null);

  let inputOk = $derived(scene === 'magic' && view.isMyTurn && !busy);
  // 本物を使い切っていても「奪うふり」のために相手の札は選べる
  let oppSelectable = $derived(
    inputOk && view.canFakeXswap && selMine.length === 1 && selOpp.length === 0,
  );
  // 1枚＝作り変え／自分2枚＝入れ替え／自分1＋相手1＝奪う
  let actionKind = $derived.by(() => {
    if (selOpp.length === 1 && selMine.length === 1) return 'xswap' as const;
    if (selOpp.length === 0 && selMine.length === 2) return 'swap' as const;
    if (selOpp.length === 0 && selMine.length === 1) return 'change' as const;
    return null;
  });
  // 見せかけ：2枚の「入れ替えのふり」か，相手の札を選んだ「奪うふり」．
  // 作り変えのふりは無い（引いた札は開示されるので嘘が通らない）
  let bluffAction = $derived.by<Action | null>(() => {
    if (selMine.length === 1 && selOpp.length === 1)
      return { type: 'bluff', lanes: [selMine[0]], foreign: selOpp[0] };
    if (selOpp.length === 0 && selMine.length === 2)
      return { type: 'bluff', lanes: selMine.slice().sort() as Lane[] };
    return null;
  });
  let canBluff = $derived(bluffAction !== null);
  // 「すりかえ」ボタンは，いま選んでいる手の名前になる
  let actLabel = $derived(
    actionKind === 'change'
      ? 'ひきなおし'
      : actionKind === 'swap'
        ? 'いれかえ'
        : actionKind === 'xswap'
          ? 'すりかえ'
          : 'すりかえ',
  );
  // 手番は，その側の卓の縁を染めて示す
  let turnSide = $derived.by(() => {
    if (scene !== 'magic' || !live) return null;
    return view.isMyTurn ? 'me' : 'opp';
  });
  // 奪うのは回数が残っているときだけ．ふりはいつでも打てる
  let canAct = $derived(
    actionKind !== null && (actionKind !== 'xswap' || view.canXswap),
  );

  function sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }
  function refresh() {
    view = session.view;
  }

  function myFaceUp(l: number) {
    return openMe[l] || flashMe[l] || flipped[l];
  }
  function oppFaceUp(l: number) {
    return openOpp[l] || flashOpp[l] || flipped[l];
  }
  /** 引いた札を一瞬だけ開いて，また伏せる */
  async function flashLane(side: 'me' | 'opp', l: Lane) {
    const target = side === 'me' ? flashMe : flashOpp;
    target[l] = true;
    await sleep(REVEAL_MS);
    target[l] = false;
    await sleep(FLIP_MS);
  }
  function myShown(l: number): CardV | null {
    if (scene === 'reveal' && fin) return fin.myHand[l];
    return view.myKnown[l] ? view.myHand[l] : null;
  }

  // ---- イベント直列化 ----
  const q: SessionEvent[] = [];
  let pumping = false;
  let acting = false; // 自分の演出中は相手の演出を割り込ませない
  const unsubscribe = session.subscribe((e) => {
    q.push(e);
    void pump();
  });
  $effect(() => () => {
    unsubscribe();
    session.close();
  });

  async function pump() {
    if (pumping) return;
    pumping = true;
    while (q.length > 0) {
      const e = q[0];
      // 伏せ終わるまで，また自分の演出が終わるまでは，相手の動きを保留する
      if ((!live || acting) && e.t !== 'start') break;
      q.shift();
      if (e.t === 'start') {
        refresh();
        openMe = [true, true, true];
        openOpp = [true, true, true];
        scene = 'preview';
        void previewThenCover();
      } else if (e.t === 'oppShake') {
        busy = true;
        await Promise.all([
          playShake('opp', e.lanes),
          e.myLanes?.length ? playShake('me', e.myLanes) : Promise.resolve(),
        ]);
        refresh();
        if (e.drew !== undefined && e.lanes.length === 1) {
          oppFlashVal[e.lanes[0]] = e.drew;
          await flashLane('opp', e.lanes[0]);
        }
        busy = false;
      } else if (e.t === 'oppPass') {
        busy = true;
        toast = 'あいてがぱす';
        await sleep(950);
        toast = '';
        refresh();
        busy = false;
      } else if (e.t === 'finished') {
        fin = e;
        if (e.byCap) {
          toast = 'てかずぎれ';
          await sleep(950);
          toast = '';
        }
        await revealSequence();
      } else if (e.t === 'error') {
        toast = e.message;
      }
    }
    pumping = false;
  }

  async function playShake(side: 'me' | 'opp', lanes: Lane[]) {
    const target = side === 'me' ? shakingMe : shakingOpp;
    for (const l of lanes) target[l] = true;
    await sleep(SHAKE_MS);
    for (const l of lanes) target[l] = false;
    await sleep(120);
  }

  function pickMine(l: Lane) {
    if (!inputOk) return;
    if (selMine.includes(l)) selMine = selMine.filter((x) => x !== l);
    else if (selOpp.length === 1) selMine = [l];
    else if (selMine.length < 2) selMine = [...selMine, l];
  }
  function pickOpp(l: Lane) {
    if (!oppSelectable && !selOpp.includes(l)) return;
    if (selOpp.includes(l)) selOpp = [];
    else selOpp = [l];
  }
  function clearSel() {
    selMine = [];
    selOpp = [];
  }

  async function act(real: boolean) {
    if (!inputOk) return;
    const mine = selMine.slice().sort() as Lane[];
    const opp = selOpp.slice() as Lane[];
    let a: Action | null = null;
    if (!real) {
      a = bluffAction;
    } else if (actionKind === 'xswap') {
      a = { type: 'xswap', mine: mine[0], theirs: opp[0] };
    } else if (actionKind === 'swap') {
      a = { type: 'swap', lanes: [mine[0], mine[1]] };
    } else if (actionKind === 'change') {
      a = { type: 'change', lane: mine[0] };
    }
    if (!a) return;
    busy = true;
    acting = true;
    clearSel();
    try {
      session.myAction(a); // 即時解決されるが，表示は演出後（操作時間を固定）
    } catch (err) {
      toast = err instanceof Error ? err.message : 'そのてはうてない';
      await sleep(1300);
      toast = '';
      busy = false;
      acting = false;
      void pump();
      return;
    }
    const fr = foreignOf(a);
    await Promise.all([
      playShake('me', observableOf(a)),
      fr.length ? playShake('opp', fr) : Promise.resolve(),
    ]);
    refresh();
    // 引いた札は自分の手元でも一瞬だけ開いて，また伏せる
    if (a.type === 'change') await flashLane('me', a.lane);
    busy = false;
    acting = false;
    void pump();
  }

  async function passAct() {
    if (!inputOk || !view.canPass) return;
    busy = true;
    acting = true;
    clearSel();
    session.myAction({ type: 'pass' });
    toast = 'ぱす';
    await sleep(600); // 自分の手は分かっているので短く．開示を待たせない
    toast = '';
    refresh();
    busy = false;
    acting = false;
    void pump();
  }

  /** 開始の3秒だけ6枚を見せ，あとは自動で伏せる */
  async function previewThenCover() {
    await sleep(PREVIEW_MS);
    await coverAll();
  }

  /** 6枚を順に伏せる．ここから先は，自分の札も記憶だけが頼りになる */
  async function coverAll() {
    if (busy || scene !== 'preview') return;
    busy = true;
    acting = true;
    scene = 'magic';
    for (const l of [0, 1, 2]) {
      openOpp[l] = false;
      openMe[l] = false;
      if (l < 2) await sleep(FLIP_GAP);
    }
    await sleep(FLIP_MS + 80); // 6枚が伏せ切るのを待ってから
    banner = view.isMyTurn ? 'せんこう' : 'こうこう';
    await sleep(BANNER_MS + 520);
    banner = ''; // 抜けていく間に手番が始まる
    await sleep(BANNER_MS);
    busy = false;
    acting = false;
    live = true;
    void pump();
  }

  async function revealSequence() {
    scene = 'reveal';
    await sleep(220);
    for (const l of [0, 1, 2] as Lane[]) {
      flipped[l] = true;
      await sleep(380);
    }
  }

  function verdictFor(l: Lane, who: 'me' | 'opp'): 'win' | 'lose' | 'tie' | null {
    if (scene !== 'reveal' || !flipped[l] || !fin) return null;
    const w = fin.laneWinners[l];
    if (w === null) return 'tie';
    return w === who ? 'win' : 'lose';
  }

  let verdictText = $derived.by(() => {
    if (!fin || scene !== 'reveal' || flipped.some((f) => !f)) return '';
    if (fin.winner === 'me') return 'かち';
    if (fin.winner === 'opp') return 'まけ';
    return 'ひきわけ';
  });

  function oppShown(l: number): CardV | null {
    if (scene === 'reveal' && fin) return fin.oppHand[l];
    // 引いた札を開示中は，その値（開示後も伏せ切るまで残す）
    if (oppFlashVal[l] !== null) return oppFlashVal[l];
    return view.oppInitial[l] ?? null;
  }
</script>

<main>
  <header>
    <h1>すりかえ</h1>
    <button class="exit" onclick={onExit} aria-label="もどる" title="もどる">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M14 4H6.5A1.5 1.5 0 0 0 5 5.5v13A1.5 1.5 0 0 0 6.5 20H14" />
        <path d="M17.5 8.5 21 12l-3.5 3.5" />
        <path d="M21 12h-10.5" />
      </svg>
    </button>
  </header>

  {#if scene === 'wait'}
    <section class="board center">
      <p class="hint waiting">たいきちゅう</p>
    </section>
  {:else}
    <!-- 盤は一枚きり．場面が変わっても札は差し替えず，表裏だけを返す -->
    <section class="board">
      <!-- 手番の合図：その側の札のすぐ外を芯にして，外へ薄れていく -->
      <div class="side top" class:on={turnSide === 'opp'} aria-hidden="true"></div>
      <div class="side bottom" class:on={turnSide === 'me'} aria-hidden="true"></div>

      <div class="row">
        {#each [0, 1, 2] as l}
          <Card
            value={oppShown(l)}
            faceUp={oppFaceUp(l)}
            shaking={shakingOpp[l]}
            selected={selOpp.includes(l as Lane)}
            selectable={oppSelectable || selOpp.includes(l as Lane)}
            pulse={scene === 'preview'}
            owner="opp"
            verdict={verdictFor(l as Lane, 'opp')}
            onclick={() => pickOpp(l as Lane)}
          />
        {/each}
      </div>
      <div class="lanes" aria-hidden="true"></div>
      {#if banner}
        <!-- 先攻／後攻は中央の境界線の高さを横切る -->
        <div class="banner" aria-live="polite">
          <span
            in:fly={{ x: -180, duration: BANNER_MS, easing: cubicOut }}
            out:fly={{ x: 180, duration: BANNER_MS, easing: cubicOut }}
            >{banner}</span
          >
        </div>
      {/if}

      <div class="row">
        {#each [0, 1, 2] as l}
          <Card
            value={myShown(l)}
            faceUp={myFaceUp(l)}
            shaking={shakingMe[l]}
            selected={selMine.includes(l as Lane)}
            selectable={inputOk}
            pulse={scene === 'preview'}
            owner="me"
            verdict={verdictFor(l as Lane, 'me')}
            onclick={() => pickMine(l as Lane)}
          />
        {/each}
      </div>

    </section>

    <section class="dock">
      {#if toast}
        <p class="toast">{toast}</p>
      {:else if scene === 'magic'}
        {#if inputOk}
          <div class="actions">
            <button class="act" disabled={!canAct} onclick={() => act(true)}
              >{actLabel}</button
            >
            <button class="act" disabled={!canBluff} onclick={() => act(false)}
              >ぶらふ</button
            >
            <button class="act" disabled={!view.canPass} onclick={passAct}
              >ぱす</button
            >
          </div>
        {/if}
      {:else if verdictText}
        <p class="verdict">{verdictText}</p>
        <p class="score">{fin?.score[0]} - {fin?.score[1]}</p>
        <button class="primary" onclick={onExit}>もどる</button>
      {/if}
    </section>
  {/if}
</main>

<style>
  /* 手番の合図：札の少し外を芯に，四方へ薄れていく染み．
     画面の縁ではなく盤に貼りついているので，大きな画面でも札の傍で光る */
  .side {
    position: absolute;
    left: 50%;
    width: 168%;
    height: 30dvh;
    min-height: 190px;
    transform: translate(-50%, -50%);
    pointer-events: none;
    opacity: 0;
    transition: opacity 500ms ease;
    z-index: -1;
  }
  .side.on { opacity: 1; }
  .side.top {
    top: 6px;
    background: radial-gradient(
      ellipse at 50% 50%,
      rgba(199, 62, 58, 0.42) 0%,
      rgba(199, 62, 58, 0.16) 38%,
      rgba(199, 62, 58, 0) 70%
    );
  }
  .side.bottom {
    top: calc(100% - 6px);
    background: radial-gradient(
      ellipse at 50% 50%,
      rgba(125, 156, 192, 0.42) 0%,
      rgba(125, 156, 192, 0.16) 38%,
      rgba(125, 156, 192, 0) 70%
    );
  }

  /* 先攻／後攻：盤の上を横切って消える */
  .banner {
    position: absolute;
    inset: 0; /* 盤の上下中央＝中央の境界線の高さ */
    display: grid;
    place-items: center;
    pointer-events: none;
    z-index: 20;
  }
  .banner span {
    font-family: var(--font-display);
    font-weight: 800;
    font-size: 2.6rem;
    letter-spacing: 0.42em;
    text-indent: 0.42em;
    color: var(--kin);
    text-shadow: 0 0 28px rgba(11, 14, 26, 0.9);
  }

  main {
    height: 100dvh;
    max-width: 480px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    padding: max(env(safe-area-inset-top), 12px) 16px
      max(env(safe-area-inset-bottom), 12px);
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-bottom: 6px;
  }
  h1 {
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 1.35rem;
    letter-spacing: 0.35em;
  }
  h1 span {
    font-size: 0.8rem;
    letter-spacing: 0.3em;
    color: var(--washi-dim);
  }
  /* 退出：戸口から出ていく形 */
  .exit {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    margin-right: -6px;
    color: rgba(236, 229, 211, 0.45);
    transition: color 150ms ease;
  }
  .exit:hover { color: var(--washi); }
  .exit svg {
    width: 20px;
    height: 20px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .board {
    position: relative;
    z-index: 0;
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 0;
    min-height: 0;
    margin-top: auto; /* 盤と操作列をひとかたまりで中央に置く */
  }
  .board.center {
    flex: 1;
    align-items: center;
  }
  .row {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 14px;
    padding: 0 6px;
  }
  /* 中央の境界線 */
  .lanes {
    position: relative;
    height: 52px;
  }
  .lanes::before {
    content: '';
    position: absolute;
    left: -16px;
    right: -16px;
    top: 50%;
    height: 1px;
    background: linear-gradient(
      to right,
      transparent,
      rgba(236, 229, 211, 0.32) 12%,
      rgba(236, 229, 211, 0.32) 88%,
      transparent
    );
  }

  .dock {
    margin-bottom: auto;
    min-height: 118px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-start;
    gap: 10px;
    padding-top: 20px;
    text-align: center;
  }
  .hint {
    font-size: 0.82rem;
    color: var(--washi-dim);
    letter-spacing: 0.06em;
  }
  .waiting { animation: breathe 2.2s ease-in-out infinite; }
  @keyframes breathe {
    0%, 100% { opacity: 0.45; }
    50% { opacity: 1; }
  }
  .toast {
    font-family: var(--font-display);
    font-size: 1rem;
    letter-spacing: 0.2em;
    color: var(--kin);
  }

  /* 三つの選択肢は等価に並べる．どれを選んだかを相手に悟らせない */
  .actions {
    display: flex;
    gap: 10px;
    width: 100%;
    max-width: 340px;
    padding: 0 6px;
  }
  .act {
    flex: 1;
    padding: 12px 0;
    border: 1px solid var(--washi-dim);
    border-radius: 6px;
    color: var(--washi);
    font-size: 0.95rem;
    letter-spacing: 0.12em;
    transition: opacity 150ms ease, transform 120ms ease;
  }
  .primary {
    padding: 12px 22px;
    border-radius: 6px;
    font-size: 0.95rem;
    letter-spacing: 0.2em;
    background: var(--washi);
    color: var(--sumi);
    font-weight: 700;
    transition: opacity 150ms ease, transform 120ms ease;
  }
  .act:not(:disabled):active,
  .primary:not(:disabled):active {
    transform: translateY(1px);
  }
  button:disabled { opacity: 0.3; cursor: default; }

  .verdict {
    font-family: var(--font-display);
    font-size: 1.5rem;
    letter-spacing: 0.3em;
    color: var(--kin);
  }
  .score {
    font-family: var(--font-display);
    color: var(--washi-dim);
    letter-spacing: 0.2em;
  }
</style>
