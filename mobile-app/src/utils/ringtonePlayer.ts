// Plays the synthesized call tones (see ringtoneSynth.ts) on a loop —
// this is the piece that was actually missing: call.ts already vibrates
// on an incoming call (Vibration.vibrate), but had no audio at all, per
// its own "Known cut vs. web" header comment. Generation happens once per
// app install (cached to disk under Paths.cache — same pattern as
// attachment/decrypt caching elsewhere in this app) rather than
// resynthesizing PCM samples on every single call.
//
// Deliberately outside any React component/hook, same reasoning as
// call.ts's own module-level `let rtcPeerConn` — this needs to start/stop
// from Zustand action bodies (handleCallSignal, startOutgoingCall,
// acceptCall, declineCall, endCall), not from a component's render cycle.

import { File, Paths } from 'expo-file-system';
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';
import { synthesizeRingtoneWav, synthesizeRingbackWav } from './ringtoneSynth';

let activePlayer: AudioPlayer | null = null;

function ensureWavFile(fileName: string, synth: () => Uint8Array): string {
  const file = new File(Paths.cache, 'ringtones', fileName);
  if (!file.exists) {
    file.create({ intermediates: true, overwrite: true });
    file.write(synth());
  }
  return file.uri;
}

function playLoop(fileName: string, synth: () => Uint8Array) {
  stopRingAudio();
  try {
    const uri = ensureWavFile(fileName, synth);
    const player = createAudioPlayer(uri);
    player.loop = true;
    player.play();
    activePlayer = player;
  } catch (e) {
    // Audio is layered on top of the vibration pattern that's already the
    // primary "you have a call" signal — a synth/playback failure here
    // (e.g. an audio-session conflict) shouldn't be allowed to break the
    // call flow itself, just silently mean no tone this time.
    console.warn('[ringtone] playback failed', String(e));
  }
}

// Callee side — the actual "ring ring" for an incoming call.
export async function playIncomingRingtone() {
  // playsInSilentMode: true is a deliberate choice, not an oversight —
  // this app's incoming-call screen (CallOverlay) is the only signal a
  // call is happening at all (no native CallKit/ConnectionService
  // integration, see call.ts's header comment), so it plays through the
  // hardware silent switch the same way FaceTime/WhatsApp's own ring does,
  // rather than silently missing calls whenever the switch is flipped.
  //
  // Deliberately NOT touching `allowsRecording` here (web has no
  // equivalent concept, so there's no web behavior to match either way).
  // react-native-webrtc manages its own native audio session once
  // getUserMedia()/the peer connection are live — for an outgoing call
  // that's already true by the time this plays (see startOutgoingCall,
  // getUserMedia happens before the ringback starts), and toggling
  // expo-audio's recording flag out from under an active or
  // about-to-start WebRTC mic capture risks fighting that session instead
  // of just adding a tone on top of it.
  await setAudioModeAsync({ playsInSilentMode: true }).catch(() => {});
  playLoop('ringtone.wav', synthesizeRingtoneWav);
}

// Caller side — the "calling…" ringback while waiting for pickup.
export async function playOutgoingRingback() {
  await setAudioModeAsync({ playsInSilentMode: true }).catch(() => {});
  playLoop('ringback.wav', synthesizeRingbackWav);
}

export function stopRingAudio() {
  if (activePlayer) {
    try {
      activePlayer.remove();
    } catch {
      // already released
    }
    activePlayer = null;
  }
}
