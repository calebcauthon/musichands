// Pulls the drawing out of a PDF page by page: every glyph with the character
// it stands for and where it sits, every stroked line, and every filled shape.
// Coordinates come out in points with the origin at the top left of the page.
//
// Notation programs draw noteheads, rests, clefs and accidentals as characters
// of a music font, so a score exported as PDF still says exactly which symbol
// is where. pdf-score.js turns that back into music.

const PDFJS = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/";

let library = null;
function loadLibrary() {
  library ??= import(/* @vite-ignore */ `${PDFJS}pdf.min.mjs`).then((pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerSrc = `${PDFJS}pdf.worker.min.mjs`;
    return pdfjs;
  });
  return library;
}

const multiply = (m, n) => [
  m[0] * n[0] + m[1] * n[2],
  m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2],
  m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4],
  m[4] * n[1] + m[5] * n[3] + n[5],
];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const scaleOf = (m) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
const round = (value) => Math.round(value * 100) / 100;

async function readPage(pdfjs, page) {
  const { OPS } = pdfjs;
  const [, , width, height] = page.view;
  const list = await page.getOperatorList();
  const glyphs = [];
  const lines = [];
  const shapes = [];
  const fontNames = new Map();
  const fontName = (id) => {
    if (!fontNames.has(id)) {
      let name = id;
      try {
        name = page.commonObjs.get(id)?.name ?? id;
      } catch {
        // The font is not loaded; its id will do.
      }
      fontNames.set(id, String(name).replace(/^[A-Z]{6}\+/, ""));
    }
    return fontNames.get(id);
  };
  const flip = ([x, y]) => [round(x), round(height - y)];

  let state = { ctm: [1, 0, 0, 1, 0, 0], lineWidth: 1, font: null, size: 0, charSpacing: 0, wordSpacing: 0, scale: 1, leading: 0, rise: 0 };
  const stack = [];
  let textMatrix = [1, 0, 0, 1, 0, 0];
  let lineMatrix = [1, 0, 0, 1, 0, 0];
  let path = [];

  const paint = (stroked, filled) => {
    for (const sub of path) {
      const points = sub.points.map((point) => flip(apply(state.ctm, point[0], point[1])));
      if (stroked && !filled && !sub.curved) {
        for (let index = 1; index < points.length; index += 1) {
          lines.push({ x1: points[index - 1][0], y1: points[index - 1][1], x2: points[index][0], y2: points[index][1], width: round(state.lineWidth * scaleOf(state.ctm)) });
        }
        continue;
      }
      const xs = points.map((point) => point[0]);
      const ys = points.map((point) => point[1]);
      shapes.push({ curved: sub.curved, filled, stroked, points, left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) });
    }
    path = [];
  };

  list.fnArray.forEach((fn, index) => {
    const args = list.argsArray[index];
    switch (fn) {
      case OPS.save:
        stack.push({ ...state });
        break;
      case OPS.restore:
        if (stack.length) state = stack.pop();
        break;
      case OPS.transform:
        state.ctm = multiply(args, state.ctm);
        break;
      case OPS.setLineWidth:
        state.lineWidth = args[0];
        break;
      case OPS.constructPath: {
        const [ops, coords] = args;
        let at = 0;
        let sub = null;
        for (const op of ops) {
          if (op === OPS.moveTo) {
            sub = { points: [[coords[at], coords[at + 1]]], curved: false };
            path.push(sub);
            at += 2;
          } else if (op === OPS.lineTo) {
            sub?.points.push([coords[at], coords[at + 1]]);
            at += 2;
          } else if (op === OPS.curveTo) {
            // Keep the control points: they show how far a curve bows.
            if (sub) {
              sub.curved = true;
              sub.points.push([coords[at], coords[at + 1]], [coords[at + 2], coords[at + 3]], [coords[at + 4], coords[at + 5]]);
            }
            at += 6;
          } else if (op === OPS.curveTo2 || op === OPS.curveTo3) {
            if (sub) {
              sub.curved = true;
              sub.points.push([coords[at], coords[at + 1]], [coords[at + 2], coords[at + 3]]);
            }
            at += 4;
          } else if (op === OPS.rectangle) {
            const [x, y, w, h] = [coords[at], coords[at + 1], coords[at + 2], coords[at + 3]];
            sub = { points: [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]], curved: false };
            path.push(sub);
            at += 4;
          } else if (op === OPS.closePath) {
            if (sub) sub.points.push(sub.points[0]);
          }
        }
        break;
      }
      case OPS.stroke:
      case OPS.closeStroke:
        paint(true, false);
        break;
      case OPS.fill:
      case OPS.eoFill:
        paint(false, true);
        break;
      case OPS.fillStroke:
      case OPS.eoFillStroke:
      case OPS.closeFillStroke:
      case OPS.closeEOFillStroke:
        paint(true, true);
        break;
      case OPS.endPath:
        path = [];
        break;
      case OPS.beginText:
        textMatrix = [1, 0, 0, 1, 0, 0];
        lineMatrix = [1, 0, 0, 1, 0, 0];
        break;
      case OPS.setFont:
        state.font = args[0];
        state.size = args[1];
        break;
      case OPS.setCharSpacing:
        state.charSpacing = args[0];
        break;
      case OPS.setWordSpacing:
        state.wordSpacing = args[0];
        break;
      case OPS.setHScale:
        state.scale = args[0] / 100;
        break;
      case OPS.setLeading:
        state.leading = args[0];
        break;
      case OPS.setTextRise:
        state.rise = args[0];
        break;
      case OPS.setTextMatrix:
        textMatrix = args.slice(0, 6);
        lineMatrix = args.slice(0, 6);
        break;
      case OPS.moveText:
        lineMatrix = multiply([1, 0, 0, 1, args[0], args[1]], lineMatrix);
        textMatrix = lineMatrix.slice();
        break;
      case OPS.setLeadingMoveText:
        state.leading = -args[1];
        lineMatrix = multiply([1, 0, 0, 1, args[0], args[1]], lineMatrix);
        textMatrix = lineMatrix.slice();
        break;
      case OPS.nextLine:
        lineMatrix = multiply([1, 0, 0, 1, 0, -state.leading], lineMatrix);
        textMatrix = lineMatrix.slice();
        break;
      case OPS.showText:
      case OPS.showSpacedText:
      case OPS.nextLineShowText:
      case OPS.nextLineSetSpacingShowText: {
        const font = fontName(state.font);
        for (const item of args[0] ?? []) {
          if (typeof item === "number") {
            textMatrix = multiply([1, 0, 0, 1, (-item / 1000) * state.size * state.scale, 0], textMatrix);
            continue;
          }
          const placed = multiply([1, 0, 0, 1, 0, state.rise], multiply(textMatrix, state.ctm));
          const [x, y] = flip(apply(placed, 0, 0));
          const text = item.unicode ?? "";
          const advance = ((item.width ?? 0) / 1000) * state.size + state.charSpacing + (item.isSpace ? state.wordSpacing : 0);
          if (text.trim()) glyphs.push({ text, code: text.codePointAt(0), x, y, size: round(state.size * scaleOf(placed)), width: round(advance * state.scale * scaleOf(placed)), font });
          textMatrix = multiply([1, 0, 0, 1, advance * state.scale, 0], textMatrix);
        }
        break;
      }
      default:
        break;
    }
  });
  return { width, height, glyphs, lines, shapes };
}

// Reads every page of a PDF. `onPage(done, total)` is called as pages finish.
export async function readPdf(data, { onPage = () => {} } = {}) {
  const pdfjs = await loadLibrary();
  const document = await pdfjs.getDocument({ data }).promise;
  const pages = [];
  for (let number = 1; number <= document.numPages; number += 1) {
    const page = await document.getPage(number);
    // Glyph outlines are only needed to know each font's name, which loads with the page.
    pages.push(await readPage(pdfjs, page));
    onPage(number, document.numPages);
  }
  await document.destroy();
  return pages;
}
