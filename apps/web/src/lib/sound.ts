/**
 * Tiny synthesized sound effects (Web Audio oscillators). No audio files are fetched or bundled, so
 * there is nothing to load from the network. Silently does nothing where Web Audio is unavailable.
 */
export type SoundCue = "merge" | "milestone" | "over";

export interface SoundPlayer {
  play(cue: SoundCue): void;
}

type AudioCtor = new () => AudioContext;

export function createSoundPlayer(isMuted: () => boolean): SoundPlayer {
  let ctx: AudioContext | null = null;
  const tones: Record<SoundCue, Array<[number, number]>> = {
    merge: [[520, 0.06]],
    milestone: [
      [523, 0.12],
      [659, 0.12],
      [784, 0.2],
    ],
    over: [
      [330, 0.15],
      [262, 0.25],
    ],
  };
  return {
    play(cue) {
      if (isMuted()) return;
      const Ctor = (globalThis as { AudioContext?: AudioCtor }).AudioContext;
      if (!Ctor) return;
      try {
        ctx ??= new Ctor();
        let t = ctx.currentTime;
        for (const [freq, dur] of tones[cue]) {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = "sine";
          osc.frequency.value = freq;
          gain.gain.setValueAtTime(0.05, t);
          gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
          osc.connect(gain).connect(ctx.destination);
          osc.start(t);
          osc.stop(t + dur);
          t += dur;
        }
      } catch {
        // Autoplay policy or device errors: sound is optional.
      }
    },
  };
}

export const silentSoundPlayer: SoundPlayer = { play: () => undefined };
