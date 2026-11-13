/*
 * KeySynth — mechanical keyboard sounds generated with the Web Audio API.
 * No samples: every hit is a short noise transient (the click) layered over a
 * damped low resonance (the housing "thock"), plus a little stereo width.
 *
 * Works with a realtime AudioContext and with OfflineAudioContext, which is how
 * tests/audio-check.html renders and measures the sound.
 */
(function (global) {
  'use strict';

  // Per-switch voicings. `decay` is in seconds, `gain` is a 0..1 amplitude and
  // `level` trims the preset so all four sit at a similar loudness.
  var PRESETS = {
    blue: { // clicky: sharp high tick + bright click
      level: 2.9,
      click: { freq: 2450, q: 1.7, decay: 0.028, gain: 0.50, tick: 0.22 },
      body: { freq: 186, decay: 0.085, gain: 0.30, overtone: 0.30 },
      release: 0.50
    },
    brown: { // tactile: softer, rounder
      level: 2.3,
      click: { freq: 1900, q: 1.2, decay: 0.026, gain: 0.38, tick: 0 },
      body: { freq: 170, decay: 0.105, gain: 0.36, overtone: 0.36 },
      release: 0.42
    },
    red: { // linear: smooth, low, not much high end
      level: 2.1,
      click: { freq: 1500, q: 0.9, decay: 0.024, gain: 0.30, tick: 0 },
      body: { freq: 150, decay: 0.120, gain: 0.44, overtone: 0.42 },
      release: 0.38
    },
    thock: { // deep "thock": mostly housing resonance
      level: 1.4,
      click: { freq: 1150, q: 0.7, decay: 0.020, gain: 0.20, tick: 0 },
      body: { freq: 112, decay: 0.160, gain: 0.58, overtone: 0.48 },
      release: 0.34
    }
  };

  function noiseBuffer(ctx, seconds) {
    var len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  // Exponential-decay noise = short room/desk ambience.
  function impulseBuffer(ctx, seconds, decay) {
    var len = Math.max(2, Math.floor(ctx.sampleRate * seconds));
    var buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (var ch = 0; ch < 2; ch++) {
      var d = buf.getChannelData(ch);
      for (var i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  function KeySynth(ctx, opts) {
    opts = opts || {};
    this.ctx = ctx;
    this.noiseBuf = noiseBuffer(ctx, 0.4);
    this.out = ctx.createGain();
    this.out.gain.value = opts.volume == null ? 0.85 : opts.volume;

    // Final stage: a tanh soft-clipper. Transparent for a single hit, it only
    // saturates when several hits overlap, so nothing can hard-clip.
    var shaper = ctx.createWaveShaper();
    var n = 2048, curve = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.tanh(1.2 * x);
    }
    shaper.curve = curve;
    shaper.oversample = '2x';
    this.out.connect(shaper);
    shaper.connect(ctx.destination);

    var conv = ctx.createConvolver();
    conv.buffer = impulseBuffer(ctx, 0.2, 3.2);
    this.wet = ctx.createGain();
    this.wet.gain.value = opts.reverb == null ? 0.15 : opts.reverb;
    this.wet.connect(conv);
    conv.connect(this.out);
  }

  KeySynth.prototype.setVolume = function (v) {
    this.out.gain.value = Math.max(0, Math.min(1, v));
  };

  Object.defineProperty(KeySynth.prototype, 'volume', {
    get: function () { return this.out.gain.value; },
    set: function (v) { this.setVolume(v); }
  });

  /**
   * Play one key hit.
   * @param {string} type    preset name (blue|brown|red|thock)
   * @param {object} [opts]  {when, velocity, up} — `up` is the key-release tick
   */
  KeySynth.prototype.play = function (type, opts) {
    var P = PRESETS[type] || PRESETS.brown;
    opts = opts || {};
    var ctx = this.ctx;
    var now = typeof opts.when === 'number' ? opts.when : ctx.currentTime;
    var t = now + 0.001;
    var vel = opts.velocity == null ? 1 : opts.velocity;
    var up = !!opts.up;
    var vol = up ? P.release : 1;

    // Small random offsets per hit so repeated typing never sounds machine-like.
    var jitter = function () { return 1 + (Math.random() - 0.5) * 0.12; };
    var pitchUp = up ? 1.35 : 1;

    // Per-hit bus: dry to master, a touch to the reverb send.
    var bus = ctx.createGain();
    bus.gain.value = vol * vel * (P.level || 1);
    var pan = ctx.createStereoPanner();
    pan.pan.value = (Math.random() - 0.5) * 0.3;
    bus.connect(pan);
    pan.connect(this.out);
    pan.connect(this.wet);

    // --- transient: filtered noise burst = the "click" ---
    var cDec = P.click.decay * (up ? 0.85 : 1) * (0.9 + Math.random() * 0.2);
    var cSrc = ctx.createBufferSource();
    cSrc.buffer = this.noiseBuf;
    cSrc.playbackRate.value = jitter();
    var cBp = ctx.createBiquadFilter();
    cBp.type = 'bandpass';
    cBp.frequency.value = P.click.freq * pitchUp * jitter();
    cBp.Q.value = P.click.q;
    var cG = ctx.createGain();
    cG.gain.setValueAtTime(0, t);
    cG.gain.linearRampToValueAtTime(P.click.gain, t + 0.0012);
    cG.gain.exponentialRampToValueAtTime(0.0001, t + cDec);
    cSrc.connect(cBp); cBp.connect(cG); cG.connect(bus);
    cSrc.start(t, Math.random() * 0.25, cDec + 0.03);

    // --- extra-high tick, clicky switches only ---
    if (P.click.tick && !up) {
      var tDec = 0.013;
      var tSrc = ctx.createBufferSource();
      tSrc.buffer = this.noiseBuf;
      tSrc.playbackRate.value = 1.2;
      var tBp = ctx.createBiquadFilter();
      tBp.type = 'bandpass';
      tBp.frequency.value = 5600 * jitter();
      tBp.Q.value = 2.6;
      var tG = ctx.createGain();
      tG.gain.setValueAtTime(0, t);
      tG.gain.linearRampToValueAtTime(P.click.tick, t + 0.0008);
      tG.gain.exponentialRampToValueAtTime(0.0001, t + tDec);
      tSrc.connect(tBp); tBp.connect(tG); tG.connect(bus);
      tSrc.start(t, Math.random() * 0.25, tDec + 0.02);
    }

    // --- body: damped low sine with a downward pitch bend = the "thock" ---
    var bDec = P.body.decay * (up ? 0.85 : 1) * (0.92 + Math.random() * 0.16);
    var bFreq = P.body.freq * (up ? 1.15 : 1) * jitter();
    var bOsc = ctx.createOscillator();
    bOsc.type = 'sine';
    bOsc.frequency.setValueAtTime(bFreq, t);
    bOsc.frequency.exponentialRampToValueAtTime(bFreq * 0.62, t + bDec);
    var bG = ctx.createGain();
    bG.gain.setValueAtTime(0, t);
    bG.gain.linearRampToValueAtTime(P.body.gain, t + 0.002);
    bG.gain.exponentialRampToValueAtTime(0.0001, t + bDec);
    bOsc.connect(bG); bG.connect(bus);
    bOsc.start(t); bOsc.stop(t + bDec + 0.03);

    // --- overtone: cheaper wood/plastic character above the body ---
    if (P.body.overtone > 0) {
      var oDec = bDec * 0.5;
      var oOsc = ctx.createOscillator();
      oOsc.type = 'triangle';
      oOsc.frequency.setValueAtTime(bFreq * 2.35 * jitter(), t);
      var oG = ctx.createGain();
      oG.gain.setValueAtTime(0, t);
      oG.gain.linearRampToValueAtTime(P.body.gain * P.body.overtone, t + 0.0015);
      oG.gain.exponentialRampToValueAtTime(0.0001, t + oDec);
      oOsc.connect(oG); oG.connect(bus);
      oOsc.start(t); oOsc.stop(t + oDec + 0.03);
    }
  };

  KeySynth.PRESETS = PRESETS;
  global.KeySynth = KeySynth;
})(typeof window !== 'undefined' ? window : this);
