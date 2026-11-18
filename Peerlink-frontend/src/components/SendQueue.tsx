import { useState } from "react";
import { Clock, Eye, Pause, Play, RefreshCw, X } from "lucide-react";
import type { QueuedFile } from "../types";
import { formatBytes, formatTime, getFileMimeType, isPreviewable } from "../utils/helpers";
import { FileThumbnail } from "./FileThumbnail";

interface SendQueueProps {
    queue: QueuedFile[];
    onPause: (fileId: string) => void;
    onResume: (fileId: string) => void;
    onRetry: (fileId: string) => void;
    onRemove: (fileId: string) => void;
    onClearAll: () => void;
    onPreview: (file: QueuedFile) => void;
}

const PAGE_SIZE = 50;

const statusLabels: Record<QueuedFile["status"], string> = {
    pending: "Waiting",
    sending: "Sending",
    paused: "Paused",
    failed: "Failed",
    sent: "Sent",
};

function transferredFor(file: QueuedFile) {
    return file.status === "sent" ? file.file.size : Math.min(file.bytesTransferred ?? 0, file.file.size);
}

function transferSpeed(file: QueuedFile) {
    if (file.status !== "sending") return 0;
    const timing = file as QueuedFile & { speedBytesPerSecond?: number; activeElapsedMs?: number; pausedMs?: number };
    if (typeof timing.speedBytesPerSecond === "number" && Number.isFinite(timing.speedBytesPerSecond)) {
        return Math.max(0, timing.speedBytesPerSecond);
    }
    const elapsedMs = typeof timing.activeElapsedMs === "number"
        ? timing.activeElapsedMs
        : Math.max(0, Date.now() - (file.startTime ?? Date.now()) - (timing.pausedMs ?? 0));
    return elapsedMs >= 500 && (file.bytesTransferred ?? 0) > 0
        ? (file.bytesTransferred ?? 0) / (elapsedMs / 1000)
        : 0;
}

