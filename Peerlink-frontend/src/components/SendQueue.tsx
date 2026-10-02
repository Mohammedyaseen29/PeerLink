import { Clock, Eye, FolderOpen, Pause, Play, X } from "lucide-react";
import type { QueuedFile } from "../types";
import { calculateETA, formatBytes, formatTime, getFileMimeType, isPreviewable } from "../utils/helpers";
import { CircularProgress } from "./CircularProgress";

interface SendQueueProps {
    queue: QueuedFile[];
    onPause: (fileId: string) => void;
    onResume: (fileId: string) => void;
    onRemove: (fileId: string) => void;
    onClearAll: () => void;
    onPreview: (file: QueuedFile) => void;
}

const statusLabels: Record<QueuedFile["status"], string> = {
    pending: "Waiting",
    sending: "Sending",
    paused: "Paused",
    failed: "Failed",
    sent: "Sent",
};

export function SendQueue({ queue, onPause, onResume, onRemove, onClearAll, onPreview }: SendQueueProps) {
    if (queue.length === 0) return null;

    const sentCount = queue.filter((file) => file.status === "sent").length;

    return (
        <div className="send-queue glass-card">
            <div className="queue-header">
                <h3 className="section-title">
                    Sending Queue
                    <span className="queue-count">{sentCount}/{queue.length}</span>
                </h3>
                <button type="button" onClick={onClearAll} className="btn-icon btn-danger-text" aria-label="Clear sending queue">
                    <X size={16} />
                    <span>Clear All</span>
                </button>
            </div>

            <div className="queue-list">
                {queue.map((file) => {
                    const { eta, speed } = file.startTime && file.bytesTransferred
                        ? calculateETA(file.bytesTransferred, file.file.size, file.startTime)
                        : { eta: 0, speed: 0 };
                    const relativePath = (file.file as File & { webkitRelativePath?: string }).webkitRelativePath;
                    const mimeType = getFileMimeType(file.file);

                    return (
                        <div key={file.id} className={`queue-item status-${file.status}`}>
                            <CircularProgress
                                progress={file.progress}
                                size={48}
                                strokeWidth={4}
                                status={file.status}
                                ariaLabel={`${file.file.name} transfer progress`}
                            />

                            <div className="file-info">
                                <span className="file-name" title={file.file.name}>{file.file.name}</span>
                                {relativePath && (
                                    <div className="file-path">
                                        <FolderOpen size={12} aria-hidden="true" />
                                        <span title={relativePath}>{relativePath}</span>
                                    </div>
                                )}
                                <div className="file-meta">
                                    <span className="file-bytes">{formatBytes(file.bytesTransferred ?? 0)} / {formatBytes(file.file.size)}</span>
                                    {file.status === "sending" && speed > 0 && (
                                        <>
                                            <span className="separator" aria-hidden="true">•</span>
                                            <span className="transfer-speed">{formatBytes(speed)}/s</span>
                                        </>
                                    )}
                                </div>
                            </div>

                            <div className="file-status">
                                {file.status === "sending" && eta > 0 && eta !== Infinity && (
                                    <span className="eta">
                                        <Clock size={14} aria-hidden="true" />
                                        <span>{formatTime(eta)}</span>
                                    </span>
                                )}
                                <span className={`status-badge badge-${file.status}`}>{statusLabels[file.status]}</span>
                            </div>

                            <div className="file-actions">
                                {isPreviewable(mimeType) && (
                                    <button
                                        type="button"
                                        onClick={() => onPreview(file)}
                                        className="btn-icon queue-preview-btn"
                                        title={`Preview ${file.file.name}`}
                                        aria-label={`Preview ${file.file.name}`}
                                    >
                                        <Eye size={16} />
                                    </button>
                                )}
                                {file.status === "sending" && (
                                    <button
                                        type="button"
                                        onClick={() => onPause(file.id)}
                                        className="btn-icon"
                                        title="Pause"
                                        aria-label={`Pause ${file.file.name}`}
                                    >
                                        <Pause size={16} />
                                    </button>
                                )}
                                {(file.status === "paused" || file.status === "failed") && (
                                    <button
                                        type="button"
                                        onClick={() => onResume(file.id)}
                                        className="btn-icon btn-success"
                                        title={file.status === "failed" ? "Retry" : "Resume"}
                                        aria-label={`${file.status === "failed" ? "Retry" : "Resume"} ${file.file.name}`}
                                    >
                                        <Play size={16} />
                                    </button>
                                )}
                                {file.status !== "sent" && (
                                    <button
                                        type="button"
                                        onClick={() => onRemove(file.id)}
                                        className="btn-icon btn-danger"
                                        title="Remove"
                                        aria-label={`Remove ${file.file.name} from queue`}
                                    >
                                        <X size={16} />
                                    </button>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
