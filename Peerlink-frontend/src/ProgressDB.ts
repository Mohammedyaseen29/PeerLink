import { downloadWithServiceWorker, localPreviewUrl } from './download/serviceWorkerDownload';
import { checkPreviewSize, MAX_TEXT_PREVIEW_BYTES, safePreviewMime } from './previewPolicy';

export const DB_NAME = "PeerLink_files";
export const DB_VERSION = 4;
export const CHUNK_STORE = "chunks";
export const PROGRESS_STORE = "progress";
export const FILE_STORE = "files";
const LARGE_PREVIEW_THRESHOLD = 32 * 1024 * 1024;
const MAX_FILE_RANGE_BYTES = 1024 * 1024;
const MAX_BLOB_DOWNLOAD_BYTES = 32 * 1024 * 1024;

export type FileMetadata = {
  fileId: string;
  roomId: string;
  roomType?: "persistent" | "temporary";
  name: string;
  path?: string;
  size: number;
  mimeType: string;
  totalChunks: number;
  chunkSize?: number;
  /** Missing on existing files, which retain one row per wire chunk. */
  storageFormat?: 'extent-v1';
  receivedChunks: number;
  status: "receiving" | "complete" | "paused";
  createdAt: number;
  /** Time the final receive batch was committed; older copies use createdAt. */
  completedAt?: number;
  /** Whether this received copy may be re-advertised to room peers. */
  sharedWithRoom?: boolean;
  sourcePeerId?: string;
  /** Sender's transfer ID, used to match a received copy to its peer catalog entry. */
  sourceFileId?: string;
  sourceName?: string;
  /** Present only on transient remote catalog entries. */
  remoteFileId?: string;
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
      const fileStore = db.objectStoreNames.contains(FILE_STORE)
        ? request.transaction!.objectStore(FILE_STORE)
        : db.createObjectStore(FILE_STORE, { keyPath: "fileId" });
      if (!fileStore.indexNames.contains("roomId")) fileStore.createIndex("roomId", "roomId", { unique: false });
      
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

/** Pack only this committed wire batch. Partial/timer batches never wait for a full extent. */
export function storageRows(fileId: string, chunks: ReadonlyArray<{ chunkIndex: number; data: ArrayBuffer }>, metadata?: FileMetadata) {
  if (metadata?.storageFormat !== 'extent-v1') return chunks.map(chunk => ({ fileId, ...chunk }));
  const chunkSize = metadata.chunkSize;
  if (!Number.isSafeInteger(chunkSize) || !chunkSize || chunkSize < 1 || chunkSize > MAX_FILE_RANGE_BYTES) {
    throw new Error('Invalid extent chunk size.');
  }
  const rows: Array<{ fileId: string; chunkIndex: number; chunkCount: number; data: ArrayBuffer }> = [];
  let first = 0;
  while (first < chunks.length) {
    let last = first;
    let length = 0;
    while (last < chunks.length) {
      const chunk = chunks[last];
      if (!Number.isSafeInteger(chunk.chunkIndex) || chunk.chunkIndex < 0 || chunk.chunkIndex >= metadata.totalChunks ||
          (last > 0 && chunk.chunkIndex !== chunks[last - 1].chunkIndex + 1) || !(chunk.data instanceof ArrayBuffer) ||
          chunk.data.byteLength !== Math.min(chunkSize, metadata.size - chunk.chunkIndex * chunkSize)) {
        throw new Error('Invalid or non-contiguous extent batch.');
      }
      if (length + chunk.data.byteLength > MAX_FILE_RANGE_BYTES) break;
      length += chunk.data.byteLength;
      last++;
    }
    const data = new Uint8Array(length);
    let offset = 0;
    for (let i = first; i < last; i++) { data.set(new Uint8Array(chunks[i].data), offset); offset += chunks[i].data.byteLength; }
    rows.push({ fileId, chunkIndex: chunks[first].chunkIndex, chunkCount: last - first, data: data.buffer });
    first = last;
  }
  return rows;
}

/** Persist a group of received chunks and its progress atomically. */
export async function saveChunks(
  fileId: string,
  chunks: ReadonlyArray<{ chunkIndex: number; data: ArrayBuffer }>,
  metadata?: FileMetadata
): Promise<void> {
  if (chunks.length === 0) return;
  const rows = storageRows(fileId, chunks, metadata);
  const db = await openDB();
  const tx = db.transaction(metadata ? [CHUNK_STORE, FILE_STORE] : CHUNK_STORE, "readwrite");
  const store = tx.objectStore(CHUNK_STORE);
  for (const chunk of rows) {
    store.put(chunk);
  }
  if (metadata) tx.objectStore(FILE_STORE).put(metadata);

  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new DOMException("IndexedDB transaction failed.", "UnknownError"));
    tx.onabort = () => reject(tx.error ?? new DOMException("Transaction aborted", "AbortError"));
    if (typeof tx.commit === "function") tx.commit();
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
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end - start + 1 > MAX_FILE_RANGE_BYTES) {
    throw new Error("Invalid or oversized file range.");
  }
  if (metadata.status !== "complete" || !Number.isSafeInteger(metadata.size) || metadata.size < 0 ||
      !Number.isSafeInteger(metadata.totalChunks) || metadata.totalChunks < 0 ||
      metadata.receivedChunks !== metadata.totalChunks) {
    throw new Error("The requested file is incomplete or has invalid metadata.");
  }
  if (start >= metadata.size || metadata.size === 0) return new ArrayBuffer(0);

  const db = await openDB();
  let chunkSize = metadata.chunkSize;
  if (chunkSize !== undefined && chunkSize > MAX_FILE_RANGE_BYTES) {
    throw new Error("The file has an unsupported chunk size for range reads.");
  }
  if (chunkSize === undefined) {
    const firstChunk = await new Promise<ArrayBuffer>((resolve, reject) => {
      const request = db.transaction(CHUNK_STORE, "readonly").objectStore(CHUNK_STORE).get([fileId, 0]);
      request.onsuccess = () => {
        const data = (request.result as { data?: unknown } | undefined)?.data;
        if (data instanceof ArrayBuffer) resolve(data);
        else reject(new Error("File chunk 0 is missing or invalid."));
      };
      request.onerror = () => reject(request.error ?? new Error("Unable to read file chunk 0."));
    });
    chunkSize = firstChunk.byteLength;
  }
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > MAX_FILE_RANGE_BYTES ||
      metadata.totalChunks !== Math.ceil(metadata.size / chunkSize)) {
    throw new Error("The file has invalid chunk-size metadata.");
  }

  if (metadata.storageFormat !== undefined && metadata.storageFormat !== 'extent-v1') throw new Error("Unsupported file storage format.");
  const actualEnd = Math.min(end, metadata.size - 1);
  const output = new Uint8Array(actualEnd - start + 1);
  const firstIndex = Math.floor(start / chunkSize);
  const lastIndex = Math.floor(actualEnd / chunkSize);
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const tx = db.transaction(CHUNK_STORE, "readonly");
    const store = tx.objectStore(CHUNK_STORE);
    let expectedIndex = firstIndex;
    let outputOffset = 0;
    let settled = false;
    let done = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      try { tx.abort(); } catch { /* The transaction may already be inactive. */ }
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const scan = (first: number) => {
      expectedIndex = first;
      const request = store.openCursor(IDBKeyRange.bound([fileId, first], [fileId, lastIndex]));
      request.onerror = () => fail(request.error ?? new Error("Unable to read file extents."));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) { done = true; return; }
        const row = cursor.value as { fileId?: unknown; chunkIndex?: unknown; chunkCount?: number; data?: unknown };
        const count = metadata.storageFormat === 'extent-v1' ? row.chunkCount : 1;
        if (row.fileId !== fileId || row.chunkIndex !== expectedIndex || !Number.isSafeInteger(count) || !count || count < 1 ||
            expectedIndex + count > metadata.totalChunks || !(row.data instanceof ArrayBuffer) || row.data.byteLength > MAX_FILE_RANGE_BYTES) {
          fail(new Error('File extent at chunk ' + expectedIndex + ' is missing or invalid.')); return;
        }
        const rowStart = expectedIndex * chunkSize;
        const rowEnd = Math.min((expectedIndex + count) * chunkSize, metadata.size);
        if (row.data.byteLength !== rowEnd - rowStart || rowEnd <= start) {
          fail(new Error('File extent at chunk ' + expectedIndex + ' has an unexpected size.')); return;
        }
        const copyStart = Math.max(start, rowStart);
        const copyEnd = Math.min(actualEnd + 1, rowEnd);
        if (copyEnd > copyStart) {
          output.set(new Uint8Array(row.data, copyStart - rowStart, copyEnd - copyStart), outputOffset);
          outputOffset += copyEnd - copyStart;
        }
        expectedIndex += count;
        cursor.continue();
      };
    };
    if (metadata.storageFormat === 'extent-v1') {
      // Locate one predecessor key without cloning its bytes, then scan this bounded range.
      const preceding = store.openKeyCursor(IDBKeyRange.bound([fileId, 0], [fileId, firstIndex]), 'prev');
      preceding.onerror = () => fail(preceding.error ?? new Error("Unable to locate file extent."));
      preceding.onsuccess = () => {
        const key = preceding.result?.primaryKey as [string, number] | undefined;
        if (!key || key[0] !== fileId || !Number.isSafeInteger(key[1])) {
          fail(new Error("The requested file range has a missing extent.")); return;
        }
        scan(key[1]);
      };
    } else scan(firstIndex);
    tx.oncomplete = () => {
      if (settled) return;
      if (!done || expectedIndex <= lastIndex || outputOffset !== output.byteLength) {
        fail(new Error("The requested file range is incomplete.")); return;
      }
      settled = true;
      resolve(output.buffer);
    };
    tx.onerror = () => fail(tx.error ?? new Error("Unable to read file extents."));
    tx.onabort = () => fail(tx.error ?? new DOMException("File range read was aborted.", "AbortError"));
  });
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
        resolve(cursor.value.chunkIndex + (cursor.value.chunkCount || 1) - 1);
      } else {
        resolve(null);
      }
    };

    req.onerror = () => reject(req.error);
  });
};

