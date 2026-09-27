export const DB_NAME = "PeerLink_files";
export const DB_VERSION = 3;  
export const CHUNK_STORE = "chunks";
export const PROGRESS_STORE = "progress";
export const FILE_STORE = "files";
const LARGE_PREVIEW_THRESHOLD = 32 * 1024 * 1024;
const PREVIEW_STALE_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_PREVIEW_CLEANUP_ENTRIES = 512;
const PREVIEW_FILE_PREFIX = ".peerlink-preview-";

export type FileMetadata = {
  fileId: string;
  roomId: string;
  name: string;
  path?: string;
  size: number;
  mimeType: string;
  totalChunks: number;
  chunkSize?: number;
  receivedChunks: number;
  status: "receiving" | "complete" | "paused";
  createdAt: number;
};

let databasePromise: Promise<IDBDatabase> | null = null;

export function openDB(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    
    request.onupgradeneeded = (event) => { 
      const db = request.result;
      const oldVersion = event.oldVersion ?? 0;
      
      // Create CHUNK_STORE if it doesn't exist
      if (!db.objectStoreNames.contains(CHUNK_STORE)) { 
        const chunkStore = db.createObjectStore(CHUNK_STORE, { keyPath: ["fileId", "chunkIndex"] });
        chunkStore.createIndex("fileId", "fileId", {unique: false});
      }
      
      // Create FILE_STORE if it doesn't exist - THIS WAS MISSING!
      if (!db.objectStoreNames.contains(FILE_STORE)) {
        const fileStore = db.createObjectStore(FILE_STORE, { keyPath: "fileId" });
        fileStore.createIndex("roomId", "roomId", { unique: false });
      }
      
      // Remove old PROGRESS_STORE if upgrading from version 1
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
      request.result.onversionchange = () => { request.result.close(); databasePromise = null; };
      request.result.onclose = () => { databasePromise = null; };
      resolve(request.result);
    }
    
    request.onerror = () => { 
      databasePromise = null;
      reject(request.error);
    }
  });
  return databasePromise;
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

/** Persist a group of received chunks in one IndexedDB transaction. */
export async function saveChunks(
  fileId: string,
  chunks: ReadonlyArray<{ chunkIndex: number; data: ArrayBuffer }>,
  metadata?: FileMetadata
): Promise<void> {
  if (chunks.length === 0) return;

  const db = await openDB();
  const tx = db.transaction(metadata ? [CHUNK_STORE, FILE_STORE] : CHUNK_STORE, "readwrite");
  const store = tx.objectStore(CHUNK_STORE);
  for (const chunk of chunks) {
    store.put({ fileId, chunkIndex: chunk.chunkIndex, data: chunk.data });
  }
  if (metadata) tx.objectStore(FILE_STORE).put(metadata);

  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
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
    tx.onabort = () => {
      reject(tx.error ?? new DOMException("Transaction aborted", "AbortError"));
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

/** Read an inclusive, bounded byte range from a completed file without assembling the file in memory. */
export async function readFileRange(
  fileId: string,
  metadata: FileMetadata,
  start: number,
  end: number
): Promise<ArrayBuffer> {
  const maxRangeBytes = 1024 * 1024;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end - start + 1 > maxRangeBytes) {
    throw new Error("Invalid or oversized file range.");
  }
  if (metadata.status !== "complete" || !Number.isSafeInteger(metadata.size) || metadata.size < 0 ||
      !Number.isSafeInteger(metadata.totalChunks) || metadata.totalChunks < 0 ||
      metadata.receivedChunks !== metadata.totalChunks) {
    throw new Error("The requested file is incomplete or has invalid metadata.");
  }
  if (start >= metadata.size || metadata.size === 0) return new ArrayBuffer(0);

  const db = await openDB();
  const readChunk = (chunkIndex: number): Promise<ArrayBuffer> => new Promise((resolve, reject) => {
    const request = db.transaction(CHUNK_STORE, "readonly").objectStore(CHUNK_STORE).get([fileId, chunkIndex]);
    request.onsuccess = () => {
      const data = (request.result as { data?: unknown } | undefined)?.data;
      if (data instanceof ArrayBuffer) resolve(data);
      else reject(new Error(`File chunk ${chunkIndex} is missing or invalid.`));
    };
    request.onerror = () => reject(request.error);
  });

  let chunkSize = metadata.chunkSize;
  if (chunkSize !== undefined && chunkSize > maxRangeBytes) {
    throw new Error("The file has an unsupported chunk size for range reads.");
  }
  let firstChunk: ArrayBuffer | undefined;
  if (chunkSize === undefined) {
    firstChunk = await readChunk(0);
    chunkSize = firstChunk.byteLength;
  }
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > maxRangeBytes ||
      metadata.totalChunks !== Math.ceil(metadata.size / chunkSize)) {
    throw new Error("The file has invalid chunk-size metadata.");
  }

  const actualEnd = Math.min(end, metadata.size - 1);
  const output = new Uint8Array(actualEnd - start + 1);
  let outputOffset = 0;
  const firstIndex = Math.floor(start / chunkSize);
  const lastIndex = Math.floor(actualEnd / chunkSize);
  for (let index = firstIndex; index <= lastIndex; index++) {
    const chunk = index === 0 && firstChunk ? firstChunk : await readChunk(index);
    const expectedSize = Math.min(chunkSize, metadata.size - index * chunkSize);
    if (chunk.byteLength !== expectedSize) throw new Error(`File chunk ${index} has an unexpected size.`);
    const chunkStart = index * chunkSize;
    const copyStart = Math.max(start, chunkStart) - chunkStart;
    const copyEnd = Math.min(actualEnd + 1, chunkStart + chunk.byteLength) - chunkStart;
    const slice = new Uint8Array(chunk, copyStart, copyEnd - copyStart);
    output.set(slice, outputOffset);
    outputOffset += slice.byteLength;
  }
  if (outputOffset !== output.byteLength) throw new Error("The requested file range is incomplete.");
  return output.buffer;
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

export const getChunkIndices = async (fileId: string): Promise<number[]> => {
  const db = await openDB();
  const tx = db.transaction(CHUNK_STORE, "readonly");
  const store = tx.objectStore(CHUNK_STORE);
  const index = store.index("fileId");
  const req = index.openCursor(IDBKeyRange.only(fileId));
  const chunkIndices: number[] = [];

  return new Promise((resolve, reject) => {
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        chunkIndices.push(cursor.value.chunkIndex);
        cursor.continue();
      } else {
        resolve(chunkIndices.sort((a, b) => a - b));
      }
    };

    req.onerror = () => reject(req.error);
  });
};

