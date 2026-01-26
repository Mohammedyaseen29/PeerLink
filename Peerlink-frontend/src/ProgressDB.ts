export const DB_NAME = "PeerLink_files";
export const DB_VERSION = 2;
export const CHUNK_STORE = "chunks";
export const PROGRESS_STORE = "progress";
export const FILE_STORE = "files"

export type FileMetadata = {
  fileId: string;
  roomId: string;
  name: string;
  path?: string;
  size: number;
  mimeType: string;
  totalChunks: number;
  receivedChunks: number;
  status: "receiving" | "complete" | "paused";
  createdAt: number;
};

export async function openDB(): Promise<IDBDatabase> { 
  return new Promise((resolve, reject) => { 
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    
    request.onupgradeneeded = (event) => { 
      const db = request.result;
      const oldVersion = event.oldVersion ?? 0;
      
      if (!db.objectStoreNames.contains(CHUNK_STORE)) { 
        const chunkStore = db.createObjectStore(CHUNK_STORE, { keyPath: ["fileId", "chunkIndex"] });
        chunkStore.createIndex("fileId", "fileId", {unique: false});
      }
      
      if (oldVersion < 2) { 
        if (db.objectStoreNames.contains(PROGRESS_STORE)) {
          try {
            db.deleteObjectStore(PROGRESS_STORE);
          } catch (error) { 
            console.error(error);
          }
        }
      }
    }
    
    request.onsuccess = () => { 
      resolve(request.result);
    }
    
    request.onerror = () => { 
      reject(request.error);
    }
  })
}

export async function saveChunk(fileId: string, chunkIndex: number, data: ArrayBuffer): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(CHUNK_STORE, "readwrite");
  const store = tx.objectStore(CHUNK_STORE);
  store.put({fileId, chunkIndex, data});
  
  return new Promise((resolve, reject) => { 
    tx.oncomplete = () => {
      resolve();
    }
    tx.onerror = () => {
      reject(tx.error);
    }    
  })
}

export async function saveMetaData(metaData: FileMetadata): Promise<void> { 
  const db = await openDB();
  const tx = db.transaction(FILE_STORE, "readwrite");
  const store = tx.objectStore(FILE_STORE);
  store.put(metaData);
  
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => {
      resolve();
    }
    tx.onerror = () => {
      reject(tx.error);
    }    
  })
}

export async function getMetaData(fileId: string): Promise<FileMetadata | null> { 
  const db = await openDB();
  const tx = db.transaction(FILE_STORE, "readonly");
  const store = tx.objectStore(FILE_STORE);
  const request = store.get(fileId);
  
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result || null);
    }
    request.onerror = () => {
      reject(request.error);
    }
  })
}

export const updateFileProgress = async (
  fileId: string,
  receivedChunks: number,
  status?: FileMetadata["status"]
): Promise<void> => {
  const metadata = await getMetaData(fileId);
  if (!metadata) return;

  metadata.receivedChunks = receivedChunks;
  if (status) metadata.status = status;

  await saveMetaData(metadata);
};

export const getLastChunkIndex = async (
  fileId: string
): Promise<number | null> => {
  const db = await openDB();
  const tx = db.transaction(CHUNK_STORE, "readonly");
  const store = tx.objectStore(CHUNK_STORE);
  const index = store.index("fileId");

  const req = index.openCursor(IDBKeyRange.only(fileId), "prev");

  return new Promise((resolve, reject) => {
    req.onsuccess = () => {
      const cursor = req.result;

      if (cursor) {
        resolve(cursor.value.chunkIndex);
      } else {
        resolve(null);
      }
    };

    req.onerror = () => reject(req.error);
  });
};

export const streamFileToDownload = async (
  fileId: string,
  onProgress?: (percent: number) => void
): Promise<void> => {
  const metadata = await getMetaData(fileId);
  if (!metadata) throw new Error("File not found");

  const db = await openDB();
  const chunks: ArrayBuffer[] = [];

  // read chunks in order
  for (let i = 0; i < metadata.totalChunks; i++) {
    const tx = db.transaction(CHUNK_STORE, "readonly");
    const store = tx.objectStore(CHUNK_STORE);
    const req = store.get([fileId, i]);

    const chunk = await new Promise<ArrayBuffer>((resolve, reject) => {
      req.onsuccess = () => {
        if (req.result) resolve(req.result.data);
        else reject(new Error(`Chunk ${i} not found`));
      };
      req.onerror = () => reject(req.error);
    });

    chunks.push(chunk);

    if (onProgress) {
      onProgress(Math.round(((i + 1) / metadata.totalChunks) * 100));
    }
  }
  
  // create final Blob and download it
  const blob = new Blob(chunks, {type: metadata.mimeType});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = metadata.name;
  a.click();
  URL.revokeObjectURL(url);
};

