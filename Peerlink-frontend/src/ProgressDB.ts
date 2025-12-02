

export const DB_NAME = "PeerLink_files";
export const DB_VERSION = 2;
export const CHUNK_STORE = "chunks";
export const PROGRESS_STORE = "progress";
export const FILE_STORE = "files"
export type FileMetadata = {
  fileId: string;
  roomId: string;
  name: string;
  size: number;
  totalChunks: number;
  receivedChunks: number;
  status: "receiving" | "complete" | "paused";
  createdAt: number;
};

type ChunkData = {
  fileId: string;
  chunkIndex: number;
  data: ArrayBuffer;
};

export async function openDB():Promise<IDBDatabase>{ 
  return new Promise((resolve, reject) => { 
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    
    request.onupgradeneeded = (event) => { 
      const db = request.result;
      const oldVersion = event.oldVersion ?? 0;
      
      if (!db.objectStoreNames.contains(CHUNK_STORE)) { 
        const chunkStore = db.createObjectStore(CHUNK_STORE, { keyPath: ["fileId", "chunkIndex"] });
        
        chunkStore.createIndex("fileId", "fileId", {unique: false});
      }
      
      if(!db.objectStoreNames.contains(FILE_STORE)) {
        const fileStore = db.createObjectStore(FILE_STORE, { keyPath: "fileId" });
      }
      
      if(!db.objectStoreNames.contains(PROGRESS_STORE)) {
        const progressStore = db.createObjectStore(PROGRESS_STORE, { keyPath: "fileId" });
      }
      
      if (oldVersion < 2) { 
        if(db.objectStoreNames.contains(PROGRESS_STORE)) {
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
      reject(request.result);
    }
  })
}


export async function saveChunk(fileId:string, chunkIndex:number, data:ArrayBuffer):Promise<void>{
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

export async function saveMetaData(metaData: FileMetadata):Promise<void> { 
  const db = await openDB();
  const tx = db.transaction(FILE_STORE, "readwrite");
  const store = tx.objectStore(FILE_STORE);
  
  store.put(metaData);
  
  return new Promise((resolve,reject) => {
    tx.oncomplete = () => {
      resolve();
    }
    tx.onerror = () => {
      reject(tx.error);
    }    
  })
}


export async function getMetaData(fileId:string):Promise<FileMetadata | null> { 
  const db = await openDB();
  const tx = db.transaction(FILE_STORE, "readonly");
  const store = tx.objectStore(FILE_STORE);
  
  const request = store.get(fileId);
  
  return new Promise((resolve,reject) => {
    request.onsuccess = () => {
      resolve(request.result || null);
    }
    request.onerror = () => {
      reject(request.error);
    }
  })
}

export const updateFileProgress = async (fileId: string,receivedChunks: number,status?: FileMetadata["status"]): Promise<void> => {
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
  const blob = new Blob(chunks);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = metadata.name;
  a.click();
  URL.revokeObjectURL(url);
};
