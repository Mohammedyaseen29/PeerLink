import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowDown, ArrowUp, Check, CheckCheck, MessageCircle, X } from "lucide-react";
import type { ChatMessage, PeerMember } from "../types";
import { Avatar } from "./Avatar";
import "./chat.css";

interface ChatPanelProps {
    isOpen: boolean;
    onClose: () => void;
    messages: ChatMessage[];
    selfPeerId: string;
    username: string;
    avatar: string;
    onSendMessage: (content: string) => void;
    connected?: boolean;
    roomId?: string;
    members?: Pick<PeerMember, "peerId" | "avatar">[];
}

const messageTime = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const messageDate = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });

function sameDay(left: number, right: number): boolean {
    return new Date(left).toDateString() === new Date(right).toDateString();
}

function dayLabel(timestamp: number): string {
    if (!Number.isFinite(new Date(timestamp).getTime())) return "Messages";
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    if (sameDay(timestamp, today.getTime())) return "Today";
    if (sameDay(timestamp, yesterday.getTime())) return "Yesterday";
    return messageDate.format(timestamp);
}

function groupedWith(message: ChatMessage, adjacent?: ChatMessage): boolean {
    return Boolean(adjacent && adjacent.senderId === message.senderId && sameDay(message.timestamp, adjacent.timestamp)
        && Math.abs(message.timestamp - adjacent.timestamp) < 5 * 60 * 1000);
}

function initials(name: string): string {
    const words = name.trim().split(/[\s_-]+/).filter(Boolean);
    return words.length > 1 ? `${words[0][0]}${words[1][0]}`.toUpperCase() : (words[0]?.slice(0, 2).toUpperCase() || "P");
}

