// The voice that talks a lesson through. Lines are read by the server's voice
// (ElevenLabs, see server.js) when it has one, else by the browser's own.
// Lines queue up and are read one after another, with pauses where asked;
// stop() drops the rest. Every line's audio is asked for as soon as it is
// queued, so a run of short lines flows without waiting on the network.

export class Narrator {
  // fetchSpeech(text) answers a Blob of audio, or null when the server has no voice.
  constructor({ fetchSpeech, onLine = () => {}, onDone = () => {} }) {
    this.fetchSpeech = fetchSpeech;
    this.onLine = onLine;
    this.onDone = onDone;
    this.queue = [];
    this.current = null;
    this.serial = 0;
    this.serverVoice = true; // until the server says it has none
  }

  get speaking() {
    return this.current !== null || this.queue.length > 0;
  }

  // Reads `text` after whatever is being read. A number is a pause, in
  // milliseconds. `before` is called as the line starts to be read (it is
  // not called for a line that is dropped first). Resolves to "spoken" once
  // it has been read, "silent" when there is no voice to read it, or
  // "dropped" when stop() cut it off.
  say(text, { before = null } = {}) {
    if (typeof text === "number") return this.enqueue({ pause: text });
    const line = String(text ?? "").trim();
    if (!line) return Promise.resolve("silent");
    const entry = { line, before };
    if (this.serverVoice) entry.audio = this.fetchSpeech(line).catch((error) => ({ error }));
    return this.enqueue(entry);
  }

  // Reads several lines and pauses in turn: strings, numbers, or
  // `{ say, before }`. Resolves as the last one does.
  sayAll(lines) {
    let last = Promise.resolve("silent");
    for (const line of lines) last = line && typeof line === "object" ? this.say(line.say, { before: line.before }) : this.say(line);
    return last;
  }

  enqueue(entry) {
    return new Promise((resolve) => {
      this.queue.push({ ...entry, resolve });
      this.next();
    });
  }

  async next() {
    if (this.current || !this.queue.length) return;
    const entry = this.queue.shift();
    const serial = ++this.serial;
    this.current = entry;
    let spoken = false;
    try {
      if (entry.pause) spoken = await this.wait(entry.pause);
      else {
        entry.before?.();
        this.onLine(entry.line);
        spoken = await this.read(entry, () => serial !== this.serial);
      }
    } catch (error) {
      console.warn("MusicHands: the voice could not read a line.", error);
    }
    if (serial !== this.serial) return; // stopped while reading; stop() has settled it
    this.current = null;
    entry.resolve(spoken ? "spoken" : "silent");
    if (!this.queue.length) this.onDone();
    this.next();
  }

  wait(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.stopCurrent = null;
        resolve(true);
      }, ms);
      this.stopCurrent = () => {
        clearTimeout(timer);
        resolve(false);
      };
    });
  }

  async read(entry, cancelled) {
    if (this.serverVoice) {
      const blob = entry.audio ? await entry.audio : await this.fetchSpeech(entry.line).catch((error) => ({ error }));
      if (cancelled()) return false;
      if (blob?.error) {
        // The server has a voice but could not be reached this time: read this line here.
        console.warn("MusicHands: the voice could not be reached.", blob.error);
        return this.speakLocally(entry.line, cancelled);
      }
      if (blob) return this.play(blob, cancelled);
      this.serverVoice = false;
    }
    return this.speakLocally(entry.line, cancelled);
  }

  play(blob, cancelled) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      this.stopCurrent = () => {
        audio.pause();
        audio.src = "";
        URL.revokeObjectURL(url);
        resolve(false);
      };
      audio.addEventListener("ended", () => {
        URL.revokeObjectURL(url);
        this.stopCurrent = null;
        resolve(!cancelled());
      });
      audio.addEventListener("error", () => {
        URL.revokeObjectURL(url);
        this.stopCurrent = null;
        resolve(false);
      });
      audio.play().catch(() => resolve(false));
    });
  }

  speakLocally(line, cancelled) {
    const synth = globalThis.speechSynthesis;
    if (!synth || typeof SpeechSynthesisUtterance === "undefined") return Promise.resolve(false);
    return new Promise((resolve) => {
      const utterance = new SpeechSynthesisUtterance(line);
      utterance.rate = 0.95;
      this.stopCurrent = () => {
        synth.cancel();
        resolve(false);
      };
      utterance.onend = () => {
        this.stopCurrent = null;
        resolve(!cancelled());
      };
      utterance.onerror = () => {
        this.stopCurrent = null;
        resolve(false);
      };
      synth.speak(utterance);
    });
  }

  // Drops everything queued and cuts off the line being read.
  stop() {
    this.serial += 1;
    const dropped = [...this.queue, ...(this.current ? [this.current] : [])];
    this.queue = [];
    this.current = null;
    this.stopCurrent?.();
    this.stopCurrent = null;
    for (const entry of dropped) entry.resolve("dropped");
  }
}
