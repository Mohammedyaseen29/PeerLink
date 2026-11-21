import { CircleAlert, LoaderCircle, RefreshCw, X } from "lucide-react";
import type { FileMetadata } from "../ProgressDB";
import { formatBytes } from "../utils/helpers";

interface FilePreviewModalProps {
    file: FileMetadata;
    previewUrl: string | null;
    onClose: () => void;
    error?: string | null;
    onRetry?: () => void;
    onError?: (message: string) => void;
}

export function FilePreviewModal({
    file,
    previewUrl,
    onClose,
    error,
    onRetry,
    onError,
}: FilePreviewModalProps) {
    const mediaError = () => onError?.(file.remoteFileId
        ? "Your browser could not load this peer preview. Keep both devices connected and retry, or ask your peer to send the file."
        : "This browser could not display the file. Download it to open it in another app.");
    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-content glass-card" role="dialog" aria-modal="true" aria-label={`Preview ${file.name}`} onClick={(e) => e.stopPropagation()}>
                <div className="modal-header">
                    <div className="modal-title-group">
                        <h3 className="modal-title">{file.name}</h3>
                        <p className="modal-subtitle">{formatBytes(file.size)}</p>
                    </div>
                    <button onClick={onClose} className="btn-icon btn-close" aria-label="Close preview">
                        <X size={24} />
                    </button>
                </div>

                <div className="modal-body">
                    {error ? <div className="preview-error" role="alert"><CircleAlert size={26} /><strong>Preview unavailable</strong><p>{error}</p>{onRetry && <button type="button" className="btn btn-secondary" onClick={onRetry}><RefreshCw size={15} />Retry preview</button>}</div> : previewUrl ? (
                        <>
                            {file.mimeType.startsWith("image/") && (
                                <img
                                    src={previewUrl}
                                    alt={file.name}
                                    className="preview-media preview-image"
                                    onError={mediaError}
                                />
                            )}
                            {file.mimeType.startsWith("video/") && (
                                <video
                                    src={previewUrl}
                                    controls
                                    className="preview-media preview-video"
                                    playsInline
                                    onError={mediaError}
                                />
                            )}
                            {file.mimeType.startsWith("audio/") && (
                                <audio src={previewUrl} controls className="preview-audio" onError={mediaError} />
                            )}
                            {file.mimeType === "application/pdf" && (
                                <iframe
                                    src={previewUrl}
                                    className="preview-iframe"
                                    title="PDF Preview"
                                    onError={mediaError}
                                />
                            )}
                            {file.mimeType.startsWith("text/") && (
                                <iframe
                                    src={previewUrl}
                                    className="preview-iframe preview-text"
                                    title={`Text preview for ${file.name}`}
                                    sandbox=""
                                    onError={mediaError}
                                />
                            )}
                        </>
                    ) : (
                        <div className="preview-loading">
                            <div className="preview-loading-icon"><LoaderCircle size={22} /></div>
                            <strong>Preparing preview</strong>
                            <p>{file.remoteFileId ? "Connecting to your peer’s file…" : "Reading the file on this device…"}</p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