export function ChatPanel({
    isOpen,
    onClose,
    messages,
    selfPeerId,
    username,
    avatar,
    onSendMessage,
    connected = false,
    roomId = "",
    members = [],
}: ChatPanelProps) {
    const [present, setPresent] = useState(isOpen);
    const [inputValue, setInputValue] = useState("");
    const [showLatest, setShowLatest] = useState(false);
    const panelRef = useRef<HTMLElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const viewportRef = useRef<HTMLDivElement>(null);
    const closeButtonRef = useRef<HTMLButtonElement>(null);
    const closeHandler = useRef(onClose);
    const nearBottom = useRef(true);
    const wasOpen = useRef(false);
    const latestMessageId = useRef<string | undefined>(undefined);
    const composing = useRef(false);
    const titleId = useId();
    const hintId = useId();
    closeHandler.current = onClose;

    useEffect(() => {
        if (isOpen) {
            setPresent(true);
            return;
        }
        const timer = window.setTimeout(() => setPresent(false), 220);
        return () => window.clearTimeout(timer);
    }, [isOpen]);

    useEffect(() => {
        if (!isOpen) return;
        const previouslyFocused = document.activeElement;
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        const focusFrame = window.requestAnimationFrame(() => {
            if (textareaRef.current && !textareaRef.current.disabled) textareaRef.current.focus({ preventScroll: true });
            else closeButtonRef.current?.focus({ preventScroll: true });
        });
        const focusableElements = () => Array.from(panelRef.current?.querySelectorAll<HTMLElement>(
            'button:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
        ) ?? []).filter(element => element.getClientRects().length > 0);
        const handleKey = (event: KeyboardEvent) => {
            if (event.isComposing) return;
            if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                closeHandler.current();
            } else if (event.key === "Tab") {
                const elements = focusableElements();
                const first = elements[0];
                const last = elements.at(-1);
                if (!first) {
                    event.preventDefault();
                    panelRef.current?.focus();
                } else if (event.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) {
                    event.preventDefault();
                    last?.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault();
                    first.focus();
                }
            }
        };
        const keepFocusInside = (event: FocusEvent) => {
            if (event.target instanceof Node && !panelRef.current?.contains(event.target)) {
                (focusableElements()[0] ?? panelRef.current)?.focus({ preventScroll: true });
            }
        };
        document.addEventListener("keydown", handleKey, true);
        document.addEventListener("focusin", keepFocusInside);
        return () => {
            window.cancelAnimationFrame(focusFrame);
            document.removeEventListener("keydown", handleKey, true);
            document.removeEventListener("focusin", keepFocusInside);
            document.body.style.overflow = previousOverflow;
            if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) previouslyFocused.focus({ preventScroll: true });
        };
    }, [isOpen]);

    useLayoutEffect(() => {
        const justOpened = isOpen && !wasOpen.current;
        wasOpen.current = isOpen;
        if (!isOpen || !viewportRef.current) return;
        const latest = messages.at(-1);
        const appended = Boolean(latest && latest.id !== latestMessageId.current);
        latestMessageId.current = latest?.id;
        if (justOpened || nearBottom.current || (appended && latest?.senderId === selfPeerId)) {
            viewportRef.current.scrollTo({ top: viewportRef.current.scrollHeight, behavior: "auto" });
            nearBottom.current = true;
            setShowLatest(false);
        } else if (appended) setShowLatest(true);
    }, [isOpen, messages, selfPeerId]);

    useLayoutEffect(() => {
        const input = textareaRef.current;
        if (!input) return;
        input.style.height = "0px";
        input.style.height = `${Math.min(input.scrollHeight, 144)}px`;
        input.style.overflowY = input.scrollHeight > 144 ? "auto" : "hidden";
    }, [inputValue, isOpen]);

    const send = () => {
        if (!connected || !inputValue.trim() || composing.current) return;
        onSendMessage(inputValue.trim());
        setInputValue("");
        nearBottom.current = true;
        textareaRef.current?.focus();
    };

    const jumpToLatest = () => {
        const viewport = viewportRef.current;
        if (!viewport) return;
        const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        viewport.scrollTo({ top: viewport.scrollHeight, behavior: reducedMotion ? "auto" : "smooth" });
        nearBottom.current = true;
        setShowLatest(false);
    };

    if (!present && !isOpen) return null;

    return createPortal(
        <div className="room-chat-layer" data-state={isOpen ? "open" : "closed"}>
            <div className="room-chat-backdrop" aria-hidden="true" onClick={() => closeHandler.current()} />
            <section ref={panelRef} className="room-chat-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-hidden={!isOpen || undefined} inert={!isOpen} tabIndex={-1}>
                <header className="room-chat-header">
                    <div className="room-chat-heading">
                        <div className="room-chat-symbol" aria-hidden="true"><MessageCircle size={22} strokeWidth={1.7} /></div>
                        <div>
                            <h2 id={titleId}>Room chat<span className="room-chat-heading-period">.</span></h2>
                            <p className="room-chat-room">{roomId ? <>ROOM <code title={roomId}>{roomId}</code></> : "YOUR SHARED SPACE"}</p>
                        </div>
                    </div>
                    <button ref={closeButtonRef} type="button" onClick={() => closeHandler.current()} className="room-chat-close" aria-label="Close chat"><X size={20} /></button>
                </header>

                <div className={`room-chat-connection ${connected ? "is-connected" : ""}`} role="status">
                    <span className="room-chat-connection-dot" aria-hidden="true" />
                    <span>{connected ? "Peer connected" : roomId ? "Waiting for your peer" : "Connect to a room to chat"}</span>
                    {connected && <span className="room-chat-connection-detail">Direct to device</span>}
                </div>

                <div className="room-chat-conversation">
                    <div ref={viewportRef} className="room-chat-messages" role="log" aria-label="Room messages" aria-live="polite" aria-relevant="additions text" onScroll={() => {
                        const viewport = viewportRef.current;
                        if (!viewport) return;
                        nearBottom.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 80;
                        if (nearBottom.current) setShowLatest(false);
                    }}>
                        {messages.length === 0 ? (
                            <div className="room-chat-empty">
                                <div className="room-chat-empty-art" aria-hidden="true">
                                    <span className="room-chat-empty-bubble rear"><MessageCircle size={30} strokeWidth={1.4} /></span>
                                    <span className="room-chat-empty-bubble front"><MessageCircle size={32} strokeWidth={1.4} /></span>
                                </div>
                                <span className="room-chat-empty-eyebrow">A LITTLE ROOM TO TALK</span>
                                <h3>{connected ? "Say hello." : roomId ? "Your room is ready." : <>A room for files.<br />And a few words.</>}</h3>
                                <p>{connected ? "Send a note, share a link, or say what’s coming next." : roomId ? "Messages are ready when the other device connects. You can keep this panel open." : "Create or join a room to send messages alongside your files."}</p>
                            </div>
                        ) : messages.map((message, index) => {
                            const own = message.senderId === selfPeerId;
                            const peerAvatar = members.find(member => member.peerId === message.senderId)?.avatar;
                            const previous = messages[index - 1];
                            const next = messages[index + 1];
                            const groupedBefore = groupedWith(message, previous);
                            const groupedAfter = groupedWith(message, next);
                            const newDay = !previous || !sameDay(message.timestamp, previous.timestamp);
                            const timestamp = new Date(message.timestamp);
                            const hasTime = Number.isFinite(timestamp.getTime());
                            const deliveredCount = message.recipientStatuses?.filter(recipient => recipient.status === "delivered").length ?? 0;
                            const recipientCount = message.recipientStatuses?.length ?? 0;
                            const deliveryLabel = recipientCount > 1
                                ? `${deliveredCount} of ${recipientCount} delivered`
                                : message.status === "read" ? "Read" : message.status === "delivered" ? "Delivered" : "Sent";
                            return (
                                <Fragment key={message.id}>
                                    {newDay && <div className="room-chat-date"><span>{dayLabel(message.timestamp)}</span></div>}
                                    <div className={`room-chat-message ${own ? "is-own" : "is-peer"} ${groupedBefore ? "is-grouped-before" : ""} ${groupedAfter ? "is-grouped-after" : ""}`}>
                                        {!own && <span className={`room-chat-peer-avatar ${peerAvatar ? "has-character" : ""} ${groupedAfter ? "is-spacer" : ""}`} aria-hidden="true">{peerAvatar ? <Avatar avatarId={peerAvatar} size="xs" /> : initials(message.senderName || "Peer")}</span>}
                                        <div className="room-chat-message-body">
                                            {!own && !groupedBefore && <span className="room-chat-sender">{message.senderName || "Your peer"}</span>}
                                            <div className="room-chat-bubble">
                                                <p>{message.content}</p>
                                                <div className="room-chat-message-meta">
                                                    <time dateTime={hasTime ? timestamp.toISOString() : undefined} title={hasTime ? timestamp.toLocaleString() : "Time unavailable"}>{hasTime ? messageTime.format(message.timestamp) : "—"}</time>
                                                    {own && <span className={`room-chat-delivery is-${message.status}`} aria-label={deliveryLabel} title={deliveryLabel}>{recipientCount > 1 && <span className="room-chat-delivery-count">{deliveredCount}/{recipientCount}</span>}{message.status === "sent" ? <Check size={13} /> : <CheckCheck size={14} />}</span>}
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                </Fragment>
                            );
                        })}
                    </div>
                    {showLatest && <button type="button" className="room-chat-latest" onClick={jumpToLatest}><ArrowDown size={14} /><span>Latest messages</span></button>}
                </div>

                <footer className="room-chat-footer">
                    {!connected && messages.length > 0 && <p className="room-chat-offline-note">Your peer is offline. Your conversation stays here while this room is open.</p>}
                    <form className={`room-chat-composer ${!connected ? "is-disabled" : ""}`} aria-label={`Chat as ${username}`} onSubmit={event => { event.preventDefault(); send(); }}>
                        <textarea ref={textareaRef} value={inputValue} onChange={event => setInputValue(event.target.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={event => {
                            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && !composing.current && event.keyCode !== 229) {
                                event.preventDefault();
                                send();
                            }
                        }} aria-label="Message your peer" aria-describedby={hintId} placeholder={connected ? "Write a message…" : roomId ? "Waiting for your peer…" : "Connect to a room to chat…"} rows={1} maxLength={500} disabled={!connected} />
                        <button type="submit" className="room-chat-send" disabled={!connected || !inputValue.trim()} aria-label="Send message"><ArrowUp size={20} strokeWidth={2.2} /></button>
                    </form>
                    <div className="room-chat-composer-meta">
                        <span className="room-chat-you"><Avatar avatarId={avatar} size="xs" /><span>You</span></span>
                        <span id={hintId} className="room-chat-hint">{connected ? <>Enter to send <span>·</span> Shift+Enter for a new line</> : "Your draft stays here until you reconnect"}</span>
                        {inputValue.length > 400 && <span className="room-chat-limit">{inputValue.length}/500</span>}
                    </div>
                </footer>
            </section>
        </div>,
        document.body,
    );
}

interface ChatToggleButtonProps {
    unreadCount: number;
    onClick: () => void;
    isOpen?: boolean;
}

export function ChatToggleButton({ unreadCount, onClick, isOpen = false }: ChatToggleButtonProps) {
    return (
        <button type="button" onClick={onClick} className={`chat-toggle-btn room-chat-toggle ${isOpen ? "is-open" : ""}`} aria-label={unreadCount > 0 ? `Open chat, ${unreadCount} unread messages` : "Open chat"} aria-haspopup="dialog" aria-expanded={isOpen}>
            <MessageCircle size={17} strokeWidth={1.8} />
            <span>Chat</span>
            {unreadCount > 0 && <span className="room-chat-unread" aria-hidden="true">{unreadCount > 99 ? "99+" : unreadCount}</span>}
        </button>
    );
}
