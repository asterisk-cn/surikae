<script lang="ts">
  // あそびかた：本物の盤で，台本どおりの一局を自分で打つ．
  // ここは台本セッションと盤をつなぎ，一行を組み立てるだけ．
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

  // 「ひだり ＋ まんなか → いれかえ」のように，選ぶものと押すものだけを並べる
  let hint = $derived.by(() => {
    if (!guide) return null;
    if (guide.lead) return { lead: guide.lead, note: guide.note };
    if (guide.who === 'opp')
      return { lead: `あいて ▸ ${guide.press}`, note: guide.note };
    return {
      lead: guide.pick ? `${guide.pick} → ${guide.press}` : `▸ ${guide.press}`,
      note: guide.note,
    };
  });
</script>

<Game {session} {onExit} {hint} onReady={() => session.begin()} />
