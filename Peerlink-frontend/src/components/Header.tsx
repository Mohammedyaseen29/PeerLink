import { Settings } from "lucide-react";
import { ChatToggleButton } from "./ChatPanel";
import { Avatar } from "./Avatar";
import { BrandMark } from "./BrandMark";

interface HeaderProps {
    onSettingsClick: () => void;
    onChatClick: () => void;
    unreadCount: number;
    connected: boolean;
    username: string;
    avatar: string;
    isChatOpen?: boolean;
}

export function Header({ onSettingsClick, onChatClick, unreadCount, connected, username, avatar, isChatOpen }: HeaderProps) {
    return (
        <header className="app-header">
            <a className="logo" href="/" aria-label="PeerLink home">
                <BrandMark className="logo-symbol" />
                <span className="brand-wordmark">PeerLink<span className="wordmark-period">.</span></span>
            </a>
            <nav className="header-nav" aria-label="Workspace">
                <a href="#transfer-workspace" className="nav-link active" aria-current="page">Transfer</a>
                <ChatToggleButton unreadCount={unreadCount} onClick={onChatClick} isOpen={isChatOpen} />
            </nav>
            <div className="header-account">
                <span className={`header-connection ${connected ? "is-connected" : ""}`}>
                    <span aria-hidden="true" />{connected ? "Peer connected" : "Your space"}
                </span>
                <div className="user-info">
                    <Avatar avatarId={avatar} size="sm" />
                    <span className="username">{username}</span>
                </div>
                <button onClick={onSettingsClick} className="header-settings-btn" title="Settings" aria-label="Open settings">
                    <Settings size={18} />
                </button>
            </div>
        </header>
    );
}
