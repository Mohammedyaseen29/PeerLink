import React from 'react';
import { motion } from 'framer-motion';

interface TransferProgressProps {
    progress: number;
    fileName?: string;
    status?: 'sending' | 'receiving' | 'complete' | 'idle';
    size?: number;
}

const TransferProgress: React.FC<TransferProgressProps> = ({
    progress,
    fileName,
    status = 'idle',
    size,
}) => {
    const radius = 52;
    const circumference = 2 * Math.PI * radius;
    const strokeDashoffset = circumference - (progress / 100) * circumference;

    const formatBytes = (bytes: number): string => {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
    };

    const statusColors = {
        sending: { start: '#00d4ff', end: '#00ff88' },
        receiving: { start: '#8b5cf6', end: '#a855f7' },
        complete: { start: '#22c55e', end: '#22c55e' },
        idle: { start: '#6b7280', end: '#6b7280' },
    };

    const colors = statusColors[status];

    return (
        <div className="flex flex-col items-center gap-4">
            <div className="circular-progress">
                <svg width="120" height="120" viewBox="0 0 120 120">
                    <defs>
                        <linearGradient id="progressGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                            <stop offset="0%" stopColor={colors.start} />
                            <stop offset="100%" stopColor={colors.end} />
                        </linearGradient>
                    </defs>

                    {/* Background circle */}
                    <circle
                        cx="60"
                        cy="60"
                        r={radius}
                        className="circular-progress-bg"
                    />

                    {/* Progress circle */}
                    <motion.circle
                        cx="60"
                        cy="60"
                        r={radius}
                        fill="none"
                        stroke="url(#progressGradient)"
                        strokeWidth="8"
                        strokeLinecap="round"
                        strokeDasharray={circumference}
                        initial={{ strokeDashoffset: circumference }}
                        animate={{ strokeDashoffset }}
                        transition={{ duration: 0.5, ease: 'easeOut' }}
                    />
                </svg>

                {/* Center content */}
                <div className="circular-progress-text text-center">
                    <motion.span
                        key={progress}
                        initial={{ scale: 1.2, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        transition={{ duration: 0.2 }}
                    >
                        {progress}%
                    </motion.span>
                </div>
            </div>

            {/* Status info */}
            {(fileName || status !== 'idle') && (
                <motion.div
                    className="text-center"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                >
                    {fileName && (
                        <p className="text-sm font-medium text-white truncate max-w-[200px]">
                            {fileName}
                        </p>
                    )}
                    <div className="flex items-center gap-2 justify-center mt-1">
                        <span className="text-xs text-white/50 capitalize">{status}</span>
                        {size && (
                            <>
                                <span className="text-white/30">•</span>
                                <span className="text-xs text-white/50">{formatBytes(size)}</span>
                            </>
                        )}
                    </div>
                </motion.div>
            )}

            {/* Pulsing ring for active transfers */}
            {(status === 'sending' || status === 'receiving') && (
                <motion.div
                    className="absolute w-[140px] h-[140px] rounded-full border-2"
                    style={{ borderColor: colors.start }}
                    initial={{ scale: 1, opacity: 0.5 }}
                    animate={{ scale: 1.2, opacity: 0 }}
                    transition={{ duration: 1.5, repeat: Infinity }}
                />
            )}
        </div>
    );
};

export default TransferProgress;
