import { useRef, useState } from "react";
import { File, FolderOpen, Upload } from "lucide-react";

interface FileUploaderProps {
    onFilesSelect: (files: File[]) => void;
    disabled?: boolean;
}

export function FileUploader({ onFilesSelect, disabled }: FileUploaderProps) {
    const fileInputRef = useRef<HTMLInputElement>(null);
    const folderInputRef = useRef<HTMLInputElement>(null);
    const [isDragOver, setIsDragOver] = useState(false);

    const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files || []);
        if (files.length > 0) {
            onFilesSelect(files);
            e.target.value = "";
        }
    };

    const handleDragOver = (e: React.DragEvent) => {
        e.preventDefault();
        if (!disabled) {
            setIsDragOver(true);
        }
    };

    const handleDragLeave = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragOver(false);
    };

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragOver(false);

        if (disabled) return;

        const files = Array.from(e.dataTransfer.files);
        if (files.length > 0) {
            onFilesSelect(files);
        }
    };

    return (
        <div className="file-uploader">
            <div
                className={`drop-zone glass-card ${isDragOver ? "drag-over" : ""} ${disabled ? "disabled" : ""}`}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
            >
                <Upload size={48} className="drop-icon" />
                <p className="drop-text">Drag & drop files here</p>
                <p className="drop-subtext">or use the buttons below</p>
            </div>

            <div className="upload-buttons">
                <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    onChange={handleFileSelect}
                    className="hidden"
                    disabled={disabled}
                />
                <button
                    onClick={() => fileInputRef.current?.click()}
                    className="btn btn-secondary"
                    disabled={disabled}
                >
                    <File size={18} />
                    <span>Select Files</span>
                </button>

                <input
                    ref={folderInputRef}
                    type="file"
                    webkitdirectory="true"
                    onChange={handleFileSelect}
                    className="hidden"
                    disabled={disabled}
                />
                <button
                    onClick={() => folderInputRef.current?.click()}
                    className="btn btn-secondary"
                    disabled={disabled}
                >
                    <FolderOpen size={18} />
                    <span>Select Folder</span>
                </button>
            </div>
        </div>
    );
}
