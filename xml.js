// A small, dependency-free XML reader. MusicXML is plain element/attribute/text
// markup with no namespaces, so this covers everything the score model needs and
// runs identically in the browser and under `node --test`.

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function decodeEntities(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body) => {
    if (body[0] === "#") {
      const code = body[1].toLowerCase() === "x" ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[body] ?? match;
  });
}

function parseAttributes(source) {
  const attrs = {};
  const pattern = /([^\s=\/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match;
  while ((match = pattern.exec(source))) attrs[match[1]] = decodeEntities(match[2] ?? match[3] ?? "");
  return attrs;
}

export function parseXml(text) {
  const root = { name: "#document", attrs: {}, children: [], text: "" };
  const stack = [root];
  const tag = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<!DOCTYPE[^>]*(?:\[[\s\S]*?\])?[^>]*>|<\?[\s\S]*?\?>|<\/([^\s>]+)\s*>|<([^\s\/>]+)((?:\s+[^\s=\/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  let last = 0;
  let match;

  while ((match = tag.exec(text))) {
    const parent = stack[stack.length - 1];
    const gap = text.slice(last, match.index);
    if (gap.trim()) parent.text += decodeEntities(gap);
    last = tag.lastIndex;

    const [raw, cdata, closing, opening, attrSource, selfClose] = match;
    if (cdata !== undefined) {
      parent.text += cdata;
    } else if (closing) {
      if (parent.name !== closing) throw new Error(`Unexpected </${closing}> inside <${parent.name}>`);
      stack.pop();
    } else if (opening) {
      const node = { name: opening, attrs: parseAttributes(attrSource), children: [], text: "" };
      parent.children.push(node);
      if (!selfClose) stack.push(node);
    } else if (!raw.startsWith("<!") && !raw.startsWith("<?")) {
      throw new Error(`Unrecognized markup near "${raw.slice(0, 40)}"`);
    }
  }

  if (stack.length !== 1) throw new Error(`Unclosed <${stack[stack.length - 1].name}>`);
  return root;
}

export const child = (node, name) => node?.children.find((entry) => entry.name === name) ?? null;
export const children = (node, name) => node?.children.filter((entry) => entry.name === name) ?? [];
export const text = (node, name, fallback = "") => {
  const target = name ? child(node, name) : node;
  return target ? target.text.trim() : fallback;
};
export const number = (node, name, fallback = null) => {
  const value = text(node, name, "");
  return value === "" ? fallback : Number(value);
};
