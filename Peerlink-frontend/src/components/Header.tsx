import { Link2, MessageCircle, Settings } from "lucide-react";
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
        <header className="header room-workspace-header">
            <div className="header-content room-workspace-header-content">
                <div className="logo room-workspace-brand">
                    <div className="logo-icon room-workspace-mark" aria-hidden="true">
                        <Link2 size={20} strokeWidth={2.5} />
                    </div>
                    <h1 className="logo-text room-workspace-wordmark">PeerLink</h1>
                </div>
                
                <div className="header-actions room-workspace-header-actions">
                    {connected && (
                        <button
                            type="button"
                            className="chat-toggle-btn room-workspace-chat-btn"
                            onClick={onChatClick}
                            aria-label={unreadCount > 0 ? `Open chat, ${unreadCount} unread messages` : "Open chat"}
                            title="Chat"
                        >
                            <MessageCircle size={20} aria-hidden="true" />
                            {unreadCount > 0 && <span className="chat-unread-badge">{unreadCount > 9 ? "9+" : unreadCount}</span>}
                        </button>
                    )}
                    
                    <div className="user-info room-workspace-identity">
                        <Avatar avatarId={avatar} size="sm" className="room-workspace-avatar" />
                        <span className="username">{username}</span>
                    </div>
                    
                    <button
                        onClick={onSettingsClick}
                        type="button"
                        className="header-settings-btn room-workspace-settings-btn"
                        aria-label="Open settings"
                        title="Settings"
                    >
                        <Settings size={22} />
                    </button>
                </div>
            </div>
        </header>
    );
}
