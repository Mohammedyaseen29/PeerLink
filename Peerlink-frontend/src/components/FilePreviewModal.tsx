import { X } from "lucide-react";
import type { FileMetadata } from "../ProgressDB";
import { formatBytes } from "../utils/helpers";

interface FilePreviewModalProps {
    file: FileMetadata;
    previewUrl: string | null;
    onClose: () => void;
}

export function FilePreviewModal({
    file,
    previewUrl,
    onClose,
}: FilePreviewModalProps) {
    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-content glass-card" onClick={(e) => e.stopPropagation()}>
                <div className="modal-header">
                    <div className="modal-title-group">
                        <h3 className="modal-title">{file.name}</h3>
                        <p className="modal-subtitle">{formatBytes(file.size)}</p>
                    </div>
                    <button onClick={onClose} className="btn-icon btn-close">
                        <X size={24} />
                    </button>
                </div>

                <div className="modal-body">
                    {previewUrl ? (
                        <>
                            {file.mimeType.startsWith("image/") && (
                                <img
                                    src={previewUrl}
                                    alt={file.name}
                                    className="preview-media preview-image"
                                />
                            )}
                            {file.mimeType.startsWith("video/") && (
                                <video
                                    src={previewUrl}
                                    controls
                                    className="preview-media preview-video"
                                />
                            )}
                            {file.mimeType.startsWith("audio/") && (
                                <audio src={previewUrl} controls className="preview-audio" />
                            )}
                            {file.mimeType === "application/pdf" && (
                                <iframe
                                    src={previewUrl}
                                    className="preview-iframe"
                                    title="PDF Preview"
                                />
                            )}
                            {file.mimeType.startsWith("text/") && (
                                <iframe
                                    src={previewUrl}
                                    className="preview-iframe preview-text"
                                    title="Text Preview"
                                />
                            )}
                        </>
                    ) : (
                        <div className="preview-loading">
                            <div className="loading-spinner" />
                            <p>Loading preview...</p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
