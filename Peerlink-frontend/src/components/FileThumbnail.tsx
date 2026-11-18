import { useEffect, useRef, useState } from "react";
import { Archive, File as FileIcon, FileAudio, FileImage, FileText, FileVideo } from "lucide-react";
import { getFileIconType, getFileMimeType } from "../utils/helpers";

interface FileThumbnailProps {
    file: File;
    className?: string;
}

const fileIcons = {
    image: FileImage,
    video: FileVideo,
    audio: FileAudio,
    pdf: FileText,
    text: FileText,
    archive: Archive,
    file: FileIcon,
};

const MAX_IMAGE_FALLBACK_BYTES = 32 * 1024 * 1024;
let activeImageDecodes = 0;
const imageDecodeWaiters: Array<() => void> = [];

async function withImageDecodeSlot<T>(work: () => Promise<T>): Promise<T> {
    if (activeImageDecodes >= 2) {
        await new Promise<void>(resolve => imageDecodeWaiters.push(resolve));
    } else {
        activeImageDecodes++;
    }
    try {
        return await work();
    } finally {
        const next = imageDecodeWaiters.shift();
        if (next) next();
        else activeImageDecodes--;
    }
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
    return new Promise(resolve => canvas.toBlob(resolve, "image/webp", 0.78));
}

async function makeBoundedImageUrl(file: File): Promise<string | null> {
    if (typeof createImageBitmap !== "function") {
        return file.size <= MAX_IMAGE_FALLBACK_BYTES ? URL.createObjectURL(file) : null;
    }
    return withImageDecodeSlot(async () => {
        const bitmap = await createImageBitmap(file, { resizeWidth: 96, resizeHeight: 96, resizeQuality: "medium" });
        try {
            const canvas = document.createElement("canvas");
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
            const context = canvas.getContext("2d");
            if (!context) return file.size <= MAX_IMAGE_FALLBACK_BYTES ? URL.createObjectURL(file) : null;
            context.drawImage(bitmap, 0, 0);
            const thumbnail = await canvasBlob(canvas);
            return thumbnail ? URL.createObjectURL(thumbnail) : file.size <= MAX_IMAGE_FALLBACK_BYTES ? URL.createObjectURL(file) : null;
        } finally {
            bitmap.close();
        }
    });
}

/**
 * Keep preview work tied to the visible rows. URLs are released when a row scrolls
 * away or unmounts, so long queues do not retain hundreds of media handles.
 */
export function FileThumbnail({ file, className = "" }: FileThumbnailProps) {
    const host = useRef<HTMLDivElement>(null);
    const videoElement = useRef<HTMLVideoElement>(null);
    const [nearViewport, setNearViewport] = useState(false);
    const [url, setUrl] = useState<string | null>(null);
    const [mediaFailed, setMediaFailed] = useState(false);
    const mimeType = getFileMimeType(file);
    const iconType = getFileIconType(mimeType) as keyof typeof fileIcons;
    const Icon = fileIcons[iconType] || FileIcon;
    const isImage = mimeType.startsWith("image/");
    const isVideo = mimeType.startsWith("video/");

    useEffect(() => {
        const element = host.current;
        if (!element) return;
        if (typeof IntersectionObserver === "undefined") {
            setNearViewport(true);
            return;
        }

        const observer = new IntersectionObserver(([entry]) => {
            setNearViewport(entry.isIntersecting);
        }, { rootMargin: "180px" });
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    useEffect(() => {
        let current = true;
        let objectUrl: string | null = null;
        setMediaFailed(false);
        if (!nearViewport || (!isImage && !isVideo)) {
            setUrl(null);
            return undefined;
        }
        setUrl(null);
        const load = async () => {
            try {
                objectUrl = isImage ? await makeBoundedImageUrl(file) : URL.createObjectURL(file);
                if (!current) {
                    if (objectUrl) URL.revokeObjectURL(objectUrl);
                    return;
                }
                if (objectUrl) setUrl(objectUrl);
                else setMediaFailed(true);
            } catch {
                if (!current) return;
                if (file.size <= MAX_IMAGE_FALLBACK_BYTES) {
                    objectUrl = URL.createObjectURL(file);
                    setUrl(objectUrl);
                } else {
                    setMediaFailed(true);
                }
            }
        };
        void load();
        return () => {
            current = false;
            const video = videoElement.current;
            if (video) {
                video.pause();
                video.removeAttribute("src");
                video.load();
            }
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        };
    }, [file, isImage, isVideo, nearViewport]);

    return (
        <div ref={host} className={`file-thumbnail ${className}`} aria-hidden="true">
            {url && !mediaFailed && isImage ? (
                <img src={url} alt="" loading="lazy" onError={() => setMediaFailed(true)} />
            ) : url && !mediaFailed && isVideo ? (
                <video
                    ref={videoElement}
                    src={url}
                    muted
                    playsInline
                    preload="metadata"
                    onLoadedMetadata={(event) => {
                        const video = event.currentTarget;
                        if (video.duration > 0) video.currentTime = Math.min(0.1, video.duration / 2);
                    }}
                    onError={() => setMediaFailed(true)}
                />
            ) : (
                <Icon size={22} />
            )}
        </div>
    );
}
