import { useState } from "react";
import {
    Download,
    Eye,
    Trash2,
    FileImage,
    FileVideo,
    FileAudio,
    FileText,
    File,
    Archive,
    CheckCircle2,
    LoaderCircle,
} from "lucide-react";
import type { FileMetadata } from "../ProgressDB";
import { formatBytes, isPreviewable, getFileIconType } from "../utils/helpers";
import "./transfer-workspace.css";

interface ReceivedFilesProps {
    files: FileMetadata[];
    onlineFiles: FileMetadata[];
    onDownload: (file: FileMetadata) => Promise<void>;
    onPreview: (file: FileMetadata) => void;
    onDelete: (file: FileMetadata) => void;
    onClearRoom: () => void;
}

const fileIcons = {
    image: FileImage,
    video: FileVideo,
    audio: FileAudio,
    pdf: FileText,
    text: FileText,
    archive: Archive,
    file: File,
};

function storageLabel(file: FileMetadata) {
    if (file.status === "complete" && file.receivedChunks === file.totalChunks) return "Stored on this device";
    if (file.status === "paused") return "Paused · partially stored";
    return "Receiving · partially stored";
}

export function ReceivedFiles({ files, onlineFiles, onDownload, onPreview, onDelete, onClearRoom }: ReceivedFilesProps) {
    const [downloading, setDownloading] = useState<Set<string>>(() => new Set());
    const [downloadErrors, setDownloadErrors] = useState<Record<string, string>>({});
    const [storedPage, setStoredPage] = useState(0);
    const [onlinePage, setOnlinePage] = useState(0);

    const handleDownload = async (file: FileMetadata) => {
        setDownloading(current => new Set(current).add(file.fileId));
        setDownloadErrors(current => {
            const next = { ...current };
            delete next[file.fileId];
            return next;
        });
        try {
            await onDownload(file);
        } catch (error) {
            const message = error instanceof Error ? error.message : "Please try again.";
            setDownloadErrors(current => ({ ...current, [file.fileId]: `Download failed: ${message}` }));
        } finally {
            setDownloading(current => {
                const next = new Set(current);
                next.delete(file.fileId);
                return next;
            });
        }
    };

    const renderFiles = (entries: FileMetadata[], online: boolean, page: number, setPage: (page: number) => void) => {
        const pageCount = Math.max(1, Math.ceil(entries.length / 50));
        const visiblePage = Math.min(page, pageCount - 1);
        const visibleEntries = entries.slice(visiblePage * 50, (visiblePage + 1) * 50);
        return <>
        <div className="files-list">
            {visibleEntries.map(file => {
                const iconType = getFileIconType(file.mimeType);
                const Icon = fileIcons[iconType as keyof typeof fileIcons] || File;
                const isDownloading = downloading.has(file.fileId);

                return (
                    <article key={`${online ? "online" : "received"}:${file.fileId}`} className="file-item" aria-busy={isDownloading}>
                        <div className="file-icon"><Icon size={24} aria-hidden="true" /></div>
                        <div className="file-info">
                            <span className="file-name" title={file.name}>{file.name}</span>
                            {file.sourceName && <span className="file-source">{online ? "Shared by" : "Received from"} {file.sourceName}</span>}
                            {file.path && <span className="file-path" title={file.path}>{file.path}</span>}
                            <span className="file-size">{formatBytes(file.size)}</span>
                            <span className={`file-storage-badge ${online ? "storage-peer" : file.status === "complete" ? "storage-complete" : "storage-partial"}`}>
                                {online ? "Available on peer" : storageLabel(file)}
                            </span>
                            {downloadErrors[file.fileId] && <span className="download-error" role="alert">{downloadErrors[file.fileId]}</span>}
                        </div>
                        <div className="file-actions">
                            {!online && (
                                <button type="button" onClick={() => void handleDownload(file)} className="btn btn-primary btn-sm" disabled={isDownloading} aria-label={isDownloading ? `Downloading ${file.name}` : `Download ${file.name}`} title={isDownloading ? `Downloading ${file.name}` : `Download ${file.name}`}>
                                    {isDownloading ? <LoaderCircle size={16} className="download-spinner" aria-hidden="true" /> : <Download size={16} aria-hidden="true" />}
                                    <span>{isDownloading ? "Downloading…" : "Download"}</span>
                                </button>
                            )}
                            {isPreviewable(file.mimeType) && (
                                <button type="button" onClick={() => onPreview(file)} className="btn btn-secondary btn-sm" aria-label={`Preview ${file.name}`} title={`Preview ${file.name}`}>
                                    <Eye size={16} aria-hidden="true" /><span>Preview</span>
                                </button>
                            )}
                            {!online && (
                                <button type="button" onClick={() => onDelete(file)} className="btn-icon btn-danger-text" aria-label={`Delete ${file.name}`} title="Delete stored file">
                                    <Trash2 size={16} aria-hidden="true" />
                                </button>
                            )}
                        </div>
                    </article>
                );
            })}
        </div>
        {pageCount > 1 && (
            <div className="file-pagination" aria-label={online ? "Peer file pages" : "Stored file pages"}>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setPage(Math.max(0, visiblePage - 1))} disabled={visiblePage === 0}>Previous</button>
                <span>Page {visiblePage + 1} of {pageCount}</span>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setPage(Math.min(pageCount - 1, visiblePage + 1))} disabled={visiblePage + 1 >= pageCount}>Next</button>
            </div>
        )}
        </>;
    };

    return (
        <section className="received-files glass-card" aria-label="Received and shared files">
            {onlineFiles.length > 0 && (
                <section className="online-peer-files">
                    <div className="section-header">
                        <h3 className="section-title">Available on Peer</h3>
                        <span className="file-size">{onlineFiles.length} {onlineFiles.length === 1 ? "file" : "files"}</span>
                    </div>
                    <p className="received-section-note">These files remain on your peer. Preview opens a temporary stream in your browser.</p>
                    {renderFiles(onlineFiles, true, onlinePage, setOnlinePage)}
                </section>
            )}

            <section className="local-received-files">
                <div className="section-header">
                    <div className="received-section-heading">
                        <h3 className="section-title">Stored on this device</h3>
                        <span className="file-size">{files.length} {files.length === 1 ? "file" : "files"}</span>
                    </div>
                    {files.length > 0 && (
                        <button type="button" onClick={onClearRoom} className="btn-icon btn-danger-text received-clear-room" aria-label="Clear stored files for this room" title="Clear stored files for this room">
                            <Trash2 size={16} aria-hidden="true" />
                            <span>Clear Room</span>
                        </button>
                    )}
                </div>

                {files.length === 0 ? (
                    <div className="empty-state">
                        <CheckCircle2 size={42} className="empty-icon" aria-hidden="true" />
                        <p>No files stored for this room yet</p>
                        <p className="empty-subtext">Files you receive appear here.</p>
                    </div>
                ) : (
                    renderFiles(files, false, storedPage, setStoredPage)
                )}
            </section>
        </section>
    );
}
