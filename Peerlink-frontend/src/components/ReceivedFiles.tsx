import { useMemo, useState } from "react";
import { Archive, Check, ChevronDown, Download, Eye, File, FileAudio, FileImage, FileText, FileVideo, FolderDown, Inbox, LoaderCircle, Search, Trash2, X } from "lucide-react";
import type { FileMetadata } from "../ProgressDB";
import { formatBytes, getFileIconType, isPreviewable } from "../utils/helpers";
import { filesOnlyOnPeer } from "../utils/receivedFiles";
import "./transfer-workspace.css";
import "./received-files.css";

interface ReceivedFilesProps {
    files: FileMetadata[];
    onlineFiles: FileMetadata[];
    onDownload: (file: FileMetadata) => Promise<void>;
    onPreview: (file: FileMetadata) => void | Promise<void>;
    onDelete: (file: FileMetadata) => void;
    onClearRoom: () => void;
    previewFirst?: boolean;
}
const fileIcons = { image: FileImage, video: FileVideo, audio: FileAudio, pdf: FileText, text: FileText, archive: Archive, file: File };
type FileKind = "all" | "image" | "video" | "document" | "other";
function matchesKind(file: FileMetadata, kind: FileKind) {
    const type = getFileIconType(file.mimeType);
    return kind === "all" || (kind === "document" ? type === "pdf" || type === "text"
        : kind === "other" ? !["image", "video", "pdf", "text"].includes(type) : type === kind);
}

