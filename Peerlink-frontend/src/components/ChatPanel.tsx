import { useState, useRef, useEffect } from "react";
import { X, Send, MessageCircle, User } from "lucide-react";
import type { ChatMessage } from "../types";
import { formatTime } from "../utils/helpers";
import { Avatar } from "./Avatar";

interface ChatPanelProps {
    isOpen: boolean;
    onClose: () => void;
    messages: ChatMessage[];
    username: string;
    avatar: string;
    onSendMessage: (content: string) => void;
}

export function ChatPanel({
    isOpen,
    onClose,
    messages,
    username,
    avatar: userAvatar,
    onSendMessage,
}: ChatPanelProps) {
    const [inputValue, setInputValue] = useState("");
    const messagesEndRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages]);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (inputValue.trim()) {
            onSendMessage(inputValue);
            setInputValue("");
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleSubmit(e);
        }
    };

    if (!isOpen) return null;

    return (
        <div className="chat-panel">
            <div className="chat-panel-header">
                <div className="chat-panel-title">
                    <MessageCircle size={20} />
                    <span>Chat</span>
                </div>
                <button
                    onClick={onClose}
                    className="chat-panel-close"
                >
                    <X size={18} />
                </button>
            </div>

            <div className="chat-panel-messages">
                {messages.length === 0 ? (
                    <div className="chat-panel-empty">
                        <MessageCircle size={48} className="chat-panel-empty-icon" />
                        <p className="chat-panel-empty-title">No messages yet</p>
                        <p className="chat-panel-empty-desc">Start the conversation!</p>
                    </div>
                ) : (
                    messages.map((msg) => {
                        const isOwn = msg.senderId === username;
                        return (
                            <div
                                key={msg.id}
                                className={`chat-message ${isOwn ? "own" : "other"}`}
                            >
                                {!isOwn && (
                                    <div className="chat-message-avatar">
                                        <div className="chat-message-default-avatar">
                                            <User size={12} />
                                        </div>
                                    </div>
                                )}
                                <div className="chat-message-bubble">
                                    {!isOwn && (
                                        <div className="chat-message-sender">
                                            {msg.senderName}
                                        </div>
                                    )}
                                    <p className="chat-message-content">{msg.content}</p>
                                    <div className="chat-message-time">
                                        <span>{formatTime(Math.floor((Date.now() - msg.timestamp) / 1000))}</span>
                                        {isOwn && (
                                            <span className="chat-message-status">
                                                {msg.status === "sent" ? "✓" : "✓✓"}
                                            </span>
                                        )}
                                    </div>
                                </div>
                            </div>
                        );
                    })
                )}
                <div ref={messagesEndRef} />
            </div>

            <form onSubmit={handleSubmit} className="chat-panel-input">
                <Avatar avatarId={userAvatar} size="xs" />
                <input
                    type="text"
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Type a message..."
                    className="chat-panel-text-input"
                    maxLength={500}
                />
                <button
                    type="submit"
                    disabled={!inputValue.trim()}
                    className="chat-panel-send-btn"
                >
                    <Send size={18} />
                </button>
            </form>
        </div>
    );
}

interface ChatToggleButtonProps {
    unreadCount: number;
    onClick: () => void;
}

export function ChatToggleButton({ unreadCount, onClick }: ChatToggleButtonProps) {
    return (
        <button
            onClick={onClick}
            className="chat-toggle-btn"
            title="Chat"
        >
            <MessageCircle size={22} />
            {unreadCount > 0 && (
                <span className="chat-unread-badge">
                    {unreadCount > 9 ? "9+" : unreadCount}
                </span>
            )}
        </button>
    );
}
