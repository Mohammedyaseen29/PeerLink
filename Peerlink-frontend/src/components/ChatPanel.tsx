import { useState, useRef, useEffect } from "react";
import { X, Send, MessageCircle, User } from "lucide-react";
import type { ChatMessage } from "../types";
import { formatTime } from "../utils/helpers";

interface ChatPanelProps {
    isOpen: boolean;
    onClose: () => void;
    messages: ChatMessage[];
    username: string;
    onSendMessage: (content: string) => void;
}

export function ChatPanel({
    isOpen,
    onClose,
    messages,
    username,
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
        <div className="fixed bottom-4 right-4 w-80 md:w-96 z-50 flex flex-col bg-[#1a1a2e]/95 backdrop-blur-lg rounded-2xl shadow-2xl border border-white/10 overflow-hidden animate-slide-up md:animate-slide-in max-h-[500px]">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 bg-gradient-to-r from-violet-600 to-indigo-600 shrink-0">
                <div className="flex items-center gap-2">
                    <MessageCircle size={20} className="text-white" />
                    <span className="font-semibold text-white">Chat</span>
                </div>
                <button
                    onClick={onClose}
                    className="p-1.5 hover:bg-white/20 rounded-lg transition-colors"
                >
                    <X size={18} className="text-white" />
                </button>
            </div>

            {/* Messages Area */}
            <div className="flex-1 min-h-[200px] max-h-[320px] overflow-y-auto p-4 space-y-4 scrollbar-thin scrollbar-thumb-white/20 scrollbar-track-transparent">
                {messages.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-full text-white/50 py-8 px-4">
                        <MessageCircle size={48} className="mb-3 opacity-40" />
                        <p className="text-sm font-medium">No messages yet</p>
                        <p className="text-xs mt-1 opacity-60">Start the conversation!</p>
                    </div>
                ) : (
                    messages.map((msg) => {
                        const isOwn = msg.senderId === username;
                        return (
                            <div
                                key={msg.id}
                                className={`flex ${isOwn ? "justify-end" : "justify-start"}`}
                            >
                                <div
                                    className={`max-w-[85%] rounded-2xl px-4 py-3 ${
                                        isOwn
                                            ? "bg-gradient-to-r from-violet-600 to-indigo-600 text-white rounded-br-sm"
                                            : "bg-white/10 text-white rounded-bl-sm"
                                    }`}
                                >
                                    {!isOwn && (
                                        <div className="flex items-center gap-1.5 mb-1.5">
                                            <User size={11} />
                                            <span className="text-xs font-medium text-violet-300">
                                                {msg.senderName}
                                            </span>
                                        </div>
                                    )}
                                    <p className="text-sm break-words leading-relaxed">{msg.content}</p>
                                    <div className="flex items-center justify-end gap-1.5 mt-1.5">
                                        <span className="text-[10px] opacity-50">
                                            {formatTime(Math.floor((Date.now() - msg.timestamp) / 1000))}
                                        </span>
                                        {isOwn && (
                                            <span className="text-[10px] opacity-50">
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

            {/* Input Area */}
            <form onSubmit={handleSubmit} className="p-4 border-t border-white/10 shrink-0 bg-[#1a1a2e]/50">
                <div className="flex items-center gap-3">
                    <input
                        type="text"
                        value={inputValue}
                        onChange={(e) => setInputValue(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder="Type a message..."
                        className="flex-1 px-4 py-2.5 bg-white/10 border border-white/10 rounded-full text-white placeholder-white/40 focus:outline-none focus:border-violet-500 focus:ring-1 focus:ring-violet-500 transition-all text-sm"
                        maxLength={500}
                    />
                    <button
                        type="submit"
                        disabled={!inputValue.trim()}
                        className="p-3 bg-gradient-to-r from-violet-600 to-indigo-600 rounded-full text-white disabled:opacity-40 disabled:cursor-not-allowed hover:scale-105 active:scale-95 transition-all shadow-lg"
                    >
                        <Send size={18} />
                    </button>
                </div>
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
            className="relative p-2 rounded-xl bg-white/10 hover:bg-white/20 transition-colors group"
            title="Chat"
        >
            <MessageCircle size={22} className="text-white group-hover:scale-110 transition-transform" />
            {unreadCount > 0 && (
                <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] flex items-center justify-center bg-red-500 text-white text-xs font-bold rounded-full px-1 animate-pulse">
                    {unreadCount > 9 ? "9+" : unreadCount}
                </span>
            )}
        </button>
    );
}