/** Enumerates logical wire indices; diagnostic helper, unsuitable for a complete multi-million-chunk file. */
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
        for (let i = 0; i < (cursor.value.chunkCount || 1); i++) chunkIndices.push(cursor.value.chunkIndex + i);
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
      let written = 0;
      for (let start = 0; start < metadata.size; start += MAX_FILE_RANGE_BYTES) {
        const end = Math.min(start + MAX_FILE_RANGE_BYTES, metadata.size) - 1;
        const range = await readFileRange(fileId, metadata, start, end);
        await writable.write(range);
        written += range.byteLength;
        onProgress?.(metadata.size ? Math.round(written / metadata.size * 100) : 100);
      }
      if (written !== metadata.size) throw new Error('File size mismatch');
      await writable.close();
    } catch (error) { await writable.abort(); throw error; }
    return;
  }
  if (metadata.size > MAX_BLOB_DOWNLOAD_BYTES) {
    await downloadWithServiceWorker(fileId, options.name || metadata.name, metadata.size, metadata.storageFormat);
    return;
  }

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
  const req = tx.objectStore(FILE_STORE).index("roomId").getAll(IDBKeyRange.only(roomId));

  return new Promise((resolve, reject) => {
    req.onsuccess = () => {
      resolve(req.result as FileMetadata[]);
    };
    req.onerror = () => reject(req.error);
  });
}

