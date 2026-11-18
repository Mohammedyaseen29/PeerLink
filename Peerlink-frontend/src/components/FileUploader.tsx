import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Check, File, FolderOpen, Upload, X } from "lucide-react";
import { formatBytes, getFileMimeType } from "../utils/helpers";
import { FileThumbnail } from "./FileThumbnail";
import "./transfer-workspace.css";

interface FileUploaderProps {
    onFilesSelect: (files: File[]) => Promise<boolean>;
    canSend?: boolean;
    disabled?: boolean;
}

type StagedFile = { id: string; file: File };
type EntryFile = FileSystemEntry & { file: (success: (file: File) => void, error?: (error: DOMException) => void) => void };
type EntryDirectory = FileSystemDirectoryEntry & { createReader: () => FileSystemDirectoryReader };
type DropItem = DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntry | null };

const PAGE_SIZE = 50;

function createId() {
    return typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function setRelativePath(file: File, path: string) {
    const relativePath = path.replace(/^\/+/, "");
    if (!relativePath) return file;
    try {
        Object.defineProperty(file, "webkitRelativePath", { configurable: true, value: relativePath });
    } catch {
        // Browsers without an extensible File object can still send the selected file.
    }
    return file;
}

function readEntryFile(entry: EntryFile): Promise<File> {
    return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function readDirectoryBatch(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
    return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

async function collectDroppedEntries(entries: FileSystemEntry[]): Promise<File[]> {
    const files: File[] = [];
    const visit = async (entry: FileSystemEntry, parentPath: string) => {
        const path = parentPath ? `${parentPath}/${entry.name}` : entry.name;
        if (entry.isFile) {
            const file = await readEntryFile(entry as EntryFile);
            files.push(setRelativePath(file, parentPath ? path : ""));
            return;
        }
        if (!entry.isDirectory) return;
        const reader = (entry as EntryDirectory).createReader();
        // readEntries may return only one batch; keep reading until it is empty.
        for (;;) {
            const batch = await readDirectoryBatch(reader);
            if (batch.length === 0) break;
            await Promise.all(batch.map(child => visit(child, path)));
        }
    };
    await Promise.all(entries.map(entry => visit(entry, "")));
    return files;
}

export function FileUploader({ onFilesSelect, canSend = false, disabled = false }: FileUploaderProps) {
    const fileInputRef = useRef<HTMLInputElement>(null);
    const folderInputRef = useRef<HTMLInputElement>(null);
    const dropReadGeneration = useRef(0);
    const supportsFolderPicker = typeof document !== "undefined" && "webkitdirectory" in document.createElement("input");
    const [isDragOver, setIsDragOver] = useState(false);
    const [isReadingDrop, setIsReadingDrop] = useState(false);
    const [staged, setStaged] = useState<StagedFile[]>([]);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
    const [page, setPage] = useState(0);
    const [isSending, setIsSending] = useState(false);
    const [sendError, setSendError] = useState<string | null>(null);

    useEffect(() => () => { dropReadGeneration.current++; }, []);

    const selected = useMemo(() => staged.filter(item => selectedIds.has(item.id)), [staged, selectedIds]);
    const selectedBytes = selected.reduce((total, item) => total + item.file.size, 0);
    const stagedBytes = staged.reduce((total, item) => total + item.file.size, 0);
    const pageCount = Math.max(1, Math.ceil(staged.length / PAGE_SIZE));
    const visiblePage = Math.min(page, pageCount - 1);
    const visibleFiles = staged.slice(visiblePage * PAGE_SIZE, (visiblePage + 1) * PAGE_SIZE);

    const stageFiles = (files: File[]) => {
        if (!files.length) return;
        const additions = files.map(file => ({ id: createId(), file }));
        setStaged(current => [...current, ...additions]);
        setSelectedIds(current => new Set([...current, ...additions.map(item => item.id)]));
        setPage(current => Math.max(current, Math.ceil((staged.length + additions.length) / PAGE_SIZE) - 1));
        setSendError(null);
    };

    const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
        stageFiles(Array.from(event.target.files || []));
        event.target.value = "";
    };

    const handleDragOver = (event: React.DragEvent) => {
        event.preventDefault();
        if (!disabled) setIsDragOver(true);
    };

    const handleDragLeave = (event: React.DragEvent) => {
        event.preventDefault();
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setIsDragOver(false);
    };

    const handleDrop = (event: React.DragEvent) => {
        event.preventDefault();
        setIsDragOver(false);
        if (disabled) return;

        // Snapshot entries before the browser clears the DataTransfer after drop.
        const items = Array.from(event.dataTransfer.items) as DropItem[];
        const entries = items.map(item => item.kind === "file" ? item.webkitGetAsEntry?.() ?? null : null)
            .filter((entry): entry is FileSystemEntry => entry !== null);
        const fallbackFiles = Array.from(event.dataTransfer.files);
        if (entries.length > 0) {
            const generation = ++dropReadGeneration.current;
            setIsReadingDrop(true);
            void collectDroppedEntries(entries).then(files => {
                if (dropReadGeneration.current === generation) stageFiles(files);
            }).catch(() => {
                // Keep ordinary files available even if folder entry reading is unavailable.
                if (dropReadGeneration.current !== generation) return;
                stageFiles(fallbackFiles);
                setSendError("This folder could not be read. Try selecting its files with Select Files.");
            }).finally(() => {
                if (dropReadGeneration.current === generation) setIsReadingDrop(false);
            });
        } else {
            stageFiles(fallbackFiles);
        }
    };

    const toggleFile = (id: string) => {
        setSelectedIds(current => {
            const next = new Set(current);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const selectAll = () => setSelectedIds(new Set(staged.map(item => item.id)));
    const clearSelection = () => setSelectedIds(new Set());
    const removeFile = (id: string) => {
        setStaged(current => current.filter(item => item.id !== id));
        setSelectedIds(current => {
            const next = new Set(current);
            next.delete(id);
            return next;
        });
    };
    const clearAll = () => {
        dropReadGeneration.current++;
        setStaged([]);
        setSelectedIds(new Set());
        setPage(0);
        setIsReadingDrop(false);
        setSendError(null);
    };

    const sendSelected = async () => {
        if (!selected.length || !canSend || disabled || isSending) return;
        const selectedSnapshot = [...selected];
        setIsSending(true);
        setSendError(null);
        try {
            const accepted = await onFilesSelect(selectedSnapshot.map(item => item.file));
            if (!accepted) {
                setSendError("These files were not added to the send queue. They are still selected.");
                return;
            }
            const sentIds = new Set(selectedSnapshot.map(item => item.id));
            setStaged(current => current.filter(item => !sentIds.has(item.id)));
            setSelectedIds(current => new Set([...current].filter(id => !sentIds.has(id))));
            setPage(current => Math.min(current, Math.max(0, Math.ceil((staged.length - sentIds.size) / PAGE_SIZE) - 1)));
        } catch (error) {
            setSendError(error instanceof Error ? error.message : "These files could not be added to the send queue.");
        } finally {
            setIsSending(false);
        }
    };

    return (
        <section className="file-uploader" aria-label="Choose files to send">
            <div
                className={`drop-zone upload-tool ${isDragOver ? "drag-over" : ""} ${disabled ? "disabled" : ""}`}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                aria-disabled={disabled}
            >
                <div className="upload-tool-copy">
                    <span className="upload-tool-mark" aria-hidden="true"><Upload size={19} /></span>
                    <div className="upload-tool-text">
                        <p className="drop-text">Drop files or folders here</p>
                        <p className="drop-subtext">Choose files to stage them. Nothing sends until you press Send.</p>
                        {isReadingDrop && <p className="drop-subtext upload-reading" role="status">Reading dropped folder…</p>}
                    </div>
                </div>

                <div className="upload-buttons">
                    <input ref={fileInputRef} type="file" multiple onChange={handleFileSelect} className="hidden" disabled={disabled} />
                    <button type="button" onClick={() => fileInputRef.current?.click()} className="btn btn-primary upload-select-files" disabled={disabled}>
                        <File size={18} aria-hidden="true" />
                        <span>Select files</span>
                    </button>

                    {supportsFolderPicker ? (
                        <>
                            <input
                                ref={folderInputRef}
                                type="file"
                                multiple
                                webkitdirectory="true"
                                onChange={handleFileSelect}
                                className="hidden"
                                disabled={disabled}
                            />
                            <button type="button" onClick={() => folderInputRef.current?.click()} className="btn btn-secondary upload-select-folder" disabled={disabled}>
                                <FolderOpen size={18} aria-hidden="true" />
                                <span>Select folder</span>
                            </button>
                        </>
                    ) : (
                        <p className="folder-fallback">Folder picker unavailable in this browser.</p>
                    )}
                </div>
            </div>

            {staged.length > 0 && (
                <section className="staged-files glass-card" aria-label="Selected files before sending">
                    <div className="staged-header">
                        <div>
                            <h3 className="section-title">Ready to send</h3>
                            <p className="staged-summary">
                                {selected.length} selected · {formatBytes(selectedBytes)}
                                <span className="staged-total">{staged.length} files total · {formatBytes(stagedBytes)}</span>
                            </p>
                        </div>
                        <div className="staged-toolbar">
                            <button type="button" className="btn btn-secondary btn-sm" onClick={selectAll}>Select all</button>
                            <button type="button" className="btn btn-secondary btn-sm" onClick={clearSelection} disabled={selected.length === 0}>Clear selection</button>
                            <button type="button" className="btn-icon btn-danger-text staged-clear" onClick={clearAll} aria-label="Clear all staged files" title="Clear all staged files">
                                <X size={16} aria-hidden="true" /><span>Clear all</span>
                            </button>
                        </div>
                    </div>

                    <div className="staged-list">
                        {visibleFiles.map(({ id, file }) => {
                            const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
                            return (
                                <div key={id} className="staged-item">
                                    <label className="staged-select" aria-label={`Select ${file.name}`}>
                                        <input type="checkbox" checked={selectedIds.has(id)} onChange={() => toggleFile(id)} />
                                        <span className="staged-checkbox-mark"><Check size={13} aria-hidden="true" /></span>
                                    </label>
                                    <FileThumbnail file={file} />
                                    <div className="file-info staged-file-info">
                                        <span className="file-name" title={file.name}>{file.name}</span>
                                        {relativePath && <span className="file-path" title={relativePath}>{relativePath}</span>}
                                        <span className="file-meta">
                                            <span>{formatBytes(file.size)}</span>
                                            <span className="separator" aria-hidden="true">·</span>
                                            <span>{getFileMimeType(file)}</span>
                                        </span>
                                    </div>
                                    <button type="button" className="btn-icon btn-danger" onClick={() => removeFile(id)} aria-label={`Remove ${file.name}`} title="Remove file">
                                        <X size={17} aria-hidden="true" />
                                    </button>
                                </div>
                            );
                        })}
                    </div>

                    {pageCount > 1 && (
                        <div className="file-pagination" aria-label="Staged file pages">
                            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setPage(Math.max(0, visiblePage - 1))} disabled={visiblePage === 0}>Previous</button>
                            <span>Page {visiblePage + 1} of {pageCount}</span>
                            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setPage(Math.min(pageCount - 1, visiblePage + 1))} disabled={visiblePage + 1 >= pageCount}>Next</button>
                        </div>
                    )}

                    {sendError && <p className="staged-error" role="alert"><AlertCircle size={16} aria-hidden="true" />{sendError}</p>}
                    <div className="staged-send-row">
                        {!canSend && <p className="send-disabled-hint">Connect to your peer to send selected files. You can keep preparing them here.</p>}
                        <button type="button" className="btn btn-primary staged-send" onClick={() => void sendSelected()} disabled={!selected.length || !canSend || disabled || isSending}>
                            <Upload size={17} aria-hidden="true" />
                            <span>{isSending ? "Adding to queue…" : `Send selected${selected.length ? ` (${selected.length})` : ""}`}</span>
                        </button>
                    </div>
                </section>
            )}
        </section>
    );
}
