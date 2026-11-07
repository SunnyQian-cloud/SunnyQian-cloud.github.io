// Optional voice dictation using the browser's own speech recognition (Web Speech API).
// Starts only on an explicit tap. Never saves anything: the transcript goes to a review step.
// Blockwise never records or stores audio.

export function getRecognitionCtor(win = globalThis) {
  return win.SpeechRecognition || win.webkitSpeechRecognition || null;
}

export const VOICE_ERRORS = {
  denied: 'Microphone access was blocked. You can allow it in your browser\'s site settings, or just type instead.',
  nomic: 'No microphone was found. Check your device, or type instead.',
  nospeech: 'Didn\'t catch anything. Try again closer to the microphone, or type instead.',
  network: 'The browser\'s speech service couldn\'t be reached. Check your connection, or type instead.',
  unsupported: 'Voice input isn\'t available in this browser. Typing works everywhere.',
  error: 'Voice input stopped unexpectedly. Try again, or type instead.',
};

/**
 * States: idle → listening → processing → review | error:<code>
 * onChange({ state, transcript, error })
 */
export function createVoiceController({ onChange, lang = 'en-US', win = globalThis } = {}) {
  const Ctor = getRecognitionCtor(win);
  let rec = null, state = 'idle', transcript = '', error = null, cancelled = false, gotResult = false;
  const emit = () => onChange && onChange({ state, transcript, error });
  const set = (s, err = null) => { state = s; error = err; emit(); };

  function start() {
    if (!Ctor) { set('error', 'unsupported'); return; }
    if (state === 'listening') return;
    transcript = ''; cancelled = false; gotResult = false;
    try {
      rec = new Ctor();
      rec.lang = lang;
      rec.interimResults = true;
      rec.continuous = false;
      rec.maxAlternatives = 1;
    } catch { set('error', 'error'); return; }
    rec.onresult = (e) => {
      let text = '';
      for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
      transcript = text.trim();
      gotResult = gotResult || transcript.length > 0;
      emit();
    };
    rec.onerror = (e) => {
      if (cancelled || e.error === 'aborted') return;
      const map = { 'not-allowed': 'denied', 'service-not-allowed': 'denied', 'audio-capture': 'nomic', 'no-speech': 'nospeech', network: 'network' };
      set('error', map[e.error] || 'error');
    };
    rec.onend = () => {
      rec = null;
      if (cancelled) { transcript = ''; set('idle'); return; }
      if (state === 'error') return;
      if (gotResult && transcript) set('review');
      else set('error', 'nospeech');
    };
    try { rec.start(); set('listening'); } catch { rec = null; set('error', 'error'); }
  }
  function stop() { if (rec && state === 'listening') { set('processing'); try { rec.stop(); } catch { set('error', 'error'); } } }
  function cancel() {
    cancelled = true;
    if (rec) { try { rec.abort(); } catch { /* ignore */ } }
    rec = null; transcript = ''; set('idle');
  }
  function reset() { transcript = ''; set('idle'); }
  return { supported: !!Ctor, start, stop, cancel, reset, get state() { return state; }, get transcript() { return transcript; } };
}
