import { useState, useEffect } from "react";
import { X, Download, Settings, Check } from "lucide-react";
import type { Settings as SettingsType } from "../types";
import { Avatar } from "./Avatar";
import { AVATARS } from "./avatars";

interface SettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
    settings: SettingsType;
    avatar: string;
    onUpdateSettings: (settings: Partial<SettingsType>) => void;
}

export function SettingsModal({
    isOpen,
    onClose,
    settings,
    avatar,
    onUpdateSettings,
}: SettingsModalProps) {
    const [autoDownload, setAutoDownload] = useState(settings.autoDownload);
    const [selectedAvatar, setSelectedAvatar] = useState(avatar);

    useEffect(() => {
        setAutoDownload(settings.autoDownload);
        setSelectedAvatar(avatar);
    }, [settings, avatar, isOpen]);

    const handleSave = () => {
        onUpdateSettings({ autoDownload, avatar: selectedAvatar });
        onClose();
    };

    if (!isOpen) return null;

    return (
        <div className="settings-modal-overlay">
            <div 
                className="settings-modal-backdrop"
                onClick={onClose}
            />
            
            <div className="settings-modal">
                <div className="settings-modal-header">
                    <div className="settings-modal-title">
                        <Settings size={22} />
                        <h2>Settings</h2>
                    </div>
                    <button
                        onClick={onClose}
                        className="settings-modal-close"
                    >
                        <X size={20} />
                    </button>
                </div>

                <div className="settings-modal-content">
                    <div className="settings-section">
                        <h3 className="settings-section-title">Profile</h3>
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
                                        >
                                            <div 
                                                className="avatar-blob avatar-blob-sm"
                                                style={{
                                                    backgroundColor: av.bgColor,
                                                    color: av.color,
                                                }}
                                            >
                                                {av.emoji}
                                            </div>
                                            {selectedAvatar === av.id && (
                                                <div className="avatar-picker-check">
                                                    <Check size={12} />
                                                </div>
                                            )}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        </div>
                    </div>

                    <div className="settings-section">
                        <h3 className="settings-section-title">Preferences</h3>
                        <label className="settings-toggle">
                            <div className="settings-toggle-info">
                                <div className="settings-toggle-icon">
                                    <Download size={20} />
                                </div>
                                <div className="settings-toggle-text">
                                    <span className="settings-toggle-label">Auto-download files</span>
                                    <span className="settings-toggle-desc">Automatically download when transfer completes</span>
                                </div>
                            </div>
                            <div 
                                className={`settings-toggle-switch ${autoDownload ? "active" : ""}`}
                                onClick={() => setAutoDownload(!autoDownload)}
                            >
                                <div className="settings-toggle-knob" />
                            </div>
                        </label>
                    </div>

                    <div className="settings-modal-footer">
                        <button
                            onClick={handleSave}
                            className="settings-save-btn"
                        >
                            Save Changes
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
