import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Archive, Check, Copy, Hash, Link, LoaderCircle, LogIn, LogOut, Plus, QrCode, RefreshCw, ScanLine, ShieldCheck, Timer } from "lucide-react";
import { ConnectionIndicator } from "./ConnectionIndicator";
import { RoomInviteDialog } from "./RoomInviteDialog";
import { RoomScanDialog } from "./RoomScanDialog";
import { buildRoomInviteUrl, isValidRoomId, parseRoomInvite, type RoomInvite } from "../utils/roomInvite";
import type { ConnectionType, RoomType, SignalingStatus } from "../types";
import "./room.css";

type RoomMode = "create" | "join";

interface RoomConnectionProps {
    roomId: string;
    onRoomIdChange: (roomId: string) => void;
    onJoin: (roomId: string, roomType: RoomType) => void;
    connected: boolean;
    inRoom: boolean;
    connectionType: ConnectionType;
    roomType: RoomType;
    generateRoomId: () => string;
    avatar: string;
    signalingStatus: SignalingStatus;
    onLeave: () => void;
    onReconnect?: () => void;
}

export function RoomConnection({
    roomId, onRoomIdChange, onJoin, connected, inRoom, connectionType,
    roomType, generateRoomId, signalingStatus, onLeave, onReconnect,
}: RoomConnectionProps) {
    const [mode, setMode] = useState<RoomMode>("create");
    const [inputValue, setInputValue] = useState(roomId);
    const [isWaiting, setIsWaiting] = useState(false);
    const [selectedType, setSelectedType] = useState<RoomType>("persistent");
    const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
    const [linkCopied, setLinkCopied] = useState(false);
    const [inputError, setInputError] = useState<string | null>(null);
    const [isInviteOpen, setIsInviteOpen] = useState(false);
    const [isScannerOpen, setIsScannerOpen] = useState(false);
    const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const createTab = useRef<HTMLButtonElement>(null);
    const joinTab = useRef<HTMLButtonElement>(null);

    useEffect(() => () => {
        if (copyTimer.current) clearTimeout(copyTimer.current);
    }, []);

    const updateCode = (code: string) => {
        setInputValue(code);
        onRoomIdChange(code);
        setInputError(null);
        setCopyState("idle");
    };

    const chooseRoomType = (type: RoomType) => {
        setSelectedType(type);
        if (type === "temporary") updateCode(generateRoomId());
        else updateCode("");
    };

    const handleJoin = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (isWaiting || connected) return;
        const code = inputValue.trim() || (mode === "create" ? generateRoomId() : "");
        const invite = mode === "join"
            ? (isValidRoomId(code) ? { roomId: code, roomType: "persistent" as const } : parseRoomInvite(code))
            : (isValidRoomId(code) ? { roomId: code, roomType: selectedType } : null);
        if (!invite) {
            setInputError(mode === "join"
                ? "Enter a valid room code or paste a PeerLink invite link."
                : "Use letters, numbers, dashes and underscores for the room name.");
            return;
        }
        updateCode(invite.roomId);
        setIsWaiting(true);
        onJoin(invite.roomId, invite.roomType);
    };

    const handleScannedInvite = (invite: RoomInvite) => {
        if (isWaiting || connected || inRoom) return;
        updateCode(invite.roomId);
        setIsWaiting(true);
        onJoin(invite.roomId, invite.roomType);
    };

    const selectMode = (nextMode: RoomMode) => {
        setMode(nextMode);
        setInputError(null);
    };

    const handleTabKeys = (event: KeyboardEvent<HTMLDivElement>) => {
        if (isWaiting) return;
        let nextMode: RoomMode;
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") nextMode = mode === "create" ? "join" : "create";
        else if (event.key === "Home") nextMode = "create";
        else if (event.key === "End") nextMode = "join";
        else return;
        event.preventDefault();
        selectMode(nextMode);
        (nextMode === "create" ? createTab : joinTab).current?.focus();
    };

    const copyRoom = async (value = roomId) => {
        setLinkCopied(false);
        try {
            await navigator.clipboard.writeText(value.trim());
            setCopyState("copied");
        } catch {
            setCopyState("failed");
        }
        if (copyTimer.current) clearTimeout(copyTimer.current);
        copyTimer.current = setTimeout(() => setCopyState("idle"), 2500);
    };

    const copyInviteLink = async () => {
        const url = buildRoomInviteUrl(roomId, roomType);
        if (!url) return;
        setLinkCopied(false);
        try {
            await navigator.clipboard.writeText(url);
            setLinkCopied(true);
            setCopyState("idle");
        } catch {
            setIsInviteOpen(true);
        }
        if (copyTimer.current) clearTimeout(copyTimer.current);
        copyTimer.current = setTimeout(() => setLinkCopied(false), 2500);
    };

    const roomOpen = inRoom || connected;
    const reconnecting = String(signalingStatus) === "reconnecting" || (roomOpen && signalingStatus === "offline");
    const state = connected ? "connected" : signalingStatus === "idle" && isWaiting ? "connecting" : signalingStatus;
    const statusLabels: Record<string, string> = {
        idle: "Not connected", connecting: "Connecting", waiting: "Waiting for device",
        connected: "Connected", reconnecting: "Reconnecting", negotiating: "Connecting devices",
        unreachable: "Could not connect", offline: "Room offline", full: "Room full", unsupported: "Local files only",
    };
    const statusLabel = statusLabels[state] || "Connecting";
    const canInvite = signalingStatus !== "unsupported" && isValidRoomId(roomId);
    const roomTitle = connected ? "You’re connected."
        : signalingStatus === "full" ? "This room is full."
            : signalingStatus === "unsupported" ? "Your local files."
                : signalingStatus === "offline" ? "Your room is offline." : "Your room is open.";
    const roomDescription = connected ? "Both devices are ready to share files."
        : signalingStatus === "full" ? "Two devices are already here. Your saved files are still available."
            : signalingStatus === "unsupported" ? "Open saved files here. Use a supported browser to connect."
                : signalingStatus === "offline" ? "Saved files are here. Reconnect when you’re ready."
                    : "Enter this code on your other device to connect.";

    return (
        <section className={`connect-card ${roomOpen ? "connect-card-active" : "connect-card-setup"}`} aria-labelledby="connect-card-title" data-state={state}>
            <div className="connect-card-topline">
                <span className="connect-card-label">Room</span>
                <span className="connect-card-state" role="status">
                    <span className="connect-card-state-dot" aria-hidden="true" />
                    {statusLabel}
                </span>
            </div>

            {roomOpen ? (
                <div className="connect-card-session connect-card-reveal">
                    <div className="connect-card-intro">
                        <h2 id="connect-card-title">{roomTitle}</h2>
                        <p>{roomDescription}</p>
                    </div>
                    <span className="connect-session-type">
                        {roomType === "temporary" ? <Timer size={14} /> : <Archive size={14} />}
                        {roomType === "temporary" ? "Temporary room" : "Persistent room"}
                    </span>

                    <div className="connect-code-surface">
                        <div className="connect-code-topline">
                            <span className="connect-code-label">Room code</span>
                            <button type="button" className={`connect-copy-button ${copyState === "copied" ? "is-copied" : ""}`} onClick={() => void copyRoom()} aria-label="Copy room code">
                                {copyState === "copied" ? <Check size={15} /> : <Copy size={15} />}
                                <span>{copyState === "copied" ? "Copied" : "Copy"}</span>
                            </button>
                        </div>
                        <code className="connect-room-code" tabIndex={0}>{roomId}</code>
                    </div>

                    {copyState === "failed" && <p className="connect-copy-error" role="status">Select the code above to copy it.</p>}

                    {signalingStatus !== "unsupported" && (
                        <div className="connect-invite-actions" role="group" aria-label="Share room invitation">
                            <button type="button" onClick={() => setIsInviteOpen(true)} disabled={!canInvite} aria-haspopup="dialog">
                                <QrCode size={16} />
                                Show QR
                            </button>
                            <button type="button" onClick={() => void copyInviteLink()} disabled={!canInvite}>
                                {linkCopied ? <Check size={15} /> : <Link size={15} />}
                                {linkCopied ? "Copied" : "Copy link"}
                            </button>
                        </div>
                    )}

                    <div className="connect-session-details" aria-live="polite">
                        <ConnectionIndicator connected={connected} connectionType={connectionType} status={signalingStatus} />
                        <p>
                            {reconnecting && connected ? "Your file connection stays active while the room reconnects."
                                : reconnecting ? "Restoring the room connection…"
                                    : roomType === "temporary" ? "Files clear from this device when you leave."
                                        : "Received files stay on this device."}
                        </p>
                    </div>
                    <div className="connect-session-actions">
                        {!connected && onReconnect && signalingStatus !== "unsupported" && (
                            <button type="button" className="btn btn-secondary connect-retry" onClick={onReconnect}>
                                <RefreshCw size={15} />
                                Retry connection
                            </button>
                        )}
                        <button type="button" className="connect-leave-button" onClick={onLeave}>
                            <LogOut size={15} />
                            {signalingStatus === "unsupported" ? "Close local view" : "Leave room"}
                        </button>
                    </div>
                </div>
            ) : (
                <>
                    <div className="connect-card-intro">
                        <h2 id="connect-card-title">Start with a room.</h2>
                        <p>One code connects both devices.</p>
                    </div>
                    <div className="connect-tabs" role="tablist" aria-label="Room action" data-mode={mode} onKeyDown={handleTabKeys}>
                        <span className="connect-tab-slider" aria-hidden="true" />
                        <button ref={createTab} id="create-room-tab" type="button" role="tab" aria-selected={mode === "create"} aria-controls="room-form-panel" tabIndex={mode === "create" ? 0 : -1} onClick={() => selectMode("create")} disabled={isWaiting}>
                            Create room
                        </button>
                        <button ref={joinTab} id="join-room-tab" type="button" role="tab" aria-selected={mode === "join"} aria-controls="room-form-panel" tabIndex={mode === "join" ? 0 : -1} onClick={() => selectMode("join")} disabled={isWaiting}>
                            Join room
                        </button>
                    </div>

                    <form id="room-form-panel" className="connect-room-form" role="tabpanel" aria-labelledby={mode === "create" ? "create-room-tab" : "join-room-tab"} aria-busy={isWaiting} onSubmit={handleJoin}>
                        <div className="connect-form-content connect-card-reveal" key={mode}>
                            {mode === "create" && (
                                <fieldset className="connect-room-types" disabled={isWaiting}>
                                    <legend>Room type</legend>
                                    <div className="connect-type-options">
                                        <label className="connect-type-option">
                                            <input type="radio" name="room-type" value="persistent" checked={selectedType === "persistent"} onChange={() => chooseRoomType("persistent")} />
                                            <span className="connect-type-surface">
                                                <Archive size={16} />
                                                <span className="connect-type-name">Persistent</span>
                                                <span className="connect-type-note">Keep local files</span>
                                                <Check size={12} className="connect-type-check" />
                                            </span>
                                        </label>
                                        <label className="connect-type-option">
                                            <input type="radio" name="room-type" value="temporary" checked={selectedType === "temporary"} onChange={() => chooseRoomType("temporary")} />
                                            <span className="connect-type-surface">
                                                <Timer size={16} />
                                                <span className="connect-type-name">Temporary</span>
                                                <span className="connect-type-note">Just this session</span>
                                                <Check size={12} className="connect-type-check" />
                                            </span>
                                        </label>
                                    </div>
                                    <p className="connect-type-description">
                                        {selectedType === "persistent" ? "Local copies stay available when you return." : "Received files clear from this device when you leave."}
                                    </p>
                                </fieldset>
                            )}

                            <label htmlFor="room-code" className="field-label">
                                {mode === "create" && selectedType === "persistent" ? "Room name" : "Room code"}
                                {mode === "create" && selectedType === "persistent" && <span className="connect-optional">Optional</span>}
                                {mode === "create" && selectedType === "temporary" && (
                                    <button type="button" className="connect-regenerate" onClick={() => updateCode(generateRoomId())} disabled={isWaiting} aria-label="Generate another temporary room code">
                                        <RefreshCw size={12} />
                                        Regenerate
                                    </button>
                                )}
                            </label>
                            <div className="connect-input-wrap">
                                <Hash size={17} aria-hidden="true" />
                                <input
                                    id="room-code"
                                    name="room-code"
                                    value={inputValue}
                                    onChange={event => updateCode(event.target.value)}
                                    placeholder={mode === "create" ? "e.g. studio-files" : "Room code or invite link"}
                                    aria-describedby={inputError ? "room-code-help room-code-error" : "room-code-help"}
                                    aria-invalid={Boolean(inputError)}
                                    autoComplete="off"
                                    autoCapitalize="none"
                                    spellCheck={false}
                                    maxLength={mode === "create" ? 128 : undefined}
                                    disabled={isWaiting}
                                    required={mode === "join"}
                                />
                            </div>
                            <p className="connect-field-hint" id="room-code-help">
                                    {mode === "join" ? "Paste a room code or a PeerLink invite link."
                                    : selectedType === "temporary" ? "Share this generated code with your other device."
                                        : "Leave it blank and we’ll make a unique code."}
                            </p>
                            {inputError && <p className="connect-input-error" id="room-code-error" role="alert">{inputError}</p>}
                            {copyState === "failed" && <p className="connect-copy-error" role="status">Select the room code to copy it manually.</p>}
                            {mode === "create" && selectedType === "temporary" && inputValue.trim() && (
                                <button type="button" className="connect-draft-copy" onClick={() => void copyRoom(inputValue)}>
                                    {copyState === "copied" ? <Check size={14} /> : <Copy size={14} />}
                                    {copyState === "copied" ? "Code copied" : "Copy generated code"}
                                </button>
                            )}
                            {mode === "join" && (
                                <button type="button" className="connect-scan-button" onClick={() => setIsScannerOpen(true)} disabled={isWaiting} aria-haspopup="dialog">
                                    <ScanLine size={17} />
                                    Scan QR with camera
                                </button>
                            )}
                        </div>

                        <button type="submit" className="btn btn-primary connect-submit" disabled={isWaiting || (mode === "join" && !inputValue.trim())}>
                            {isWaiting ? <LoaderCircle size={17} className="connect-loading" />
                                : mode === "create" ? <Plus size={18} /> : <LogIn size={17} />}
                            <span>{isWaiting ? "Connecting…" : mode === "create" ? "Create room" : "Join room"}</span>
                        </button>
                        <p className="connect-form-footnote" role={isWaiting ? "status" : undefined}>
                            {isWaiting ? "Finding your room…" : <><ShieldCheck size={14} aria-hidden="true" /> Files travel between your devices.</>}
                        </p>
                    </form>
                </>
            )}
            <RoomInviteDialog isOpen={isInviteOpen && canInvite} onClose={() => setIsInviteOpen(false)} roomId={roomId} roomType={roomType} />
            <RoomScanDialog isOpen={isScannerOpen && !roomOpen} onClose={() => setIsScannerOpen(false)} onScanned={handleScannedInvite} />
        </section>
    );
}
