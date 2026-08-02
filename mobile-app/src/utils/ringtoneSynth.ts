// Synthesizes the two call tones as real PCM/WAV bytes, entirely in JS —
// no bundled audio asset, no new native dependency. This exists because
// index.html plays these tones with a live Web Audio oscillator
// (index.html:6666-6711's startRingback/startRingtone), which has no
// direct React Native equivalent (there's no Web Audio API on-device);
// react-native's audio story is "play a file", not "synthesize a
// waveform", so the fix is to generate the file once, byte-for-byte
// matching web's own oscillator envelopes, and loop-play it.
//
// Both tones below reproduce web's exact frequencies/timings:
//   - ringback (caller hears "calling…"): one 440Hz tone, quick attack,
//     held, quick release, repeating every 1.5s (index.html:6670-6688).
//   - ringtone (callee hears the actual "ring ring"): a brighter two-note
//     740Hz + 880Hz chime with a fast exponential decay on each note,
//     repeating every 1.6s (index.html:6689-6708).
// Encoding each as one self-contained WAV clip covering exactly one
// full cycle (silence included) means a plain looping player reproduces
// the same cadence without any JS-side interval/timer driving playback.

const SAMPLE_RATE = 22050;

interface ToneNote {
  freq: number;
  startSec: number;
  peakAmp: number;
  attackSec: number; // linear ramp 0 -> peakAmp, duration
  // Exactly one of these describes the note's decay:
  exponentialDecayToSec?: number; // decays ~exponentially to near-silent by this absolute time (relative to note start)
  holdUntilSec?: number; // stays at peakAmp until this time, then...
  linearReleaseToSec?: number; // ...linearly ramps to 0 by this time
}

function noteAmplitudeAt(note: ToneNote, tSinceStart: number): number {
  if (tSinceStart < 0) return 0;
  if (tSinceStart < note.attackSec) {
    return note.peakAmp * (tSinceStart / note.attackSec);
  }
  if (note.exponentialDecayToSec != null) {
    if (tSinceStart >= note.exponentialDecayToSec) return 0;
    // Matches Web Audio's exponentialRampToValueAtTime(0.0001, ...) shape:
    // decays from peakAmp to ~0.0001 exponentially over the ramp window.
    const span = note.exponentialDecayToSec - note.attackSec;
    const progress = (tSinceStart - note.attackSec) / span;
    const floor = 0.0001;
    return note.peakAmp * Math.pow(floor / note.peakAmp, progress);
  }
  if (note.holdUntilSec != null) {
    if (tSinceStart < note.holdUntilSec) return note.peakAmp;
    if (note.linearReleaseToSec != null && tSinceStart < note.linearReleaseToSec) {
      const span = note.linearReleaseToSec - note.holdUntilSec;
      const progress = (tSinceStart - note.holdUntilSec) / span;
      return note.peakAmp * (1 - progress);
    }
    return 0;
  }
  return 0;
}

function synthesizeCycle(notes: ToneNote[], cycleSec: number): Float32Array {
  const total = Math.round(cycleSec * SAMPLE_RATE);
  const out = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    const t = i / SAMPLE_RATE;
    let sample = 0;
    for (const note of notes) {
      const tSince = t - note.startSec;
      const amp = noteAmplitudeAt(note, tSince);
      if (amp > 0) sample += amp * Math.sin(2 * Math.PI * note.freq * tSince);
    }
    out[i] = sample;
  }
  return out;
}

function encodeWavMono16(samples: Float32Array, sampleRate: number): Uint8Array {
  const dataLength = samples.length * 2; // 16-bit = 2 bytes/sample
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, 'data');
  view.setUint32(40, dataLength, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }
  return new Uint8Array(buffer);
}

// Callee-side "ring ring" — mirrors startRingtone's two-note chime.
export function synthesizeRingtoneWav(): Uint8Array {
  const notes: ToneNote[] = [
    { freq: 740, startSec: 0, peakAmp: 0.35, attackSec: 0.02, exponentialDecayToSec: 0.3 },
    { freq: 880, startSec: 0.18, peakAmp: 0.35, attackSec: 0.02, exponentialDecayToSec: 0.3 },
  ];
  return encodeWavMono16(synthesizeCycle(notes, 1.6), SAMPLE_RATE);
}

// Caller-side "calling…" ringback — mirrors startRingback's single burr.
export function synthesizeRingbackWav(): Uint8Array {
  const notes: ToneNote[] = [
    { freq: 440, startSec: 0, peakAmp: 0.2, attackSec: 0.02, holdUntilSec: 0.9, linearReleaseToSec: 1.0 },
  ];
  return encodeWavMono16(synthesizeCycle(notes, 1.5), SAMPLE_RATE);
}