export const streamFileToDownload = async (
  fileId: string,
  onProgress?: (percent: number) => void,
  options: { picker?: boolean; name?: string } = {}
): Promise<void> => {
  const picker = (window as unknown as { showSaveFilePicker?: (options: object) => Promise<{ createWritable: () => Promise<{ write: (data: ArrayBuffer) => Promise<void>; close: () => Promise<void>; abort: () => Promise<void> }> }> }).showSaveFilePicker;
  // Request the destination while the user's click activation is still valid.
  const destination = picker && options.picker !== false ? picker({ suggestedName: options.name }).then(handle => handle.createWritable()) : null;
  destination?.catch(() => undefined);
  const metadata = await getMetaData(fileId);
  if (!metadata || metadata.status !== 'complete') throw new Error("File is not complete");

  if (destination) {
    const writable = await destination;
    try {
      const db = await openDB();
      let written = 0;
      for (let i = 0; i < metadata.totalChunks; i++) {
        const chunk = await new Promise<ArrayBuffer>((resolve, reject) => {
          const req = db.transaction(CHUNK_STORE, 'readonly').objectStore(CHUNK_STORE).get([fileId, i]);
          req.onsuccess = () => req.result ? resolve(req.result.data) : reject(new Error(`Missing chunk ${i}`));
          req.onerror = () => reject(req.error);
        });
        await writable.write(chunk);
        written += chunk.byteLength;
        onProgress?.(Math.round(written / metadata.size * 100));
      }
      if (written !== metadata.size) throw new Error('File size mismatch');
      await writable.close();
    } catch (error) { await writable.abort(); throw error; }
    return;
  }
  if (metadata.size > 512 * 1024 * 1024) throw new Error('For this large download, use a browser with direct-to-disk saving, such as Chrome or Edge.');

  const db = await openDB();
  const chunks: Blob[] = [];

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

    chunks.push(new Blob([chunk]));

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
  setTimeout(() => URL.revokeObjectURL(url), 30000);
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
    tx1.onabort = () => reject(tx1.error ?? new DOMException("Transaction aborted", "AbortError"));
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
    tx2.onabort = () => reject(tx2.error ?? new DOMException("Transaction aborted", "AbortError"));
  });
}

