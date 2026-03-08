import { Link2, Settings, User } from "lucide-react";
import { ChatToggleButton } from "./ChatPanel";

interface HeaderProps {
    onSettingsClick: () => void;
    onChatClick: () => void;
    unreadCount: number;
    connected: boolean;
    username: string;
}

export function Header({ 
    onSettingsClick, 
    onChatClick, 
    unreadCount, 
    connected,
    username,
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
                    
                    <div className="flex items-center gap-2 px-3 py-1.5 bg-white/5 rounded-lg border border-white/10">
                        <User size={14} className="text-violet-400" />
                        <span className="text-sm text-white/80 max-w-[100px] truncate">
                            {username}
                        </span>
                    </div>
                    
                    <button
                        onClick={onSettingsClick}
                        className="p-2 rounded-xl bg-white/10 hover:bg-white/20 transition-colors"
                        title="Settings"
                    >
                        <Settings size={22} className="text-white" />
                    </button>
                </div>
            </div>
        </header>
    );
}