/** Metadata only: file bytes stay in the chunk store until previewed. */
export async function getStoredFiles(): Promise<FileMetadata[]> {
  const db = await openDB();
  const request = db.transaction(FILE_STORE, "readonly").objectStore(FILE_STORE).getAll();
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result as FileMetadata[]);
    request.onerror = () => reject(request.error);
  });
}

export async function deleteFile(fileId: string): Promise<void> {
  const db = await openDB();
  const tx = db.transaction([FILE_STORE, CHUNK_STORE], "readwrite");
  tx.objectStore(FILE_STORE).delete(fileId);
  tx.objectStore(CHUNK_STORE).delete(IDBKeyRange.bound([fileId, 0], [fileId, Number.MAX_SAFE_INTEGER]));

  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new DOMException("Transaction aborted", "AbortError"));
  });
}

/** Local worker preview URLs own no staged files. */
export async function releasePreviewUrl(url: string): Promise<void> {
  if (url.startsWith('blob:')) URL.revokeObjectURL(url);
}

let legacyPreviewCleanup: Promise<void> | undefined;
/** Reclaim crash leftovers from older versions without touching a live old tab's preview. */
function cleanupLegacyPreviews(): Promise<void> {
  return legacyPreviewCleanup ??= (async () => {
    if (!navigator.locks?.request || !navigator.storage?.getDirectory) return;
    const root = await navigator.storage.getDirectory();
    const entries = (root as FileSystemDirectoryHandle & { entries?: () => AsyncIterableIterator<[string, FileSystemHandle]> }).entries;
    if (!entries) return;
    let inspected = 0;
    for await (const [name, handle] of entries.call(root)) {
      if (inspected++ >= 512) break;
      if (handle.kind !== 'file') continue;
      const match = /^\.peerlink-preview-(\d+)-/.exec(name);
      if (!match || !Number.isSafeInteger(Number(match[1])) || Date.now() - Number(match[1]) <= 24 * 60 * 60 * 1000) continue;
      await navigator.locks.request(`peerlink-preview:${name}`, { mode: 'exclusive', ifAvailable: true }, async lock => {
        if (lock) await root.removeEntry(name).catch(() => undefined);
      });
    }
  })().catch(() => undefined);
}