type StagedPreview = {
  directory: FileSystemDirectoryHandle;
  fileName: string;
  releaseLock: (() => void) | null;
};

const stagedPreviews = new Map<string, StagedPreview>();
let stalePreviewCleanup: Promise<void> | null = null;

function previewLockName(fileName: string): string {
  return `peerlink-preview:${fileName}`;
}

async function holdPreviewFileLock(fileName: string): Promise<(() => void) | null> {
  const lockManager = navigator.locks;
  if (typeof lockManager?.request !== "function") return null;

  let unlock!: () => void;
  let resolveAcquired!: () => void;
  let rejectAcquired!: (error: unknown) => void;
  const acquired = new Promise<void>((resolve, reject) => {
    resolveAcquired = resolve;
    rejectAcquired = reject;
  });
  const held = new Promise<void>((resolve) => { unlock = resolve; });
  const request = lockManager.request(previewLockName(fileName), { mode: "exclusive" }, async (lock) => {
    if (!lock) {
      rejectAcquired(new Error("Unable to protect the active preview file."));
      return;
    }
    resolveAcquired();
    await held;
  });
  void request.catch(rejectAcquired);
  await acquired;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    unlock();
  };
}

async function removeStalePreviewFiles(directory: FileSystemDirectoryHandle): Promise<void> {
  const lockManager = navigator.locks;
  if (typeof lockManager?.request !== "function") return;
  const entries = (directory as FileSystemDirectoryHandle & {
    entries?: () => AsyncIterableIterator<[string, FileSystemHandle]>;
  }).entries;
  if (typeof entries !== "function") return;

  let inspected = 0;
  const now = Date.now();
  for await (const [fileName, handle] of entries.call(directory)) {
    if (inspected++ >= MAX_PREVIEW_CLEANUP_ENTRIES) break;
    if (handle.kind !== "file" || !fileName.startsWith(PREVIEW_FILE_PREFIX)) continue;

    const timestamp = Number(/^\.peerlink-preview-(\d+)-/.exec(fileName)?.[1]);
    if (!Number.isSafeInteger(timestamp) || now - timestamp <= PREVIEW_STALE_AGE_MS) continue;

    try {
      await lockManager.request(previewLockName(fileName), { mode: "exclusive", ifAvailable: true }, async (lock) => {
        if (!lock) return;
        try {
          await directory.removeEntry(fileName);
        } catch (error) {
          if (!(error instanceof DOMException) || error.name !== "NotFoundError") {
            console.warn("Unable to remove stale preview file:", error);
          }
        }
      });
    } catch (error) {
      console.warn("Unable to check stale preview file:", error);
    }
  }
}

function cleanupStalePreviewFilesOnce(directory: FileSystemDirectoryHandle): Promise<void> {
  if (!stalePreviewCleanup) {
    stalePreviewCleanup = removeStalePreviewFiles(directory).catch((error) => {
      console.warn("Unable to clean stale preview files:", error);
    });
  }
  return stalePreviewCleanup;
}

export async function releasePreviewUrl(url: string): Promise<void> {
  URL.revokeObjectURL(url);
  const staged = stagedPreviews.get(url);
  if (!staged) return;

  stagedPreviews.delete(url);
  try {
    await staged.directory.removeEntry(staged.fileName);
  } catch (error) {
    if (!(error instanceof DOMException) || error.name !== "NotFoundError") {
      console.warn("Unable to remove temporary preview file:", error);
    }
  } finally {
    staged.releaseLock?.();
  }
}

function errorWithPreviewStorageContext(error: unknown): Error {
  if (error instanceof Error && error.name === "QuotaExceededError") {
    return new Error("There is not enough browser storage available to stage this preview. Free storage space and try again.");
  }
  return error instanceof Error ? error : new Error(String(error));
}

function readPreviewChunk(db: IDBDatabase, fileId: string, index: number): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(CHUNK_STORE, "readonly").objectStore(CHUNK_STORE).get([fileId, index]);
    request.onsuccess = () => {
      const data = (request.result as { data?: unknown } | undefined)?.data;
      if (data instanceof ArrayBuffer) resolve(data);
      else reject(new Error(`Preview chunk ${index} is missing or invalid.`));
    };
    request.onerror = () => reject(request.error);
  });
}

