import { useState } from "react";
import { LogIn, Hash, Clock, Database, Zap, Users, UserPlus, Copy, Check, LogOut, QrCode } from "lucide-react";
import { ConnectionIndicator } from "./ConnectionIndicator";
import { Avatar } from "./Avatar";
import { RoomInviteDialog } from "./RoomInviteDialog";
import { RoomScanDialog } from "./RoomScanDialog";
import { isValidRoomId, parseRoomInvite } from "../utils/roomInvite";
import type { RoomInvite } from "../utils/roomInvite";
import type { ConnectionType, RoomType, SignalingStatus } from "../types";

type RoomMode = "selection" | "create" | "join";

interface RoomConnectionProps {
    roomId: string;
    onRoomIdChange: (roomId: string) => void;
    onJoin: (roomId: string, roomType: RoomType) => void;
    onLeave: () => void;
    connected: boolean;
    inRoom: boolean;
    connectionType: ConnectionType;
    signalingStatus: SignalingStatus;
    roomType: RoomType;
    generateRoomId: () => string;
    avatar: string;
}

export function RoomConnection({
    roomId,
    onRoomIdChange,
    onJoin,
    onLeave,
    connected,
    inRoom,
    connectionType,
    signalingStatus,
    roomType,
    generateRoomId,
    avatar,
}: RoomConnectionProps) {
    const [mode, setMode] = useState<RoomMode>("selection");
    const [inputValue, setInputValue] = useState(roomId);
    const [isWaiting, setIsWaiting] = useState(false);
    const [selectedRoomType, setSelectedRoomType] = useState<RoomType>("persistent");
    const [copiedRoomId, setCopiedRoomId] = useState<string | null>(null);
    const [copyError, setCopyError] = useState(false);
    const [inputError, setInputError] = useState<string | null>(null);
    const [isInviteOpen, setIsInviteOpen] = useState(false);
    const [isScannerOpen, setIsScannerOpen] = useState(false);
    const canShareRoom = isValidRoomId(roomId);

    const handleCopyRoomId = async (id: string) => {
        const value = id.trim();
        if (!value) return;

        try {
            await navigator.clipboard.writeText(value);
            setCopiedRoomId(value);
            setCopyError(false);
        } catch {
            setCopiedRoomId(null);
            setCopyError(true);
        }
    };

    const handleJoin = () => {
        if (isWaiting || connected) return;
        const value = inputValue.trim();
        const invite = mode === "join"
            ? (isValidRoomId(value) ? { roomId: value, roomType: "persistent" as const } : parseRoomInvite(value))
            : (isValidRoomId(value) ? { roomId: value, roomType: selectedRoomType } : null);
        if (!invite) {
            setInputError(mode === "join"
                ? "Enter a valid room ID or paste a PeerLink invite link."
                : "Use letters, numbers, hyphens, and underscores for the room ID.");
            return;
        }
        setInputError(null);
        setInputValue(invite.roomId);
        onRoomIdChange(invite.roomId);
        setIsWaiting(true);
        onJoin(invite.roomId, invite.roomType);
    };

    const handleScannedInvite = (invite: RoomInvite) => {
        if (isWaiting || connected || inRoom) return;
        setInputValue(invite.roomId);
        onRoomIdChange(invite.roomId);
        setInputError(null);
        setIsWaiting(true);
        onJoin(invite.roomId, invite.roomType);
    };

    const handleRoomTypeChange = (type: RoomType) => {
        setSelectedRoomType(type);
        setCopiedRoomId(null);
        setCopyError(false);
        setInputError(null);
        if (type === "temporary") {
            const newRoomId = generateRoomId();
            setInputValue(newRoomId);
            onRoomIdChange(newRoomId);
        } else {
            setInputValue("");
            onRoomIdChange("");
        }
    };

    const handleCreateClick = () => {
        setMode("create");
        setInputError(null);
        if (selectedRoomType === "temporary") {
            const newRoomId = generateRoomId();
            setInputValue(newRoomId);
            onRoomIdChange(newRoomId);
        }
    };

    const handleJoinClick = () => {
        setMode("join");
        setSelectedRoomType("persistent");
        setInputError(null);
    };

    if (connected || inRoom) {
        return (
            <div className="room-connection">
                <div className="glass-card room-card">
                    <div className="room-connected-info">
                        <div className="room-user-info">
                            <Avatar avatarId={avatar} size="sm" />
                            <div className="room-id-display">
                                <span className="room-id-label">Room ID</span>
                                <span className="room-id-value text-sm font-mono text-white">{roomId}</span>
                                <button
                                    type="button"
                                    className="room-id-copy-btn"
                                    onClick={() => void handleCopyRoomId(roomId)}
                                    aria-label={copiedRoomId === roomId ? "Room ID copied" : "Copy room ID"}
                                    title={copiedRoomId === roomId ? "Copied" : "Copy room ID"}
                                >
                                    {copiedRoomId === roomId ? <Check size={16} /> : <Copy size={16} />}
                                </button>
                            </div>
                        </div>
                        
                        <div className={`room-type-badge ${roomType}`}>
                            {roomType === "temporary" ? <Clock size={12} /> : <Database size={12} />}
                            <span>{roomType === "temporary" ? "Temporary" : "Persistent"}</span>
                        </div>

                        {signalingStatus !== "unsupported" && <button
                            type="button"
                            className="room-invite-open-btn"
                            aria-haspopup="dialog"
                            onClick={() => { if (canShareRoom) setIsInviteOpen(true); }}
                            disabled={!canShareRoom}
                            title={canShareRoom ? "Show a QR code to join this room" : "This room ID cannot be shared as an invite link"}
                        >
                            <QrCode size={16} />
                            <span>Show QR</span>
                        </button>}
                    </div>

                    {copyError && <p className="room-copy-error" role="status">Could not copy the room ID. Please select and copy it manually.</p>}

                    <RoomInviteDialog
                        isOpen={isInviteOpen}
                        onClose={() => setIsInviteOpen(false)}
                        roomId={roomId}
                        roomType={roomType}
                    />

                    <div className="room-card-footer">
                        {connected && <ConnectionIndicator connected={connected} connectionType={connectionType} status={signalingStatus} />}
                        <button type="button" className="room-leave-btn" onClick={onLeave}>
                            <LogOut size={15} /><span>{signalingStatus === "unsupported" ? "Close local view" : "Leave room"}</span>
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="room-connection">
            <div className="glass-card room-card">
                {mode === "selection" && (
                    <div className="room-mode-selection">
                        <h3 className="room-mode-title">Start or Join a Room</h3>
                        <div className="room-mode-buttons">
                            <button
                                type="button"
                                onClick={handleCreateClick}
                                className="room-mode-btn create"
                            >
                                <div className="room-mode-icon">
                                    <UserPlus size={24} />
                                </div>
                                <span className="room-mode-label">Create Room</span>
                                <span className="room-mode-desc">Start a new room and invite someone</span>
                            </button>
                            
                            <button
                                type="button"
                                onClick={handleJoinClick}
                                className="room-mode-btn join"
                            >
                                <div className="room-mode-icon">
                                    <LogIn size={24} />
                                </div>
                                <span className="room-mode-label">Join Room</span>
                                <span className="room-mode-desc">Enter a room ID to join</span>
                            </button>
                        </div>
                    </div>
                )}

                {mode === "create" && (
                    <form className="room-create-form" onSubmit={(event) => { event.preventDefault(); handleJoin(); }}>
                        <button
                            type="button"
                            onClick={() => setMode("selection")}
                            className="back-btn"
                        >
                            ← Back
                        </button>
                        
                        <div className="room-type-selector">
                            <span className="room-type-label">Room Type:</span>
                            <div className="room-type-options">
                                <button
                                    type="button"
                                    onClick={() => handleRoomTypeChange("persistent")}
                                    className={`room-type-btn ${selectedRoomType === "persistent" ? "active" : ""}`}
                                    aria-pressed={selectedRoomType === "persistent"}
                                >
                                    <Database size={14} />
                                    <span>Persistent</span>
                                </button>
                                <button
                                    type="button"
                                    onClick={() => handleRoomTypeChange("temporary")}
                                    className={`room-type-btn ${selectedRoomType === "temporary" ? "active" : ""}`}
                                    aria-pressed={selectedRoomType === "temporary"}
                                >
                                    <Zap size={14} />
                                    <span>Temporary</span>
                                </button>
                            </div>
                            <p className="room-type-hint">
                                {selectedRoomType === "persistent" 
                                    ? "Locally stored file copies remain on this device"
                                    : "Received files are removed from this device when you leave"}
                            </p>
                        </div>

                        <div className="input-group room-field-group">
                            <label className="room-field-label" htmlFor="create-room-id">Room ID</label>
                            <div className="input-wrapper">
                                <Hash size={20} className="input-icon" />
                                <input
                                    id="create-room-id"
                                    type="text"
                                    placeholder={selectedRoomType === "temporary" ? "Generated room ID" : "e.g. project-room"}
                                    value={inputValue}
                                    onChange={(e) => {
                                        setInputValue(e.target.value);
                                        onRoomIdChange(e.target.value);
                                        setCopiedRoomId(null);
                                        setCopyError(false);
                                        setInputError(null);
                                    }}
                                    className="room-input room-input-copyable"
                                    disabled={isWaiting}
                                    aria-invalid={Boolean(inputError)}
                                    aria-describedby={inputError ? "create-room-id-error" : undefined}
                                />
                                <button
                                    type="button"
                                    className="room-input-copy-btn"
                                    onClick={() => void handleCopyRoomId(inputValue)}
                                    disabled={!inputValue.trim()}
                                    aria-label={copiedRoomId === inputValue.trim() ? "Room ID copied" : "Copy room ID"}
                                    title={copiedRoomId === inputValue.trim() ? "Copied" : "Copy room ID"}
                                >
                                    {copiedRoomId === inputValue.trim() ? <Check size={16} /> : <Copy size={16} />}
                                    <span>{copiedRoomId === inputValue.trim() ? "Copied" : "Copy"}</span>
                                </button>
                            </div>
                        </div>

                        {inputError && <p id="create-room-id-error" className="room-input-error" role="alert">{inputError}</p>}

                        {copyError && <p className="room-copy-error" role="status">Could not copy the room ID. Please select and copy it manually.</p>}

                        <button 
                            type="submit"
                            className="btn btn-primary join-btn full-width"
                            disabled={isWaiting || !inputValue.trim() || Boolean(inputError)}
                        >
                            <Users size={18} />
                            <span>{isWaiting ? "Creating..." : "Create Room"}</span>
                        </button>

                        {isWaiting && (
                            <p className="waiting-text" role="status">
                                Waiting for the other person to join…
                            </p>
                        )}
                    </form>
                )}

                {mode === "join" && (
                    <form className="room-join-form" onSubmit={(event) => { event.preventDefault(); handleJoin(); }}>
                        <button
                            type="button"
                            onClick={() => setMode("selection")}
                            className="back-btn"
                        >
                            ← Back
                        </button>
                        
                        <div className="input-group room-field-group">
                            <label className="room-field-label" htmlFor="join-room-id">Room ID</label>
                            <div className="input-wrapper">
                                <Hash size={20} className="input-icon" />
                                <input
                                    id="join-room-id"
                                    type="text"
                                    placeholder="Room ID or invite link"
                                    value={inputValue}
                                    onChange={(e) => {
                                        setInputValue(e.target.value);
                                        onRoomIdChange(e.target.value);
                                        setInputError(null);
                                    }}
                                    className="room-input"
                                    disabled={isWaiting}
                                    aria-invalid={Boolean(inputError)}
                                    aria-describedby={inputError ? "join-room-id-error" : undefined}
                                />
                            </div>
                        </div>
                        <p className="room-field-hint">Paste a room ID or a PeerLink invite link.</p>
                        {inputError && <p id="join-room-id-error" className="room-input-error" role="alert">{inputError}</p>}

                        <button
                            type="button"
                            className="room-scan-open-btn"
                            aria-haspopup="dialog"
                            onClick={() => { if (!isWaiting && !connected && !inRoom) setIsScannerOpen(true); }}
                            disabled={isWaiting || connected || inRoom}
                        >
                            <QrCode size={17} />
                            <span>Scan QR</span>
                        </button>

                        <RoomScanDialog
                            isOpen={isScannerOpen}
                            onClose={() => setIsScannerOpen(false)}
                            onScanned={handleScannedInvite}
                        />

                        <button 
                            type="submit"
                            className="btn btn-primary join-btn full-width"
                            disabled={isWaiting || !inputValue.trim() || Boolean(inputError)}
                        >
                            <LogIn size={18} />
                            <span>{isWaiting ? "Joining..." : "Join Room"}</span>
                        </button>

                        {isWaiting && (
                            <p className="waiting-text" role="status">
                                Waiting for the other person to join…
                            </p>
                        )}
                    </form>
                )}

            </div>
        </div>
    );
}
