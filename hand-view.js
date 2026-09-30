// One interface over the two ways of drawing hands: the 3D stage, and the flat
// SVG drawing it falls back to when WebGL or the 3D library is unavailable.
import { createHandKeyboardSvg, HandKeyboard } from "./hand-keyboard.js";

const SIDES = ["left", "right"];

class StageView {
  constructor(stage, thumbnails) {
    this.kind = "3d";
    this.stage = stage;
    this.thumbnails = thumbnails;
  }

  // Returns the milliseconds until any struck keys land.
  setHands(hands, { immediate = false, landIn = null } = {}) {
    return this.stage.setHands(hands, { immediate, landIn });
  }

  prepareHands(specs) {
    return this.stage.prepareHands(specs);
  }

  // How many times faster than usual the hands move.
  setSpeed(speed) {
    this.stage.setOptions({ speed });
  }

  // The longest, in ms, a strike takes at the current speed.
  get reach() {
    return this.stage.reach;
  }

  // Whether music is playing, and each step it reaches: the camera uses both
  // to cut between saved views.
  setRolling(rolling) {
    this.stage.setRolling(rolling);
    this.thumbnails.setPaused(rolling);
  }

  beat(moment) {
    return this.stage.beat(moment);
  }

  goToShot(index) {
    this.stage.goToShot(index);
  }

  toggleAutoCut() {
    this.stage.setAutoCut(!this.stage.autoCut);
  }

  // The camera as data: { view, shots, autoCut }, given and taken whole.
  get camera() {
    return this.stage.cameraState;
  }

  setCamera(camera, options) {
    this.stage.applyCamera(camera, options);
  }

  setSounding(midis, timing) {
    this.stage.setSounding(midis, timing);
  }

  setNumbers(show) {
    this.stage.setOptions({ showBadges: show });
  }

  setOptions({ showNotes = true, showGuides = true, palmHeight = 44, curve = 52, weight = 30 }) {
    this.stage.setOptions({
      showNotes,
      showBadges: showGuides,
      lift: (palmHeight - 44) / 24,
      curl: (curve - 52) / 36,
      scale: 1 + (weight - 30) / 60,
    });
  }

  renderCard(container, hand, fingers) {
    this.thumbnails.attach(container, hand, fingers);
  }

  download(name) {
    const canvas = document.createElement("canvas");
    canvas.width = this.stage.canvas.width;
    canvas.height = this.stage.canvas.height;
    this.stage.paintTo(canvas);
    return { href: canvas.toDataURL("image/png"), download: `${name}.png` };
  }
}

class FlatView {
  constructor(element, { interactive = false } = {}) {
    this.kind = "flat";
    this.options = {};
    this.boards = {};
    if (interactive) {
      // A single hand, drawn straight into the element so key events surface on it.
      this.single = new HandKeyboard(element, { hand: "right", fingers: [{ finger: 1, note: "C4" }] });
      return;
    }
    element.classList.add("flat-hands");
    for (const side of SIDES) {
      const holder = document.createElement("div");
      holder.className = "flat-hands__hand";
      element.append(holder);
      this.boards[side] = new HandKeyboard(holder, { hand: side, fingers: [{ finger: 1, note: "C4" }] });
    }
  }

  setHands(hands) {
    this.hands = hands;
    for (const side of SIDES) {
      const spec = hands[side];
      if (this.single) {
        if (spec) this.single.update({ ...this.options, hand: side, fingers: spec.fingers, activeMidis: [...(this.sounding ?? spec.activeMidis ?? [])] });
        continue;
      }
      const board = this.boards[side];
      board.element.hidden = !spec;
      if (spec) board.update({ ...this.options, hand: side, fingers: spec.fingers, activeMidis: spec.activeMidis ?? [] });
    }
    return 0;
  }

  prepareHands() {
    return Promise.resolve(true);
  }

  setSounding(midis) {
    this.sounding = [...midis];
    this.single?.setActiveMidis(this.sounding);
  }

  // The flat drawing does not move, so there is nothing to speed up or film.
  setSpeed() {}

  setRolling() {}

  beat() {
    return false;
  }

  goToShot() {}

  toggleAutoCut() {}

  get camera() {
    return null;
  }

  setCamera() {}

  setNumbers(show) {
    this.setOptions({ ...this.options, showGuides: show });
  }

  get reach() {
    return 0;
  }

  setOptions(options) {
    this.options = options;
    if (this.hands) this.setHands(this.hands);
  }

  renderCard(container, hand, fingers) {
    container.innerHTML = createHandKeyboardSvg({ hand, fingers, showGuides: false, showNotes: true });
  }

  download(name) {
    const blob = new Blob([this.single.toSvgString()], { type: "image/svg+xml" });
    return { href: URL.createObjectURL(blob), download: `${name}.svg`, revoke: true };
  }
}

export async function createHandView(element, options = {}) {
  try {
    const { HandStage, ThumbnailRenderer, supportsWebGL } = await import("./hand-stage.js");
    if (!supportsWebGL()) throw new Error("WebGL 2 is not available");
    const stage = new HandStage(element, options);
    await stage.ready;
    return new StageView(stage, new ThumbnailRenderer());
  } catch (error) {
    console.warn("MusicHands: showing the flat hand drawing because the 3D stage could not start.", error);
    element.replaceChildren();
    element.classList.remove("hand-stage");
    return new FlatView(element, options);
  }
}
