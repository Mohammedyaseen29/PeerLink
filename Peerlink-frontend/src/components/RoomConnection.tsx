import { useState } from "react";
import { LogIn, Hash } from "lucide-react";
import { ConnectionIndicator } from "./ConnectionIndicator";
import type { ConnectionType } from "../types";

interface RoomConnectionProps {
    roomId: string;
    onRoomIdChange: (roomId: string) => void;
    onJoin: (roomId: string) => void;
    connected: boolean;
    connectionType: ConnectionType;
}

export function RoomConnection({
    roomId,
    onRoomIdChange,
    onJoin,
    connected,
    connectionType,
}: RoomConnectionProps) {
    const [inputValue, setInputValue] = useState(roomId);
    const [isWaiting, setIsWaiting] = useState(false);

    const handleJoin = () => {
        if (inputValue.trim() && !isWaiting && !connected) {
            setIsWaiting(true);
            onJoin(inputValue.trim());
        }
    };

    const handleKeyPress = (e: React.KeyboardEvent) => {
        if (e.key === "Enter" && !isWaiting && !connected) {
            handleJoin();
        }
    };

    // Reset waiting state when connected
    if (connected && isWaiting) {
        setIsWaiting(false);
    }

    return (
        <div className="room-connection">
            <div className="glass-card room-card">
                <div className="input-group">
                    <div className="input-wrapper">
                        <Hash size={20} className="input-icon" />
                        <input
                            type="text"
                            placeholder="Enter Room ID"
                            value={inputValue}
                            onChange={(e) => {
                                setInputValue(e.target.value);
                                onRoomIdChange(e.target.value);
                            }}
                            onKeyPress={handleKeyPress}
                            className="room-input"
                            disabled={connected || isWaiting}
                        />
                    </div>
                    {!connected && (
                        <button 
                            onClick={handleJoin} 
                            className="btn btn-primary join-btn"
                            disabled={isWaiting || !inputValue.trim()}
                        >
                            <LogIn size={18} />
                            <span>{isWaiting ? "Joining..." : "Join"}</span>
                        </button>
                    )}
                </div>

                {isWaiting && !connected && (
                    <p style={{ 
                        color: 'var(--text-secondary)', 
                        fontSize: '0.875rem', 
                        marginTop: '0.5rem',
                        textAlign: 'center'
                    }}>
                        Waiting for other peer to connect...
                    </p>
                )}

                <ConnectionIndicator connected={connected} connectionType={connectionType} />
            </div>
        </div>
    );
}