export async function getFilesInRoom(roomId: string): Promise<FileMetadata[]> {
  const db = await openDB();
  const tx = db.transaction(FILE_STORE, "readonly");
  const store = tx.objectStore(FILE_STORE);

  const req = store.getAll();

  return new Promise((resolve, reject) => {
    req.onsuccess = () => {
      const all = req.result as FileMetadata[];
      resolve(all.filter(f => f.roomId === roomId));
    };
    req.onerror = () => reject(req.error);
  });
}

export async function deleteFile(fileId: string): Promise<void> {
  const db = await openDB();

  // Delete metadata
  const tx1 = db.transaction(FILE_STORE, "readwrite");
  tx1.objectStore(FILE_STORE).delete(fileId);

  await new Promise<void>((resolve, reject) => {
    tx1.oncomplete = () => resolve();
    tx1.onerror = () => reject(tx1.error);
  });

  // Delete all chunks
  const tx2 = db.transaction(CHUNK_STORE, "readwrite");
  const store = tx2.objectStore(CHUNK_STORE);
  const index = store.index("fileId");

  const cursorReq = index.openCursor(IDBKeyRange.only(fileId));

  cursorReq.onsuccess = () => {
    const cursor = cursorReq.result;
    if (cursor) {
      cursor.delete();
      cursor.continue();
    }
  };

  await new Promise<void>((resolve, reject) => {
    tx2.oncomplete = () => resolve();
    tx2.onerror = () => reject(tx2.error);
  });
}

export async function getUpdatePreviewUrl(
  fileId: string,
  metadata: FileMetadata,
  previewBlob: string | null
): Promise<string> {
  try {
    const db = await openDB();
    const chunks: ArrayBuffer[] = [];
    
    for (let i = 0; i < metadata.receivedChunks; i++) {
      const tx = db.transaction(CHUNK_STORE, "readonly");
      const store = tx.objectStore(CHUNK_STORE);
      const req = store.get([fileId, i]);

      const chunk = await new Promise<ArrayBuffer>((resolve, reject) => {
        req.onsuccess = () => {
          if (req.result) resolve(req.result.data);
          else reject(new Error(`Chunk ${i} missing`));
        };
        req.onerror = () => reject(req.error);
      });

      chunks.push(chunk);
    }

    const blob = new Blob(chunks, { type: metadata.mimeType });
    const url = URL.createObjectURL(blob);

    if (previewBlob) {
      URL.revokeObjectURL(previewBlob);
    }
    
    return url;
  } catch (err) {
    console.error("Preview update failed:", err);
    throw err;
  }
} 

export async function savePartialSendState(
  roomId: string,
  fileName: string,
  fileSize: number,
  lastSentChunk: number,
  totalChunks: number
): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(FILE_STORE, "readwrite");
  const store = tx.objectStore(FILE_STORE);
  
  const sendStateId = `send_${roomId}_${fileName}_${fileSize}`;
  store.put({
    fileId: sendStateId,
    roomId: roomId,
    name: fileName,
    size: fileSize,
    mimeType: "send_state",
    totalChunks: totalChunks,
    receivedChunks: lastSentChunk + 1,
    status: "paused" as const,
    createdAt: Date.now(),
  });

  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getPartialSendState(
  roomId: string,
  fileName: string,
  fileSize: number
): Promise<number> {
  const db = await openDB();
  const tx = db.transaction(FILE_STORE, "readonly");
  const store = tx.objectStore(FILE_STORE);
  
  const sendStateId = `send_${roomId}_${fileName}_${fileSize}`;
  const request = store.get(sendStateId);

  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      if (request.result && request.result.mimeType === "send_state") {
        resolve(request.result.receivedChunks - 1);
      } else {
        resolve(-1);
      }
    };
    request.onerror = () => reject(request.error);
  });
}

export async function clearPartialSendState(
  roomId: string,
  fileName: string,
  fileSize: number
): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(FILE_STORE, "readwrite");
  const store = tx.objectStore(FILE_STORE);
  
  const sendStateId = `send_${roomId}_${fileName}_${fileSize}`;
  store.delete(sendStateId);

  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function clearRoom(roomId: string): Promise<void> {
  const files = await getFilesInRoom(roomId);
  for (const file of files) {
    await deleteFile(file.fileId);
  }
}