import { useState } from "react";
import { Check, ChevronDown, Clock3, File, FileAudio, FileImage, FileText, FileVideo, FolderOpen, HardDrive, LoaderCircle, RefreshCw, Search } from "lucide-react";
import { formatBytes, getFileIconType } from "../utils/helpers";
import type { SavedRoom } from "../utils/savedRooms";
import "./recent-rooms.css";

const icons: Record<string, typeof File> = { image: FileImage, video: FileVideo, audio: FileAudio, text: FileText, pdf: FileText, archive: File, file: File };
function receivedDate(timestamp: number) {
    const now = new Date();
    const received = new Date(timestamp);
    const days = Math.round((Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - Date.UTC(received.getFullYear(), received.getMonth(), received.getDate())) / 86_400_000);
    if (days <= 0) return "Today";
    if (days === 1) return "Yesterday";
    return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", ...(new Date(timestamp).getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) }).format(timestamp);
}

export function RecentRooms({ rooms, loading, error, onRetry, onOpen }: {
    rooms: SavedRoom[]; loading: boolean; error: string | null;
    onRetry: () => void; onOpen: (roomId: string) => void;
}) {
    const [query, setQuery] = useState("");
    const [limit, setLimit] = useState(6);
    const search = query.trim().toLocaleLowerCase();
    const matches = rooms.filter(room => !search || `${room.roomId} ${room.files.map(file => `${file.name} ${file.sourceName || ""}`).join(" ")}`.toLocaleLowerCase().includes(search));
    if (!loading && !error && rooms.length === 0) return null;
    return <section className="recent-rooms" aria-labelledby="recent-rooms-title">
        <div className="recent-rooms-heading">
            <div><span className="recent-eyebrow"><Clock3 size={14} />PICK UP WHERE YOU LEFT OFF</span><h2 id="recent-rooms-title" tabIndex={-1}>Recent rooms<span>{rooms.length || ""}</span></h2><p>Files you received, ready when you are.</p></div>
            <span className="recent-device-note"><HardDrive size={15} />Saved on this device</span>
        </div>
        {error ? <div className="recent-room-message" role="alert"><p>{error}</p><button type="button" onClick={onRetry}><RefreshCw size={16} />Try again</button></div>
            : loading ? <div className="recent-room-message" role="status"><LoaderCircle size={18} className="room-status-spinner" />Loading saved rooms…</div>
            : <>
                {rooms.length > 6 && <label className="recent-room-search"><Search size={17} /><input type="search" aria-label="Search saved rooms" placeholder="Find a room, file or sender…" value={query} onChange={event => { setQuery(event.target.value); setLimit(6); }} /></label>}
                <div className="recent-room-grid">
                    {matches.slice(0, limit).map(room => {
                        const latest = room.files[0];
                        const Icon = icons[getFileIconType(latest.mimeType)] ?? File;
                        return <button type="button" className="recent-room-card" key={room.roomId} onClick={() => onOpen(room.roomId)} aria-label={`Open saved room ${room.roomId}, ${room.files.length} ${room.files.length === 1 ? "file" : "files"}`}>
                            <span className="recent-card-top"><span className="recent-folder"><FolderOpen size={21} /></span><time dateTime={new Date(room.lastReceivedAt).toISOString()} title={new Date(room.lastReceivedAt).toLocaleString()}>{receivedDate(room.lastReceivedAt)}</time></span>
                            <span className="recent-room-name">{room.roomId}</span>
                            <span className="recent-room-stats">{room.files.length} {room.files.length === 1 ? "file" : "files"}<span>·</span>{formatBytes(room.totalSize)}</span>
                            <span className="recent-latest-file"><Icon size={16} /><span>{latest.name}</span>{room.files.length > 1 && <small>+{room.files.length - 1}</small>}</span>
                            <span className="recent-card-bottom"><span><Check size={13} />Received here</span><span className="recent-open-label">Open files</span></span>
                        </button>;
                    })}
                </div>
                {matches.length === 0 && <div className="recent-room-message"><p>No saved rooms match “{query}”.</p><button type="button" onClick={() => setQuery("")}>Clear search</button></div>}
                {matches.length > limit && <button type="button" className="recent-show-more" onClick={() => setLimit(value => value + 6)}><ChevronDown size={16} />Show more rooms <span>{matches.length - limit}</span></button>}
            </>}
    </section>;
}
