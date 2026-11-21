import { useEffect, useRef, useState } from "react";
import { Check, Download, Settings, Shuffle, X } from "lucide-react";
import type { Settings as SettingsType } from "../types";
import { Avatar } from "./Avatar";
import { AVATARS, getAvatarById } from "./avatars";
import "./room.css";

interface SettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
    settings: SettingsType;
    username: string;
    avatar: string;
    onUpdateSettings: (settings: Partial<SettingsType>) => boolean;
}

export function SettingsModal({ isOpen, onClose, settings, username, avatar, onUpdateSettings }: SettingsModalProps) {
    const [autoDownload, setAutoDownload] = useState(settings.autoDownload);
    const [selectedAvatar, setSelectedAvatar] = useState(avatar);
    const [editedUsername, setEditedUsername] = useState(username);
    const [saveError, setSaveError] = useState<string | null>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const closeHandler = useRef(onClose);
    closeHandler.current = onClose;
    const selectedCharacter = getAvatarById(selectedAvatar);

    useEffect(() => {
        if (!isOpen) return;
        const previouslyFocused = document.activeElement;
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        const frame = requestAnimationFrame(() => panelRef.current?.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true }));
        const handleKey = (event: KeyboardEvent) => {
            if (event.isComposing) return;
            if (event.key === "Escape") { event.preventDefault(); closeHandler.current(); }
            if (event.key !== "Tab") return;
            const elements = Array.from(panelRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])') ?? []);
            const first = elements[0], last = elements.at(-1);
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        };
        document.addEventListener("keydown", handleKey);
        return () => {
            cancelAnimationFrame(frame);
            document.removeEventListener("keydown", handleKey);
            document.body.style.overflow = previousOverflow;
            if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) previouslyFocused.focus({ preventScroll: true });
        };
    }, [isOpen]);

    useEffect(() => {
        setAutoDownload(settings.autoDownload);
        setSelectedAvatar(avatar);
        setEditedUsername(username);
        setSaveError(null);
    }, [settings, username, avatar, isOpen]);

    const trimmedUsername = editedUsername.trim();
    const hasControlCharacters = /[\u0000-\u001f\u007f-\u009f]/.test(trimmedUsername);
    const usernameValid = trimmedUsername.length >= 1 && trimmedUsername.length <= 64 && !hasControlCharacters;
    const usernameError = trimmedUsername.length === 0
        ? "Display name is required."
        : trimmedUsername.length > 64
            ? "Use 64 characters or fewer."
            : hasControlCharacters
                ? "Remove control characters from the display name."
                : null;

    const handleSave = () => {
        if (!usernameValid) return;
        setSaveError(null);
        const saved = onUpdateSettings({ username: trimmedUsername, autoDownload, avatar: selectedAvatar });
        if (saved) onClose();
        else setSaveError("Unable to save your settings. Please try again.");
    };

    if (!isOpen) return null;

    return (
        <div className="settings-modal-overlay">
            <div className="settings-modal-backdrop" onClick={onClose} />

            <div ref={panelRef} className="settings-modal peer-settings" role="dialog" aria-modal="true" aria-labelledby="settings-modal-title">
                <div className="settings-modal-header">
                    <div className="settings-modal-title">
                        <Settings size={22} aria-hidden="true" />
                        <h2 id="settings-modal-title">Settings</h2>
                    </div>
                    <button type="button" onClick={onClose} className="settings-modal-close" aria-label="Close settings">
                        <X size={20} />
                    </button>
                </div>

                <div className="settings-modal-content">
                    <div className="settings-section">
                        <h3 className="settings-section-title">Profile</h3>
                        <label className="settings-field" htmlFor="settings-display-name">
                            <span className="settings-field-label">Display name</span>
                            <input
                                id="settings-display-name"
                                className="settings-text-input"
                                type="text"
                                value={editedUsername}
                                onChange={(event) => {
                                    setEditedUsername(event.target.value);
                                    setSaveError(null);
                                }}
                                maxLength={64}
                                autoComplete="nickname"
                                aria-invalid={!usernameValid}
                                aria-describedby={usernameError ? "settings-display-name-error" : undefined}
                            />
                            {usernameError && <span className="settings-field-error" id="settings-display-name-error">{usernameError}</span>}
                        </label>
                        <div className="settings-avatar-section">
                            <div className="character-preview">
                                <div className="character-preview-stage" aria-hidden="true">
                                    <span className="character-preview-orbit" />
                                    <Avatar key={selectedCharacter.id} avatarId={selectedCharacter.id} size="xl" />
                                </div>
                                <div className="character-preview-copy" role="status" aria-live="polite" aria-atomic="true">
                                    <span className="character-preview-eyebrow">Your room character</span>
                                    <strong>{selectedCharacter.name}</strong>
                                    <p>{selectedCharacter.description}</p>
                                </div>
                            </div>
                            <div className="settings-avatar-picker">
                                <div className="character-picker-heading">
                                    <p id="character-picker-label">Pick your character</p>
                                    <button type="button" className="character-shuffle" onClick={() => {
                                        const others = AVATARS.filter(character => character.id !== selectedCharacter.id);
                                        setSelectedAvatar(others[Math.floor(Math.random() * others.length)].id);
                                    }}><Shuffle size={14} aria-hidden="true" />Surprise me</button>
                                </div>
                                <div className="avatar-picker-grid" role="group" aria-labelledby="character-picker-label">
                                    {AVATARS.map((av) => (
                                        <button
                                            key={av.id}
                                            type="button"
                                            className={`avatar-picker-item ${selectedCharacter.id === av.id ? "selected" : ""}`}
                                            onClick={() => setSelectedAvatar(av.id)}
                                            aria-label={`Choose ${av.name}`}
                                            aria-pressed={selectedCharacter.id === av.id}
                                            title={av.description}
                                        >
                                            <span aria-hidden="true"><Avatar avatarId={av.id} size="md" /></span>
                                            <span className="character-option-name">{av.name}</span>
                                            {selectedCharacter.id === av.id && (
                                                <div className="avatar-picker-check" aria-hidden="true"><Check size={12} /></div>
                                            )}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        </div>
                    </div>

                    <div className="settings-section">
                        <h3 className="settings-section-title">Preferences</h3>
                        <div className="settings-toggle">
                            <div className="settings-toggle-info">
                                <div className="settings-toggle-icon"><Download size={20} aria-hidden="true" /></div>
                                <div className="settings-toggle-text">
                                    <span className="settings-toggle-label">Auto-download files</span>
                                    <span className="settings-toggle-desc">Automatically download when transfer completes</span>
                                </div>
                            </div>
                            <button
                                type="button"
                                role="switch"
                                aria-checked={autoDownload}
                                aria-label="Auto-download files"
                                className={`settings-toggle-switch ${autoDownload ? "active" : ""}`}
                                onClick={() => setAutoDownload((value) => !value)}
                            >
                                <span className="settings-toggle-knob" />
                            </button>
                        </div>
                    </div>

                </div>
                <div className="settings-modal-footer">
                    {saveError && <p className="settings-save-error" role="alert">{saveError}</p>}
                    <button type="button" onClick={handleSave} className="settings-save-btn" disabled={!usernameValid}>
                        Save Changes
                    </button>
                </div>
            </div>
        </div>
    );
}
