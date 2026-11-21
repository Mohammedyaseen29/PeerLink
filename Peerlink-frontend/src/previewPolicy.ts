/** Text previews show only a prefix; browser image/PDF decoders are not bounded by stream buffers. */
export const MAX_TEXT_PREVIEW_BYTES = 256 * 1024;
export const MAX_DECODE_PREVIEW_BYTES = 32 * 1024 * 1024;

export function checkPreviewSize(file: { size: number; mimeType: string }): void {
    if (file.size > MAX_DECODE_PREVIEW_BYTES && (file.mimeType.startsWith('image/') || file.mimeType === 'application/pdf')) {
        throw new Error('This image or PDF is too large for an in-browser preview. Download it to open it in another app.');
    }
}

export function safePreviewMime(mimeType: string): string {
    if (mimeType.startsWith('text/')) return 'text/plain; charset=utf-8';
    return /^(image|audio|video)\/[\w.+-]+$/.test(mimeType) || mimeType === 'application/pdf'
        ? mimeType : 'application/octet-stream';
}
