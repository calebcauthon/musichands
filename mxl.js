// Reads a compressed MusicXML (.mxl) file, which is a zip archive with a
// META-INF/container.xml pointing at the score. Only needs the platform's
// DecompressionStream, so it works in browsers and in Node without dependencies.

const decoder = new TextDecoder();

function findEndOfCentralDirectory(view) {
  for (let offset = view.byteLength - 22; offset >= 0; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset;
  }
  throw new Error("Not a zip archive");
}

async function inflate(bytes, method) {
  if (method === 0) return bytes;
  if (method !== 8) throw new Error(`Unsupported zip compression method ${method}`);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function readZip(buffer) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const eocd = findEndOfCentralDirectory(view);
  const entryCount = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const entries = new Map();

  for (let index = 0; index < entryCount; index += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error("Corrupt zip central directory");
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    entries.set(name, { method, data: bytes.subarray(dataStart, dataStart + compressedSize) });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return {
    names: [...entries.keys()],
    async text(name) {
      const entry = entries.get(name);
      if (!entry) throw new Error(`No ${name} in archive`);
      return decoder.decode(await inflate(entry.data, entry.method));
    },
  };
}

export async function readMxl(buffer) {
  const zip = await readZip(buffer);
  let rootFile = null;
  if (zip.names.includes("META-INF/container.xml")) {
    const container = await zip.text("META-INF/container.xml");
    rootFile = container.match(/<rootfile[^>]*full-path="([^"]+)"/)?.[1] ?? null;
  }
  rootFile ??= zip.names.find((name) => !name.startsWith("META-INF/") && /\.(musicxml|xml)$/i.test(name));
  if (!rootFile) throw new Error("No MusicXML score found inside the .mxl file");
  return zip.text(rootFile);
}
