import { useEffect, useState } from "react";
import { Check, Download, Settings, X } from "lucide-react";
import type { Settings as SettingsType } from "../types";
import { Avatar } from "./Avatar";
import { AVATARS } from "./avatars";

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

    useEffect(() => {
        setAutoDownload(settings.autoDownload);
        setSelectedAvatar(avatar);
        setEditedUsername(username);
        setSaveError(null);
    }, [settings, username, avatar, isOpen]);

    const trimmedUsername = editedUsername.trim();
    const hasControlCharacters = /[\u0000-\u001f\u007f]/.test(trimmedUsername);
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

            <div className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-modal-title">
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
                            <div className="settings-avatar-preview">
                                <Avatar avatarId={selectedAvatar} size="lg" />
                            </div>
                            <div className="settings-avatar-picker">
                                <p className="settings-avatar-label">Choose your avatar</p>
                                <div className="avatar-picker-grid">
                                    {AVATARS.map((av) => (
                                        <button
                                            key={av.id}
                                            type="button"
                                            className={`avatar-picker-item ${selectedAvatar === av.id ? "selected" : ""}`}
                                            onClick={() => setSelectedAvatar(av.id)}
                                            aria-label={`Choose avatar ${av.id}`}
                                            aria-pressed={selectedAvatar === av.id}
                                        >
                                            <div
                                                className="avatar-blob avatar-blob-sm"
                                                style={{ backgroundColor: av.bgColor, color: av.color }}
                                                aria-hidden="true"
                                            >
                                                {av.emoji}
                                            </div>
                                            {selectedAvatar === av.id && (
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

                    <div className="settings-modal-footer">
                        {saveError && <p className="settings-save-error" role="alert">{saveError}</p>}
                        <button type="button" onClick={handleSave} className="settings-save-btn" disabled={!usernameValid}>
                            Save Changes
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