export function ReceivedFiles({ files, onlineFiles, onDownload, onPreview, onDelete, onClearRoom, previewFirst = false }: ReceivedFilesProps) {
    const [downloading, setDownloading] = useState<Set<string>>(() => new Set());
    const [previewing, setPreviewing] = useState<string | null>(null);
    const [downloadErrors, setDownloadErrors] = useState<Record<string, string>>({});
    const [tab, setTab] = useState<"received" | "peer" | null>(null);
    const [query, setQuery] = useState("");
    const [kind, setKind] = useState<FileKind>("all");
    const [page, setPage] = useState(0);
    const peerFiles = useMemo(() => filesOnlyOnPeer(files, onlineFiles), [files, onlineFiles]);
    const online = tab === "peer" ? peerFiles.length > 0 : tab === "received" ? false : files.length === 0 && peerFiles.length > 0;
    const entries = online ? peerFiles : files;
    const filtered = useMemo(() => {
        const search = query.trim().toLocaleLowerCase();
        return entries.filter(file => matchesKind(file, kind) && (!search || `${file.name} ${file.path || ""} ${file.sourceName || ""}`.toLocaleLowerCase().includes(search)));
    }, [entries, query, kind]);
    const pageCount = Math.max(1, Math.ceil(filtered.length / 50));
    const visiblePage = Math.min(page, pageCount - 1);
    const visibleEntries = filtered.slice(visiblePage * 50, (visiblePage + 1) * 50);
    const totalSize = entries.reduce((sum, file) => sum + file.size, 0);
    const hasFilters = Boolean(query.trim()) || kind !== "all";
    const handleDownload = async (file: FileMetadata) => {
        if (downloading.has(file.fileId)) return;
        setDownloading(current => new Set(current).add(file.fileId));
        setDownloadErrors(current => { const next = { ...current }; delete next[file.fileId]; return next; });
        try { await onDownload(file); }
        catch (error) { setDownloadErrors(current => ({ ...current, [file.fileId]: `Download failed: ${error instanceof Error ? error.message : "Please try again."}` })); }
        finally { setDownloading(current => { const next = new Set(current); next.delete(file.fileId); return next; }); }
    };
    const selectTab = (next: "received" | "peer") => { setTab(next); setPage(0); setQuery(""); setKind("all"); };

    return <section className={`received-files file-library glass-card${previewFirst ? " library-preview-first" : ""}`} aria-label="Received and shared files">
        <div className="library-header">
            <div className="library-heading"><span className="library-symbol" aria-hidden="true"><FolderDown size={20} /></span><div><h3>Files</h3><p>{entries.length} {entries.length === 1 ? "file" : "files"}{entries.length > 0 && <> <span>·</span> {formatBytes(totalSize)}</>}</p></div></div>
            {!online && files.length > 0 && <button type="button" className="library-clear" onClick={onClearRoom} aria-label="Clear stored files for this room" title="Clear saved copies in this room"><Trash2 size={15} /><span>Clear saved</span></button>}
        </div>
        {peerFiles.length > 0 && <div className="library-tabs" role="group" aria-label="File location">
            <button type="button" aria-pressed={!online} onClick={() => selectTab("received")}>Received <span>{files.length}</span></button>
            <button type="button" aria-pressed={online} onClick={() => selectTab("peer")}>On peer <span>{peerFiles.length}</span></button>
        </div>}
        <p className="library-description">{online ? "Preview files that haven’t arrived yet. Your peer must stay connected." : "Saved on this device. Ready to preview or download."}</p>
        {(entries.length > 5 || hasFilters) && <div className="library-toolbar">
            <label className="library-search"><Search size={16} aria-hidden="true" /><input type="search" aria-label="Search files" placeholder="Find a file…" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} /></label>
            <label className="library-type"><select aria-label="Filter file type" value={kind} onChange={event => { setKind(event.target.value as FileKind); setPage(0); }}><option value="all">All types</option><option value="image">Images</option><option value="video">Videos</option><option value="document">Documents</option><option value="other">Other</option></select><ChevronDown size={14} aria-hidden="true" /></label>
        </div>}
        <section className={online ? "online-peer-files" : "local-received-files"} aria-label={online ? "Files available from your peer" : "Received files saved on this device"}>
            {filtered.length === 0 ? <div className="library-empty">
                {hasFilters ? <Search size={27} aria-hidden="true" /> : <Inbox size={28} aria-hidden="true" />}
                <strong>{hasFilters ? "No matching files" : "Your next handoff lands here."}</strong>
                <p>{hasFilters ? "Try another name or file type." : "Received files will appear here, ready to open or save."}</p>
                {hasFilters && <button type="button" className="library-reset" onClick={() => { setQuery(""); setKind("all"); setPage(0); }}><X size={14} />Clear filters</button>}
            </div> : <div className="files-list">
                {visibleEntries.map(file => {
                    const type = getFileIconType(file.mimeType) as keyof typeof fileIcons;
                    const Icon = fileIcons[type] || File;
                    const isDownloading = downloading.has(file.fileId);
                    const complete = file.status === "complete" && file.receivedChunks === file.totalChunks;
                    const downloadAction = !online && <button type="button" className="library-action library-download" disabled={isDownloading || !complete} onClick={() => void handleDownload(file)} aria-label={isDownloading ? `Downloading ${file.name}` : `Download ${file.name}`} title="Download">{isDownloading ? <LoaderCircle size={17} className="download-spinner" /> : <Download size={17} />}<span className="library-download-label">{isDownloading ? "Saving…" : "Download"}</span></button>;
                    const previewAction = isPreviewable(file.mimeType) && <button type="button" className="library-action library-preview" disabled={previewing === file.fileId || (!online && !complete)} onClick={async () => {
                        setPreviewing(file.fileId);
                        try { await onPreview(file); }
                        catch (error) { setDownloadErrors(current => ({ ...current, [file.fileId]: `Preview failed: ${error instanceof Error ? error.message : "Please try again."}` })); }
                        finally { setPreviewing(null); }
                    }} aria-label={`Preview ${file.name}`} title={previewFirst ? "Open file" : "Preview"}>{previewing === file.fileId ? <LoaderCircle size={17} className="download-spinner" /> : <Eye size={17} />}<span className="library-preview-label">{previewFirst ? "Open" : "Preview"}</span></button>;
                    return <article key={`${online ? "peer" : "local"}:${file.fileId}`} className="file-item" aria-busy={isDownloading || previewing === file.fileId}>
                        <div className={`file-icon library-icon-${type}`} aria-hidden="true"><Icon size={21} /></div>
                        <div className="file-info">
                            <span className="file-name" title={file.name}>{file.name}</span>
                            <div className="library-file-meta"><span>{formatBytes(file.size)}</span>{file.sourceName && <><span aria-hidden="true">·</span><span className="file-source" title={file.sourceName}>{online ? "From" : "Received from"} {file.sourceName}</span></>}</div>
                            {file.path && <span className="file-path" title={file.path}>{file.path}</span>}
                            <span className={`file-storage-badge ${online ? "storage-peer" : complete ? "storage-complete" : "storage-partial"}`}>{online ? "On peer · not saved here" : complete ? <><Check size={12} />Saved here</> : "Partially received"}</span>
                        </div>
                        <div className="file-actions">
                            {previewFirst ? <>{previewAction}{downloadAction}</> : <>{downloadAction}{previewAction}</>}
                            {!online && <button type="button" className="library-action library-delete" onClick={() => onDelete(file)} aria-label={`Delete ${file.name}`} title="Delete saved copy"><Trash2 size={16} /></button>}
                        </div>
                        {downloadErrors[file.fileId] && <p className="download-error" role="alert">{downloadErrors[file.fileId]}</p>}
                    </article>;
                })}
            </div>}
            {pageCount > 1 && <div className="file-pagination" aria-label={online ? "Peer file pages" : "Stored file pages"}>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setPage(Math.max(0, visiblePage - 1))} disabled={visiblePage === 0}>Previous</button>
                <span>Page {visiblePage + 1} of {pageCount}</span>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setPage(Math.min(pageCount - 1, visiblePage + 1))} disabled={visiblePage + 1 >= pageCount}>Next</button>
            </div>}
            {filtered.length > 0 && <div className="library-list-note"><span>{hasFilters ? `${filtered.length} matching ${filtered.length === 1 ? "file" : "files"}` : online ? "Available while your peer is connected" : "Stored on this device"}</span>{filtered.length > 50 && <span>{visiblePage * 50 + 1}–{Math.min((visiblePage + 1) * 50, filtered.length)} of {filtered.length}</span>}</div>}
        </section>
    </section>;
}
