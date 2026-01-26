import { Pause, Play, X, Clock, FolderOpen } from "lucide-react";
import type { QueuedFile } from "../types";
import { formatBytes, formatTime, calculateETA } from "../utils/helpers";
import { CircularProgress } from "./CircularProgress";

interface SendQueueProps {
    queue: QueuedFile[];
    onPause: (fileId: string) => void;
    onResume: (fileId: string) => void;
    onRemove: (fileId: string) => void;
    onClearAll: () => void;
}

export function SendQueue({
    queue,
    onPause,
    onResume,
    onRemove,
    onClearAll,
}: SendQueueProps) {
    if (queue.length === 0) return null;

    const sentCount = queue.filter((f) => f.status === "sent").length;

    return (
        <div className="send-queue glass-card">
            <div className="queue-header">
                <h3 className="section-title">
                    Sending Queue
                    <span className="queue-count">
                        {sentCount}/{queue.length}
                    </span>
                </h3>
                <button onClick={onClearAll} className="btn-icon btn-danger-text">
                    <X size={16} />
                    <span>Clear All</span>
                </button>
            </div>

            <div className="queue-list">
                {queue.map((file) => {
                    const { eta, speed } = file.startTime && file.bytesTransferred
                        ? calculateETA(file.bytesTransferred, file.file.size, file.startTime)
                        : { eta: 0, speed: 0 };

                    return (
                        <div key={file.id} className={`queue-item status-${file.status}`}>
                            <CircularProgress
                                progress={file.progress}
                                size={48}
                                strokeWidth={4}
                                status={file.status}
                            />

                            <div className="file-info">
                                <span className="file-name">{file.file.name}</span>
                                {(file.file as any).webkitRelativePath && (
                                    <div className="file-path">
                                        <FolderOpen size={12} />
                                        <span>{(file.file as any).webkitRelativePath}</span>
                                    </div>
                                )}
                                <div className="file-meta">
                                    <span className="file-size">{formatBytes(file.file.size)}</span>
                                    {file.status === "sending" && speed > 0 && (
                                        <>
                                            <span className="separator">•</span>
                                            <span className="transfer-speed">{formatBytes(speed)}/s</span>
                                        </>
                                    )}
                                </div>
                            </div>

                            <div className="file-status">
                                {file.status === "sending" && eta > 0 && eta !== Infinity && (
                                    <div className="eta">
                                        <Clock size={14} />
                                        <span>{formatTime(eta)}</span>
                                    </div>
                                )}
                                <span className={`status-badge badge-${file.status}`}>
                                    {file.status === "sending"
                                        ? `${file.progress}%`
                                        : file.status === "paused"
                                            ? "Paused"
                                            : file.status === "sent"
                                                ? "Complete"
                                                : "Pending"}
                                </span>
                            </div>

                            <div className="file-actions">
                                {file.status === "sending" && (
                                    <button
                                        onClick={() => onPause(file.id)}
                                        className="btn-icon"
                                        title="Pause"
                                    >
                                        <Pause size={16} />
                                    </button>
                                )}
                                {file.status === "paused" && (
                                    <button
                                        onClick={() => onResume(file.id)}
                                        className="btn-icon btn-success"
                                        title="Resume"
                                    >
                                        <Play size={16} />
                                    </button>
                                )}
                                {file.status !== "sent" && (
                                    <button
                                        onClick={() => onRemove(file.id)}
                                        className="btn-icon btn-danger"
                                        title="Remove"
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