export function SendQueue({ queue, onPause, onResume, onRetry, onRemove, onClearAll, onPreview }: SendQueueProps) {
    const [page, setPage] = useState(0);
    if (queue.length === 0) return null;

    const sentCount = queue.filter(file => file.status === "sent").length;
    const totalBytes = queue.reduce((total, file) => total + file.file.size, 0);
    const transferredBytes = queue.reduce((total, file) => total + transferredFor(file), 0);
    const speed = queue.reduce((total, file) => total + transferSpeed(file), 0);
    const eta = speed > 0 ? Math.max(0, (totalBytes - transferredBytes) / speed) : Infinity;
    const progress = totalBytes > 0 ? Math.min(100, transferredBytes / totalBytes * 100) : sentCount === queue.length ? 100 : 0;
    const cancelableCount = queue.filter(file => ["sending", "pending", "paused"].includes(file.status)).length;
    const clearLabel = cancelableCount > 0 ? "Cancel & clear" : sentCount === queue.length ? "Clear sent" : "Clear queue";
    const clearQueue = () => {
        if (cancelableCount > 0 && !window.confirm(`Cancel ${cancelableCount} unfinished transfers and clear the sending queue?`)) return;
        onClearAll();
    };
    const pageCount = Math.max(1, Math.ceil(queue.length / PAGE_SIZE));
    const visiblePage = Math.min(page, pageCount - 1);
    const visibleFiles = queue.slice(visiblePage * PAGE_SIZE, (visiblePage + 1) * PAGE_SIZE);

    return (
        <section className="send-queue glass-card" aria-label="Outgoing transfers">
            <div className="queue-header">
                <h3 className="section-title">
                    Sending Queue
                    <span className="queue-count">{sentCount}/{queue.length} files sent</span>
                </h3>
                <button
                    type="button"
                    onClick={clearQueue}
                    className="btn-icon btn-danger-text queue-clear-button"
                    aria-label={cancelableCount > 0 ? `Cancel ${cancelableCount} unfinished transfers and clear the sending queue` : sentCount === queue.length ? "Clear completed transfers from the sending queue" : "Clear the sending queue"}
                    title={cancelableCount > 0 ? "Cancels unfinished transfers and clears the sending queue" : sentCount === queue.length ? "Clear completed transfers" : "Clear the sending queue"}
                >
                    <X size={16} aria-hidden="true" />
                    <span>{clearLabel}</span>
                </button>
            </div>

            <div className="queue-overall" aria-label="Overall transfer progress">
                <div className="queue-overall-values">
                    <span>{formatBytes(transferredBytes)} of {formatBytes(totalBytes)}</span>
                    <div className="queue-overall-stats">
                        {speed > 0 && <span>{formatBytes(speed)}/s</span>}
                        {eta !== Infinity && eta > 0 && <span><Clock size={13} aria-hidden="true" />{formatTime(eta)} left</span>}
                        {sentCount === queue.length && <span className="queue-complete">Complete</span>}
                    </div>
                </div>
                <progress className="transfer-progress overall-progress" value={progress} max={100} aria-label="Overall sending progress" />
            </div>

            <div className="queue-list">
                {visibleFiles.map(file => {
                    const bytesTransferred = transferredFor(file);
                    const fileSpeed = transferSpeed(file);
                    const fileEta = fileSpeed > 0 ? Math.max(0, (file.file.size - bytesTransferred) / fileSpeed) : Infinity;
                    const relativePath = (file.file as File & { webkitRelativePath?: string }).webkitRelativePath;
                    const mimeType = getFileMimeType(file.file);
                    const percent = file.status === "sent"
                        ? 100
                        : file.file.size > 0 ? Math.min(99, bytesTransferred / file.file.size * 100) : 0;

                    return (
                        <article key={file.id} className={`queue-item status-${file.status}`}>
                            <FileThumbnail file={file.file} />
                            <div className="file-info queue-file-info">
                                <span className="file-name" title={file.file.name}>{file.file.name}</span>
                                {relativePath && <span className="file-path" title={relativePath}>{relativePath}</span>}
                                <span className="file-meta">
                                    <span>{formatBytes(bytesTransferred)} / {formatBytes(file.file.size)}</span>
                                    {file.status === "sending" && fileSpeed > 0 && <span>{formatBytes(fileSpeed)}/s</span>}
                                    {file.status === "sending" && fileEta > 0 && fileEta !== Infinity && <span>{formatTime(fileEta)} left</span>}
                                </span>
                                {file.error && <span className="queue-file-error" role="status">{file.error}</span>}
                                <progress className="transfer-progress file-progress" value={percent} max={100} aria-label={`${file.file.name}: ${percent}% ${statusLabels[file.status].toLowerCase()}`} />
                            </div>

                            <span className={`status-badge badge-${file.status}`} role="status">{statusLabels[file.status]}</span>

                            <div className="file-actions queue-actions">
                                {isPreviewable(mimeType) && (
                                    <button type="button" onClick={() => onPreview(file)} className="btn-icon queue-preview-btn" title={`Preview ${file.file.name}`} aria-label={`Preview ${file.file.name}`}>
                                        <Eye size={17} aria-hidden="true" />
                                    </button>
                                )}
                                {(file.status === "sending" || file.status === "pending") && (
                                    <button type="button" onClick={() => onPause(file.id)} className="btn-icon" title="Pause" aria-label={`Pause ${file.file.name}`}>
                                        <Pause size={17} aria-hidden="true" />
                                    </button>
                                )}
                                {file.status === "paused" && (
                                    <button type="button" onClick={() => onResume(file.id)} className="btn-icon btn-success" title="Resume" aria-label={`Resume ${file.file.name}`}>
                                        <Play size={17} aria-hidden="true" />
                                    </button>
                                )}
                                {file.status === "failed" && (
                                    <button type="button" onClick={() => onRetry(file.id)} className="btn-icon btn-success" title="Retry" aria-label={`Retry ${file.file.name}`}>
                                        <RefreshCw size={17} aria-hidden="true" />
                                    </button>
                                )}
                                {file.status !== "sent" && (
                                    <button type="button" onClick={() => onRemove(file.id)} className="btn-icon btn-danger" title="Cancel transfer" aria-label={`Cancel transfer of ${file.file.name}`}>
                                        <X size={17} aria-hidden="true" />
                                    </button>
                                )}
                            </div>
                        </article>
                    );
                })}
            </div>

            {pageCount > 1 && (
                <div className="file-pagination" aria-label="Sending queue pages">
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => setPage(Math.max(0, visiblePage - 1))} disabled={visiblePage === 0}>Previous</button>
                    <span>Page {visiblePage + 1} of {pageCount}</span>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => setPage(Math.min(pageCount - 1, visiblePage + 1))} disabled={visiblePage + 1 >= pageCount}>Next</button>
                </div>
            )}
        </section>
    );
}
