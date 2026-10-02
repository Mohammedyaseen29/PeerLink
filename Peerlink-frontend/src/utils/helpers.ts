/**
 * Format bytes to human readable string
 */
export const formatBytes = (bytes: number): string => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + " " + sizes[i];
};

/**
 * Format seconds to human readable time string
 */
export const formatTime = (seconds: number): string => {
    if (!seconds || seconds === Infinity || isNaN(seconds)) return "--:--";

    if (seconds < 60) {
        return `${Math.round(seconds)}s`;
    }

    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.round(seconds % 60);

    if (minutes < 60) {
        return `${minutes}m ${remainingSeconds}s`;
    }

    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;

    return `${hours}h ${remainingMinutes}m`;
};

/**
 * Calculate estimated time remaining based on transfer progress
 */
export const calculateETA = (
    bytesTransferred: number,
    totalBytes: number,
    startTime: number
): { eta: number; speed: number } => {
    const elapsedMs = Date.now() - startTime;

    if (elapsedMs < 500 || bytesTransferred === 0) {
        return { eta: Infinity, speed: 0 };
    }

    const speed = bytesTransferred / (elapsedMs / 1000); // bytes per second
    const remainingBytes = totalBytes - bytesTransferred;
    const eta = remainingBytes / speed;

    return { eta, speed };
};

/**
 * Check if a file type can be previewed
 */
export const isPreviewable = (mimeType: string): boolean => {
    return (
        mimeType.startsWith("image/") ||
        mimeType.startsWith("video/") ||
        mimeType.startsWith("audio/") ||
        mimeType === "application/pdf" ||
        mimeType.startsWith("text/")
    );
};

/** Prefer the browser's MIME type, and infer only common media/document types when it is missing. */
export const getFileMimeType = (file: File): string => {
    const actualMimeType = file.type.trim();
    const actualMimeEssence = actualMimeType.split(";", 1)[0].trim().toLowerCase();
    if (actualMimeEssence === "text/html" || actualMimeEssence === "application/xhtml+xml") return "text/plain";
    if (actualMimeType) return actualMimeType;

    const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
    const commonMimeTypes: Record<string, string> = {
        avif: "image/avif",
        bmp: "image/bmp",
        gif: "image/gif",
        heic: "image/heic",
        heif: "image/heif",
        jpe: "image/jpeg",
        jpeg: "image/jpeg",
        jpg: "image/jpeg",
        png: "image/png",
        webp: "image/webp",
        svg: "text/plain",
        ico: "image/x-icon",
        mp4: "video/mp4",
        m4v: "video/mp4",
        mov: "video/quicktime",
        ogv: "video/ogg",
        webm: "video/webm",
        aac: "audio/aac",
        flac: "audio/flac",
        m4a: "audio/mp4",
        mp3: "audio/mpeg",
        oga: "audio/ogg",
        ogg: "audio/ogg",
        wav: "audio/wav",
        weba: "audio/webm",
        pdf: "application/pdf",
        csv: "text/csv",
        json: "text/plain",
        log: "text/plain",
        md: "text/plain",
        markdown: "text/plain",
        txt: "text/plain",
        htm: "text/plain",
        html: "text/plain",
    };

    return commonMimeTypes[extension] ?? "application/octet-stream";
};

/**
 * Get file icon based on mime type
 */
export const getFileIconType = (mimeType: string): string => {
    if (mimeType.startsWith("image/")) return "image";
    if (mimeType.startsWith("video/")) return "video";
    if (mimeType.startsWith("audio/")) return "audio";
    if (mimeType === "application/pdf") return "pdf";
    if (mimeType.startsWith("text/")) return "text";
    if (mimeType.includes("zip") || mimeType.includes("archive")) return "archive";
    return "file";
};

/**
 * Generate a unique ID
 */
export const generateId = (): string => {
    return `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
};