async function createStagedPreviewUrl(
  fileId: string,
  metadata: FileMetadata,
  db: IDBDatabase
): Promise<string> {
  if (!navigator.storage || typeof navigator.storage.getDirectory !== "function") {
    throw new Error("Large-file previews require browser support for the origin-private file system (OPFS) in a secure context.");
  }
  if (metadata.status !== "complete" || !Number.isSafeInteger(metadata.size) || metadata.size <= LARGE_PREVIEW_THRESHOLD ||
      !Number.isSafeInteger(metadata.totalChunks) || metadata.totalChunks < 1 || metadata.receivedChunks !== metadata.totalChunks) {
    throw new Error("The file is incomplete or has invalid chunk metadata, so it cannot be previewed.");
  }

  let fileChunkSize = metadata.chunkSize;
  if (fileChunkSize !== undefined && (!Number.isSafeInteger(fileChunkSize) || fileChunkSize < 1)) {
    throw new Error("The file has invalid chunk-size metadata and cannot be previewed.");
  }

  let root: FileSystemDirectoryHandle | null = null;
  let fileName: string | null = null;
  let writable: FileSystemWritableFileStream | null = null;
  let releaseLock: (() => void) | null = null;
  let objectUrl: string | null = null;
  try {
    root = await navigator.storage.getDirectory();
    await cleanupStalePreviewFilesOnce(root);
    const uniqueId = typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    fileName = `${PREVIEW_FILE_PREFIX}${Date.now()}-${uniqueId}`;
    releaseLock = await holdPreviewFileLock(fileName);
    const handle = await root.getFileHandle(fileName, { create: true });
    writable = await handle.createWritable();

    let written = 0;
    for (let index = 0; index < metadata.totalChunks; index++) {
      const chunk = await readPreviewChunk(db, fileId, index);
      if (fileChunkSize === undefined) {
        fileChunkSize = chunk.byteLength;
        if (!Number.isSafeInteger(fileChunkSize) || fileChunkSize < 1) {
          throw new Error("The file has an empty or invalid preview chunk.");
        }
      }

      const expectedChunkCount = Math.ceil(metadata.size / fileChunkSize);
      const expectedChunkSize = index < metadata.totalChunks - 1
        ? fileChunkSize
        : metadata.size - fileChunkSize * (metadata.totalChunks - 1);
      if (expectedChunkCount !== metadata.totalChunks || expectedChunkSize < 1 || chunk.byteLength !== expectedChunkSize) {
        throw new Error(`Preview chunk ${index} has an unexpected size.`);
      }

      await writable.write(chunk);
      written += chunk.byteLength;
    }

    if (written !== metadata.size) throw new Error("The staged preview size does not match the file metadata.");
    await writable.close();
    writable = null;

    const stagedFile = await handle.getFile();
    const contentType = metadata.mimeType || stagedFile.type;
    const previewFile = stagedFile.type === contentType
      ? stagedFile
      : new File([stagedFile], metadata.name, { type: contentType, lastModified: stagedFile.lastModified });
    objectUrl = URL.createObjectURL(previewFile);
    stagedPreviews.set(objectUrl, { directory: root, fileName, releaseLock });
    releaseLock = null;
    return objectUrl;
  } catch (error) {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    if (writable) {
      try { await writable.abort(); } catch { /* The staging file is removed below. */ }
    }
    if (root && fileName) {
      try { await root.removeEntry(fileName); } catch { /* Preserve the original staging error. */ }
    }
    releaseLock?.();
    throw errorWithPreviewStorageContext(error);
  }
}

export async function getUpdatePreviewUrl(
  fileId: string,
  metadata: FileMetadata,
  previewBlob: string | null
): Promise<string> {
  try {
    const db = await openDB();
    if (metadata.size > LARGE_PREVIEW_THRESHOLD) {
      const url = await createStagedPreviewUrl(fileId, metadata, db);
      if (previewBlob) void releasePreviewUrl(previewBlob);
      return url;
    }

    const chunks: Blob[] = [];
    
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

      chunks.push(new Blob([chunk]));
    }

    const blob = new Blob(chunks, { type: metadata.mimeType });
    const url = URL.createObjectURL(blob);

    if (previewBlob) void releasePreviewUrl(previewBlob);
    
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
  if (!roomId || roomId.trim() === "") return;
  
  const files = await getFilesInRoom(roomId);
  for (const file of files) {
    await deleteFile(file.fileId);
  }
}