export async function getUpdatePreviewUrl(fileId: string, metadata: FileMetadata, previewBlob: string | null): Promise<string> {
  checkPreviewSize(metadata);
  if (metadata.status !== 'complete') throw new Error('This file is incomplete. Finish receiving it before previewing.');
  let url: string;
  if (metadata.size > LARGE_PREVIEW_THRESHOLD) {
    void cleanupLegacyPreviews();
    url = await localPreviewUrl(fileId);
  } else {
    const size = metadata.mimeType.startsWith('text/') ? Math.min(metadata.size, MAX_TEXT_PREVIEW_BYTES) : metadata.size;
    const chunks: ArrayBuffer[] = [];
    for (let start = 0; start < size; start += MAX_FILE_RANGE_BYTES) {
      chunks.push(await readFileRange(fileId, metadata, start, Math.min(size, start + MAX_FILE_RANGE_BYTES) - 1));
    }
    url = URL.createObjectURL(new Blob(chunks, { type: safePreviewMime(metadata.mimeType) }));
  }
  if (previewBlob) void releasePreviewUrl(previewBlob);
  return url;
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

/** Remove temporary transfers left by an interrupted browser session. */
export async function clearTemporaryFiles(roomId?: string): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(FILE_STORE, "readonly");
  const req = roomId
    ? tx.objectStore(FILE_STORE).index("roomId").getAll(IDBKeyRange.only(roomId))
    : tx.objectStore(FILE_STORE).getAll();
  const files = await new Promise<FileMetadata[]>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result as FileMetadata[]);
    req.onerror = () => reject(req.error);
  });
  for (const file of files) if (file.roomType === "temporary") await deleteFile(file.fileId);
}
