// AudioWorklet that delivers mono Float32 frames to the main thread for hands-free voice detection. It
// accumulates the 128-sample render blocks into ~32 ms frames (so the main thread gets ~30 frames/sec rather
// than hundreds of tiny messages) and posts a copy of each. It does no analysis itself — the turn detector runs
// on the main thread (see vad.js) — so this stays tiny and robust. Future-proof: AudioWorklet is the supported
// replacement for ScriptProcessorNode (the main thread keeps a ScriptProcessor fallback for older engines).
class VadWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    // ~32 ms at the context rate; `sampleRate` is a global in the worklet scope.
    this._frameSize = Math.max(256, Math.round(sampleRate * 0.032));
    this._acc = new Float32Array(this._frameSize);
    this._accLen = 0;
  }
  process(inputs) {
    const input = inputs[0];
    const ch = input && input[0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this._acc[this._accLen++] = ch[i];
        if (this._accLen >= this._frameSize) {
          this.port.postMessage(this._acc.slice(0, this._accLen));
          this._accLen = 0;
        }
      }
    }
    return true;   // keep the processor alive
  }
}
registerProcessor('vad-worklet', VadWorklet);
