<script lang="ts">
  // 1枚の札．伏せ／表，震え（残像つき），選択，勝敗マークを表現する．
  let {
    value,
    faceUp = false,
    shaking = false,
    selected = false,
    selectable = false,
    pulse = false,
    owner = 'me', // 'me' | 'opp'
    verdict = null, // 'win' | 'lose' | 'tie' | null
    note = '',
    onclick = undefined,
  }: {
    value: number | null;
    faceUp?: boolean;
    shaking?: boolean;
    selected?: boolean;
    selectable?: boolean;
    pulse?: boolean;
    owner?: 'me' | 'opp';
    verdict?: 'win' | 'lose' | 'tie' | null;
    note?: string;
    onclick?: (() => void) | undefined;
  } = $props();
</script>

<button
  class="card {owner}"
  class:shaking
  class:selected
  class:selectable
  class:pulse
  class:faceup={faceUp}
  class:win={verdict === 'win'}
  class:lose={verdict === 'lose'}
  class:tie={verdict === 'tie'}
  disabled={!selectable}
  onclick={() => onclick?.()}
  aria-pressed={selected}
>
  <span class="flip">
    <span class="face back">
      {#if note}<span class="note">{note}</span>{/if}
    </span>
    <span class="face front">
      <span class="num">{value ?? ''}</span>
    </span>
  </span>
</button>

<style>
  .card {
    position: relative;
    width: 100%;
    aspect-ratio: 5 / 7;
    border-radius: 8px;
    perspective: 600px;
    transition: transform 180ms ease;
    -webkit-tap-highlight-color: transparent;
  }
  .card:disabled { cursor: default; }
  .card.selected { transform: translateY(-14px); }

  .flip {
    position: absolute;
    inset: 0;
    transform-style: preserve-3d;
    transition: transform 560ms cubic-bezier(0.3, 0.7, 0.2, 1);
    transform: rotateY(0deg);
  }
  .card.faceup .flip { transform: rotateY(180deg); }

  .face {
    position: absolute;
    inset: 0;
    backface-visibility: hidden;
    border-radius: 8px;
    display: grid;
    place-items: center;
  }

  /* 裏面：藍地．持ち主の色が縁を一周する */
  .back {
    background:
      linear-gradient(160deg, #232c4d 0%, #1a2140 100%);
    border: 2px solid rgba(236, 229, 211, 0.22);
    box-shadow: inset 0 0 0 4px rgba(236, 229, 211, 0.06);
  }
  .card.me .back { border-color: var(--ai); }
  .card.opp .back { border-color: var(--shu); }

  .note {
    font-size: 0.7rem;
    letter-spacing: 0.1em;
    color: var(--ghost);
  }

  /* 表面：生成り */
  .front {
    background:
      linear-gradient(170deg, var(--washi) 0%, var(--washi-dim) 100%);
    border: 2px solid rgba(38, 34, 42, 0.35);
    transform: rotateY(180deg);
  }
  .card.me .front { border-color: var(--ai); }
  .card.opp .front { border-color: var(--shu); }
  .num {
    font-family: var(--font-display);
    font-weight: 900;
    font-size: clamp(1.8rem, 9vw, 3rem);
    color: var(--sumi);
  }

  /* ホバー：位置は動かさず面を染める */
  .card.selectable:not(:disabled):hover .front {
    box-shadow: inset 0 0 0 100vmax rgba(201, 162, 39, 0.22);
  }
  .card.selectable:not(:disabled):hover .back {
    box-shadow:
      inset 0 0 0 4px rgba(236, 229, 211, 0.06),
      inset 0 0 0 100vmax rgba(201, 162, 39, 0.16);
  }

  .card.selected .front,
  .card.selectable.selected:hover .front {
    box-shadow: 0 0 0 2px var(--kin), 0 8px 20px rgba(0, 0, 0, 0.4);
  }
  .card.selected .back,
  .card.selectable.selected:hover .back {
    box-shadow:
      inset 0 0 0 4px rgba(236, 229, 211, 0.06),
      0 0 0 2px var(--kin),
      0 8px 20px rgba(0, 0, 0, 0.4);
  }

  /* ---- 署名：震え ----
     300msの発作を3度．振幅の頂点（45%）で金の閃光も頂点になるよう拍を揃える．
     残像2枚が僅かに遅れて追従し，揺れの軌跡を残す */
  .card.shaking .flip {
    animation: tremor 300ms ease-in-out 3 both;
  }
  .card.shaking::before,
  .card.shaking::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: 8px;
    border: 1px solid var(--kin);
    background: rgba(201, 162, 39, 0.08);
    animation: tremor 300ms ease-in-out 3 both;
    pointer-events: none;
  }
  .card.shaking::before { animation-delay: 40ms; opacity: 0.8; }
  .card.shaking::after { animation-delay: 80ms; opacity: 0.45; }

  @keyframes tremor {
    0% { transform: translate(0, 0) rotate(0deg); }
    15% { transform: translate(-3px, 1px) rotate(-1deg); }
    30% { transform: translate(4px, -2px) rotate(1.3deg); }
    45% { transform: translate(-6px, 2px) rotate(-1.8deg); }
    60% { transform: translate(4px, -1px) rotate(1.2deg); }
    75% { transform: translate(-3px, 1px) rotate(-0.7deg); }
    90% { transform: translate(1px, 0) rotate(0.2deg); }
    100% { transform: translate(0, 0) rotate(0deg); }
  }
  .card.faceup.shaking .flip {
    animation: tremor-up 300ms ease-in-out 3 both;
  }
  @keyframes tremor-up {
    0% { transform: rotateY(180deg) translate(0, 0); }
    15% { transform: rotateY(180deg) translate(3px, 1px); }
    30% { transform: rotateY(180deg) translate(-4px, -2px); }
    45% { transform: rotateY(180deg) translate(6px, 2px); }
    60% { transform: rotateY(180deg) translate(-4px, -1px); }
    75% { transform: rotateY(180deg) translate(3px, 1px); }
    90% { transform: rotateY(180deg) translate(-1px, 0); }
    100% { transform: rotateY(180deg) translate(0, 0); }
  }

  /* 閃光：震えと同じ300msの拍で3度 */
  .card.shaking { animation: ring 300ms ease-in-out 3; }
  @keyframes ring {
    0%, 100% { box-shadow: 0 0 0 0 rgba(201, 162, 39, 0); }
    45% {
      box-shadow:
        0 0 0 3px var(--kin),
        0 0 26px rgba(201, 162, 39, 0.55);
    }
  }
  .card.shaking .back { animation: tint-back 300ms ease-in-out 3; }
  @keyframes tint-back {
    0%, 100% { box-shadow: inset 0 0 0 4px rgba(236, 229, 211, 0.06); }
    45% {
      box-shadow:
        inset 0 0 0 4px rgba(236, 229, 211, 0.06),
        inset 0 0 0 100vmax rgba(201, 162, 39, 0.4);
    }
  }
  .card.shaking .front { animation: tint-front 300ms ease-in-out 3; }
  @keyframes tint-front {
    0%, 100% { box-shadow: inset 0 0 0 100vmax rgba(201, 162, 39, 0); }
    45% { box-shadow: inset 0 0 0 100vmax rgba(201, 162, 39, 0.36); }
  }

  /* 開始時：覚えろの合図に，札がやわらかく明滅する */
  .card.pulse { animation: soft-pulse 1s ease-in-out 3; }
  @keyframes soft-pulse {
    0%, 100% { box-shadow: 0 0 0 0 rgba(236, 229, 211, 0); }
    50% {
      box-shadow:
        0 0 0 2px rgba(236, 229, 211, 0.5),
        0 0 18px rgba(236, 229, 211, 0.3);
    }
  }

  /* 開帳後の勝敗 */
  .card.win .front { box-shadow: 0 0 0 2px var(--kin), 0 0 18px rgba(201, 162, 39, 0.35); }
  /* 負け：面を沈めるだけにする．filterで暗くすると持ち主の藍まで灰色になる */
  .card.lose .front {
    box-shadow: inset 0 0 0 100vmax rgba(38, 34, 42, 0.26);
  }
  .card.lose .num { color: rgba(38, 34, 42, 0.62); }
</style>
