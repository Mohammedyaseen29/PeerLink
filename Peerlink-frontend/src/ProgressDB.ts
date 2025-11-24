
export const saveProgress = async (roomId: string, index: number) => {
  const db = await openDB();

  const tx = db.transaction("progress", "readwrite");
  const store = tx.objectStore("progress");
  store.put({ roomId, index });

  // wait for transaction to complete
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
};

export const getProgress = async (roomId: string) => {
  const db = await openDB();

  const tx = db.transaction("progress", "readonly");
  const store = tx.objectStore("progress");
  const req = store.get(roomId);

  return new Promise<number | null>((resolve, reject) => {
    req.onsuccess = () => {
      resolve(req.result?.index ?? null);
    };
    req.onerror = () => reject(req.error);
  });
};

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("peerlink-progress", 1);

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("progress")) {
        db.createObjectStore("progress", { keyPath: "roomId" });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
