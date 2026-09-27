type WorkerRequest =
    | { type: "load"; fileId: string; file: File }
    | { type: "read"; requestId: number; fileId: string; chunkIndex: number; chunkSize: number }
    | { type: "clear"; fileId: string };

type WorkerResponse =
    | { type: "loaded"; fileId: string }
    | { type: "chunk"; requestId: number; fileId: string; chunkIndex: number; buffer: ArrayBuffer }
    | { type: "error"; requestId?: number; fileId?: string; message: string };

const files = new Map<string, File>();
const workerScope = self as unknown as {
    onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
    postMessage: (message: WorkerResponse, transfer?: Transferable[]) => void;
};

workerScope.onmessage = async (event: MessageEvent<WorkerRequest>) => {
    const msg = event.data;

    try {
        if (msg.type === "load") {
            files.set(msg.fileId, msg.file);
            workerScope.postMessage({ type: "loaded", fileId: msg.fileId });
            return;
        }

        if (msg.type === "clear") {
            files.delete(msg.fileId);
            return;
        }

        const file = files.get(msg.fileId);
        if (!file) {
            throw new Error(`No file registered for ${msg.fileId}`);
        }

        const start = msg.chunkIndex * msg.chunkSize;
        const end = Math.min(start + msg.chunkSize, file.size);
        const buffer = await file.slice(start, end).arrayBuffer();

        workerScope.postMessage(
            {
                type: "chunk",
                requestId: msg.requestId,
                fileId: msg.fileId,
                chunkIndex: msg.chunkIndex,
                buffer,
            } satisfies WorkerResponse,
            [buffer]
        );
    } catch (error) {
        workerScope.postMessage({
            type: "error",
            requestId: msg.type === "read" ? msg.requestId : undefined,
            fileId: "fileId" in msg ? msg.fileId : undefined,
            message: error instanceof Error ? error.message : String(error),
        } satisfies WorkerResponse);
    }
};
