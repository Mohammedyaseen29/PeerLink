import { useState, useEffect } from "react";
import { X, Download, Settings } from "lucide-react";
import type { Settings as SettingsType } from "../types";

interface SettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
    settings: SettingsType;
    onUpdateSettings: (settings: Partial<SettingsType>) => void;
}

export function SettingsModal({
    isOpen,
    onClose,
    settings,
    onUpdateSettings,
}: SettingsModalProps) {
    const [autoDownload, setAutoDownload] = useState(settings.autoDownload);

    useEffect(() => {
        setAutoDownload(settings.autoDownload);
    }, [settings, isOpen]);

    const handleSave = () => {
        onUpdateSettings({ autoDownload });
        onClose();
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div 
                className="absolute inset-0 bg-black/60 backdrop-blur-sm"
                onClick={onClose}
            />
            
            <div className="relative w-full max-w-md bg-[#1a1a2e]/95 backdrop-blur-xl rounded-2xl shadow-2xl border border-white/10 overflow-hidden animate-scale-in">
                {/* Header */}
                <div className="flex items-center justify-between px-6 py-5 bg-gradient-to-r from-violet-600 to-indigo-600">
                    <div className="flex items-center gap-3">
                        <Settings size={22} className="text-white" />
                        <h2 className="text-lg font-semibold text-white">Settings</h2>
                    </div>
                    <button
                        onClick={onClose}
                        className="p-2 hover:bg-white/20 rounded-lg transition-colors"
                    >
                        <X size={20} className="text-white" />
                    </button>
                </div>

                {/* Content */}
                <div className="p-6 space-y-6">
                    {/* Auto-download Option */}
                    <div className="bg-white/5 rounded-xl p-4 border border-white/5">
                        <label className="flex items-center justify-between cursor-pointer">
                            <div className="flex items-center gap-3">
                                <div className="p-2.5 bg-violet-600/20 rounded-lg">
                                    <Download size={20} className="text-violet-400" />
                                </div>
                                <div>
                                    <span className="text-sm font-medium text-gray-200 block">
                                        Auto-download files
                                    </span>
                                    <span className="text-xs text-gray-500">
                                        Automatically download when transfer completes
                                    </span>
                                </div>
                            </div>
                            <div 
                                className={`relative w-12 h-6 rounded-full transition-colors shrink-0 ${
                                    autoDownload ? "bg-violet-600" : "bg-white/20"
                                }`}
                                onClick={() => setAutoDownload(!autoDownload)}
                            >
                                <div 
                                    className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-transform ${
                                        autoDownload ? "translate-x-7" : "translate-x-1"
                                    }`}
                                />
                            </div>
                        </label>
                    </div>

                    {/* Save Button */}
                    <div className="pt-2">
                        <button
                            onClick={handleSave}
                            className="w-full py-3.5 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white font-semibold rounded-xl transition-all hover:scale-[1.02] active:scale-[0.98] shadow-lg"
                        >
                            Save Changes
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
