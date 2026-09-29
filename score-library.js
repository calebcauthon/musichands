// Scores the player has brought in, kept in the browser between visits.
// Each entry holds the MusicXML itself, so nothing depends on the original file.

const DATABASE = "musichands";
const STORE = "scores";

function open() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run(mode, action) {
  const database = await open();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE, mode);
      const request = action(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request?.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

// Newest first, without the MusicXML, which can be large.
export async function listScores() {
  const all = (await run("readonly", (store) => store.getAll())) ?? [];
  return all.map(({ xml, ...entry }) => entry).sort((a, b) => b.added - a.added);
}

export const getScore = (id) => run("readonly", (store) => store.get(id));

export async function saveScore({ title, xml, source, notes = [], doubts = [] }) {
  const entry = { id: `score-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, title, xml, source, notes, doubts, added: Date.now() };
  await run("readwrite", (store) => store.put(entry));
  return entry;
}

export const removeScore = (id) => run("readwrite", (store) => store.delete(id));
