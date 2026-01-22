import React from 'react';
import { motion } from 'framer-motion';

interface FileCardProps {
    name: string;
    size: number;
    progress?: number;
    status: 'pending' | 'sending' | 'receiving' | 'complete' | 'sent' | 'failed';
    path?: string;
    onDownload?: () => void;
    onRemove?: () => void;
    index?: number;
}

const FileCard: React.FC<FileCardProps> = ({
    name,
    size,
    progress = 0,
    status,
    path,
    onDownload,
    onRemove,
    index = 0,
}) => {
    const formatBytes = (bytes: number): string => {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
    };

    const getFileIcon = (fileName: string) => {
        const ext = fileName.split('.').pop()?.toLowerCase();

        const iconMap: Record<string, { color: string; icon: JSX.Element }> = {
            // Images
            jpg: { color: 'from-pink-500 to-rose-500', icon: <ImageIcon /> },
            jpeg: { color: 'from-pink-500 to-rose-500', icon: <ImageIcon /> },
            png: { color: 'from-pink-500 to-rose-500', icon: <ImageIcon /> },
            gif: { color: 'from-pink-500 to-rose-500', icon: <ImageIcon /> },
            svg: { color: 'from-pink-500 to-rose-500', icon: <ImageIcon /> },
            webp: { color: 'from-pink-500 to-rose-500', icon: <ImageIcon /> },

            // Videos
            mp4: { color: 'from-purple-500 to-violet-500', icon: <VideoIcon /> },
            mov: { color: 'from-purple-500 to-violet-500', icon: <VideoIcon /> },
            avi: { color: 'from-purple-500 to-violet-500', icon: <VideoIcon /> },
            mkv: { color: 'from-purple-500 to-violet-500', icon: <VideoIcon /> },

            // Documents
            pdf: { color: 'from-red-500 to-orange-500', icon: <DocIcon /> },
            doc: { color: 'from-blue-500 to-cyan-500', icon: <DocIcon /> },
            docx: { color: 'from-blue-500 to-cyan-500', icon: <DocIcon /> },
            txt: { color: 'from-gray-500 to-gray-600', icon: <DocIcon /> },

            // Code
            js: { color: 'from-yellow-500 to-amber-500', icon: <CodeIcon /> },
            ts: { color: 'from-blue-500 to-blue-600', icon: <CodeIcon /> },
            jsx: { color: 'from-cyan-500 to-teal-500', icon: <CodeIcon /> },
            tsx: { color: 'from-cyan-500 to-blue-500', icon: <CodeIcon /> },
            py: { color: 'from-green-500 to-emerald-500', icon: <CodeIcon /> },

            // Archives
            zip: { color: 'from-amber-500 to-yellow-500', icon: <ArchiveIcon /> },
            rar: { color: 'from-amber-500 to-yellow-500', icon: <ArchiveIcon /> },
            '7z': { color: 'from-amber-500 to-yellow-500', icon: <ArchiveIcon /> },
        };

        return iconMap[ext || ''] || { color: 'from-gray-500 to-gray-600', icon: <FileIcon /> };
    };

    const statusConfig = {
        pending: { text: 'Pending', color: 'text-white/50' },
        sending: { text: 'Sending...', color: 'text-cyan-400' },
        receiving: { text: 'Receiving...', color: 'text-purple-400' },
        complete: { text: 'Complete', color: 'text-green-400' },
        sent: { text: 'Sent', color: 'text-green-400' },
        failed: { text: 'Failed', color: 'text-red-400' },
    };

    const { color: iconColor, icon } = getFileIcon(name);
    const { text: statusText, color: statusColor } = statusConfig[status];
    const isActive = status === 'sending' || status === 'receiving';
    const showProgress = isActive && progress > 0;

    return (
        <motion.div
            className="file-card"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, x: -20 }}
            transition={{ delay: index * 0.05 }}
            layout
        >
            <div className="flex items-center gap-3">
                {/* File icon */}
                <div className={`file-icon bg-gradient-to-br ${iconColor}`}>
                    {icon}
                </div>

                {/* File info */}
                <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-white truncate">{name}</p>
                    {path && <p className="text-xs text-white/40 truncate">{path}</p>}
                    <div className="flex items-center gap-2 mt-1">
                        <span className="text-xs text-white/50">{formatBytes(size)}</span>
                        <span className="text-white/20">•</span>
                        <span className={`text-xs ${statusColor}`}>{statusText}</span>
                        {showProgress && (
                            <>
                                <span className="text-white/20">•</span>
                                <span className="text-xs text-white/50">{progress}%</span>
                            </>
                        )}
                    </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2">
                    {status === 'complete' && onDownload && (
                        <motion.button
                            onClick={onDownload}
                            className="p-2 rounded-lg bg-white/5 hover:bg-white/10 transition-colors"
                            whileHover={{ scale: 1.1 }}
                            whileTap={{ scale: 0.9 }}
                        >
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" className="text-white">
                                <path d="M21 15V19C21 20.1046 20.1046 21 19 21H5C3.89543 21 3 20.1046 3 19V15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                                <path d="M12 3V15M12 15L8 11M12 15L16 11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                        </motion.button>
                    )}

                    {(status === 'pending' || status === 'failed') && onRemove && (
                        <motion.button
                            onClick={onRemove}
                            className="p-2 rounded-lg bg-white/5 hover:bg-red-500/20 transition-colors"
                            whileHover={{ scale: 1.1 }}
                            whileTap={{ scale: 0.9 }}
                        >
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" className="text-white/50 hover:text-red-400">
                                <path d="M18 6L6 18M6 6L18 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                            </svg>
                        </motion.button>
                    )}
                </div>
            </div>

            {/* Progress bar */}
            {showProgress && (
                <motion.div
                    className="progress-bar mt-3"
                    initial={{ opacity: 0, scaleX: 0 }}
                    animate={{ opacity: 1, scaleX: 1 }}
                >
                    <motion.div
                        className="progress-fill"
                        initial={{ width: 0 }}
                        animate={{ width: `${progress}%` }}
                        transition={{ duration: 0.3 }}
                    />
                </motion.div>
            )}
        </motion.div>
    );
};

// Icon components
const FileIcon = () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
        <path d="M14 2H6C4.89543 2 4 2.89543 4 4V20C4 21.1046 4.89543 22 6 22H18C19.1046 22 20 21.1046 20 20V8L14 2Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M14 2V8H20" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
);

const ImageIcon = () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
        <rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" strokeWidth="2" />
        <circle cx="8.5" cy="8.5" r="1.5" fill="currentColor" />
        <path d="M21 15L16 10L5 21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
);

const VideoIcon = () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
        <rect x="2" y="4" width="20" height="16" rx="2" stroke="currentColor" strokeWidth="2" />
        <path d="M10 9L15 12L10 15V9Z" fill="currentColor" />
    </svg>
);

const DocIcon = () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
        <path d="M14 2H6C4.89543 2 4 2.89543 4 4V20C4 21.1046 4.89543 22 6 22H18C19.1046 22 20 21.1046 20 20V8L14 2Z" stroke="currentColor" strokeWidth="2" />
        <path d="M14 2V8H20" stroke="currentColor" strokeWidth="2" />
        <path d="M8 13H16M8 17H13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
);

const CodeIcon = () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
        <path d="M16 18L22 12L16 6M8 6L2 12L8 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
);

const ArchiveIcon = () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
        <path d="M21 8V21H3V8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M23 3H1V8H23V3Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M10 12H14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
);

export default FileCard;
