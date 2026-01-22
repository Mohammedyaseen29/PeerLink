import React from 'react';
import { motion } from 'framer-motion';

const AnimatedBackground: React.FC = () => {
    return (
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
            {/* Gradient overlay */}
            <div className="absolute inset-0 bg-gradient-to-br from-[#0a0a0f] via-[#12121a] to-[#1a1a2f]" />

            {/* Animated orbital lines */}
            <svg
                className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] md:w-[800px] md:h-[800px]"
                viewBox="0 0 400 400"
                fill="none"
            >
                <defs>
                    <linearGradient id="gradient1" x1="0%" y1="0%" x2="100%" y2="100%">
                        <stop offset="0%" stopColor="#00d4ff" stopOpacity="0.8" />
                        <stop offset="50%" stopColor="#00d4ff" stopOpacity="0.2" />
                        <stop offset="100%" stopColor="#00d4ff" stopOpacity="0" />
                    </linearGradient>
                    <linearGradient id="gradient2" x1="100%" y1="0%" x2="0%" y2="100%">
                        <stop offset="0%" stopColor="#8b5cf6" stopOpacity="0.8" />
                        <stop offset="50%" stopColor="#8b5cf6" stopOpacity="0.2" />
                        <stop offset="100%" stopColor="#8b5cf6" stopOpacity="0" />
                    </linearGradient>
                    <linearGradient id="gradient3" x1="0%" y1="100%" x2="100%" y2="0%">
                        <stop offset="0%" stopColor="#f97316" stopOpacity="0.8" />
                        <stop offset="50%" stopColor="#fbbf24" stopOpacity="0.3" />
                        <stop offset="100%" stopColor="#fbbf24" stopOpacity="0" />
                    </linearGradient>
                </defs>

                {/* Orbital ring 1 - Cyan */}
                <motion.ellipse
                    cx="200"
                    cy="200"
                    rx="150"
                    ry="100"
                    stroke="url(#gradient1)"
                    strokeWidth="2"
                    fill="none"
                    initial={{ rotate: 0 }}
                    animate={{ rotate: 360 }}
                    transition={{ duration: 30, repeat: Infinity, ease: 'linear' }}
                    style={{ transformOrigin: 'center' }}
                />

                {/* Orbital ring 2 - Purple */}
                <motion.ellipse
                    cx="200"
                    cy="200"
                    rx="120"
                    ry="140"
                    stroke="url(#gradient2)"
                    strokeWidth="2"
                    fill="none"
                    initial={{ rotate: 45 }}
                    animate={{ rotate: 405 }}
                    transition={{ duration: 25, repeat: Infinity, ease: 'linear' }}
                    style={{ transformOrigin: 'center' }}
                />

                {/* Orbital ring 3 - Orange */}
                <motion.ellipse
                    cx="200"
                    cy="200"
                    rx="100"
                    ry="160"
                    stroke="url(#gradient3)"
                    strokeWidth="2"
                    fill="none"
                    initial={{ rotate: -30 }}
                    animate={{ rotate: -390 }}
                    transition={{ duration: 35, repeat: Infinity, ease: 'linear' }}
                    style={{ transformOrigin: 'center' }}
                />

                {/* Inner glow circle */}
                <motion.circle
                    cx="200"
                    cy="200"
                    r="60"
                    fill="none"
                    stroke="rgba(0, 212, 255, 0.1)"
                    strokeWidth="1"
                    initial={{ scale: 0.9, opacity: 0.5 }}
                    animate={{ scale: 1.1, opacity: 0.2 }}
                    transition={{ duration: 3, repeat: Infinity, repeatType: 'reverse', ease: 'easeInOut' }}
                />
            </svg>

            {/* Floating particles */}
            {[...Array(6)].map((_, i) => (
                <motion.div
                    key={i}
                    className="absolute w-1 h-1 rounded-full bg-cyan-400"
                    style={{
                        left: `${20 + i * 15}%`,
                        top: `${30 + (i % 3) * 20}%`,
                    }}
                    animate={{
                        y: [0, -20, 0],
                        opacity: [0.3, 0.8, 0.3],
                    }}
                    transition={{
                        duration: 3 + i * 0.5,
                        repeat: Infinity,
                        delay: i * 0.3,
                    }}
                />
            ))}
        </div>
    );
};

export default AnimatedBackground;
