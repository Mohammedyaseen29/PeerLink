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

    const handleJoin = () => {
        if (inputValue.trim()) {
            onJoin(inputValue.trim());
        }
    };

    const handleKeyPress = (e: React.KeyboardEvent) => {
        if (e.key === "Enter") {
            handleJoin();
        }
    };

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
                            disabled={connected}
                        />
                    </div>
                    {!connected && (
                        <button onClick={handleJoin} className="btn btn-primary join-btn">
                            <LogIn size={18} />
                            <span>Join</span>
                        </button>
                    )}
                </div>

                <ConnectionIndicator connected={connected} connectionType={connectionType} />
            </div>
        </div>
    );
}
