<script lang="ts">
  // あそびかた：本物の盤で，台本どおりの一局を自分で打つ．
  // ここは台本セッションと盤をつなぐだけ．押す札とボタンは盤の上で光らせ，
  // 一行には手の名前と一言しか置かない．
  import Game from './Game.svelte';
  import { TutorialSession, type Guide } from '../tutorial.ts';

  let { onExit }: { onExit: () => void } = $props();

  const session = new TutorialSession();
  let guide = $state<Guide | null>(null);

  const off = session.onGuide((g) => (guide = g));
  $effect(() => {
    queueMicrotask(() => session.start());
    return off;
  });

  let hint = $derived.by(() => {
    if (!guide) return null;
    if (guide.lead) return { lead: guide.lead, note: guide.note };
    return {
      lead:
        guide.who === 'opp'
          ? `あいて ▸ ${guide.press}`
          : `${guide.press} を してみよう`,
      note: guide.note,
    };
  });

  // 光らせるのは自分の手番だけ．相手の番は震えがそれを言う
  let cue = $derived(
    guide && guide.who === 'me' && guide.press
      ? {
          mine: guide.mine ?? [],
          theirs: guide.theirs ?? [],
          press: guide.press,
        }
      : null,
  );
</script>

<Game
  {session}
  {onExit}
  {hint}
  {cue}
  onReady={() => session.ready()}
  peek={() => session.peek()}
/>
