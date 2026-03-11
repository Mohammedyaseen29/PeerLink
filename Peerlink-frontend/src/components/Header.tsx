import { Link2, Settings } from "lucide-react";
import { ChatToggleButton } from "./ChatPanel";
import { Avatar } from "./Avatar";

interface HeaderProps {
    onSettingsClick: () => void;
    onChatClick: () => void;
    unreadCount: number;
    connected: boolean;
    username: string;
    avatar: string;
}

export function Header({ 
    onSettingsClick, 
    onChatClick, 
    unreadCount, 
    connected,
    username,
    avatar,
}: HeaderProps) {
    return (
        <header className="header">
            <div className="header-content">
                <div className="logo">
                    <div className="logo-icon">
                        <Link2 size={28} strokeWidth={2.5} />
                    </div>
                    <h1 className="logo-text">PeerLink</h1>
                </div>
                <p className="tagline">Secure P2P File Transfer</p>
                
                <div className="header-actions">
                    {connected && (
                        <ChatToggleButton 
                            unreadCount={unreadCount} 
                            onClick={onChatClick} 
                        />
                    )}
                    
                    <div className="user-info">
                        <Avatar avatarId={avatar} size="sm" />
                        <span className="username">{username}</span>
                    </div>
                    
                    <button
                        onClick={onSettingsClick}
                        className="header-settings-btn"
                        title="Settings"
                    >
                        <Settings size={22} />
                    </button>
                </div>
            </div>
        </header>
    );
}
