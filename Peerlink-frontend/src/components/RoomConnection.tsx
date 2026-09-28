import { useState } from "react";
import { LogIn, Hash, Clock, Database, Zap, Users, UserPlus, Copy, Check, LogOut } from "lucide-react";
import { ConnectionIndicator } from "./ConnectionIndicator";
import { Avatar } from "./Avatar";
import type { ConnectionType, RoomType } from "../types";

type RoomMode = "selection" | "create" | "join";

interface RoomConnectionProps {
    roomId: string;
    onRoomIdChange: (roomId: string) => void;
    onJoin: (roomId: string, roomType: RoomType) => void;
    onLeave: () => void;
    connected: boolean;
    inRoom: boolean;
    connectionType: ConnectionType;
    signalingStatus: "idle" | "connecting" | "waiting" | "negotiating" | "offline";
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
        if (inputValue.trim() && !isWaiting && !connected) {
            setIsWaiting(true);
            const roomTypeToUse = mode === "join" ? "persistent" : selectedRoomType;
            onJoin(inputValue.trim(), roomTypeToUse);
        }
    };

    const handleKeyPress = (e: React.KeyboardEvent) => {
        if (e.key === "Enter" && !isWaiting && !connected) {
            handleJoin();
        }
    };

    const handleRoomTypeChange = (type: RoomType) => {
        setSelectedRoomType(type);
        setCopiedRoomId(null);
        setCopyError(false);
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
        if (selectedRoomType === "temporary") {
            const newRoomId = generateRoomId();
            setInputValue(newRoomId);
            onRoomIdChange(newRoomId);
        }
    };

    const handleJoinClick = () => {
        setMode("join");
        setSelectedRoomType("persistent");
    };

    if (connected || inRoom) {
        return (
            <div className="room-connection">
                <div className="glass-card room-card">
                    <div className="room-connected-info">
                        <div className="room-user-info">
                            <Avatar avatarId={avatar} size="sm" />
                            <div className="room-id-display">
                                <span className="text-sm text-gray-400">Room: </span>
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
                    </div>

                    {copyError && <p className="room-copy-error" role="status">Could not copy the room ID. Please select and copy it manually.</p>}

                    <div className="room-card-footer">
                        <ConnectionIndicator connected={connected} connectionType={connectionType} status={signalingStatus} />
                        <button type="button" className="room-leave-btn" onClick={onLeave}>
                            <LogOut size={15} /><span>Leave room</span>
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
                    <div className="room-create-form">
                        <button
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
                                >
                                    <Database size={14} />
                                    <span>Persistent</span>
                                </button>
                                <button
                                    type="button"
                                    onClick={() => handleRoomTypeChange("temporary")}
                                    className={`room-type-btn ${selectedRoomType === "temporary" ? "active" : ""}`}
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

                        <div className="input-group">
                            <div className="input-wrapper">
                                <Hash size={20} className="input-icon" />
                                <input
                                    type="text"
                                    placeholder={selectedRoomType === "temporary" ? "Auto-generated room ID" : "Enter Room ID"}
                                    value={inputValue}
                                    onChange={(e) => {
                                        setInputValue(e.target.value);
                                        onRoomIdChange(e.target.value);
                                        setCopiedRoomId(null);
                                        setCopyError(false);
                                    }}
                                    onKeyPress={handleKeyPress}
                                    className="room-input room-input-copyable"
                                    disabled={isWaiting}
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

                        {copyError && <p className="room-copy-error" role="status">Could not copy the room ID. Please select and copy it manually.</p>}

                        <button 
                            onClick={handleJoin}
                            className="btn btn-primary join-btn full-width"
                            disabled={isWaiting || !inputValue.trim()}
                        >
                            <Users size={18} />
                            <span>{isWaiting ? "Creating..." : "Create Room"}</span>
                        </button>

                        {isWaiting && (
                            <p className="waiting-text">
                                Waiting for other peer to connect...
                            </p>
                        )}
                    </div>
                )}

                {mode === "join" && (
                    <div className="room-join-form">
                        <button
                            onClick={() => setMode("selection")}
                            className="back-btn"
                        >
                            ← Back
                        </button>
                        
                        <div className="input-group">
                            <div className="input-wrapper">
                                <Hash size={20} className="input-icon" />
                                <input
                                    type="text"
                                    placeholder="Paste Room ID here"
                                    value={inputValue}
                                    onChange={(e) => {
                                        setInputValue(e.target.value);
                                        onRoomIdChange(e.target.value);
                                    }}
                                    onKeyPress={handleKeyPress}
                                    className="room-input"
                                    disabled={isWaiting}
                                />
                            </div>
                        </div>

                        <button 
                            onClick={handleJoin}
                            className="btn btn-primary join-btn full-width"
                            disabled={isWaiting || !inputValue.trim()}
                        >
                            <LogIn size={18} />
                            <span>{isWaiting ? "Joining..." : "Join Room"}</span>
                        </button>

                        {isWaiting && (
                            <p className="waiting-text">
                                Waiting for peer to accept...
                            </p>
                        )}
                    </div>
                )}

                <ConnectionIndicator connected={connected} connectionType={connectionType} />
            </div>
        </div>
    );
}
