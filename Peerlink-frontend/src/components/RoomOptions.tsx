import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import OTPInput from './OTPInput';
import Button from './Button';

interface RoomOptionsProps {
    onCreateRoom: (roomId: string) => void;
    onJoinRoom: (roomId: string) => void;
    isConnecting?: boolean;
}

const generateRoomCode = (): string => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
};

const RoomOptions: React.FC<RoomOptionsProps> = ({
    onCreateRoom,
    onJoinRoom,
    isConnecting = false,
}) => {
    const [mode, setMode] = useState<'select' | 'create' | 'join'>('select');
    const [generatedCode, setGeneratedCode] = useState('');
    const [joinCode, setJoinCode] = useState('');
    const [copied, setCopied] = useState(false);

    const handleCreateRoom = () => {
        const code = generateRoomCode();
        setGeneratedCode(code);
        setMode('create');
    };

    const handleCopyCode = async () => {
        await navigator.clipboard.writeText(generatedCode);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    const handleConnect = () => {
        if (mode === 'create') {
            onCreateRoom(generatedCode);
        } else {
            onJoinRoom(joinCode);
        }
    };

    const handleBack = () => {
        setMode('select');
        setGeneratedCode('');
        setJoinCode('');
    };

    return (
        <div className="w-full">
            <AnimatePresence mode="wait">
                {mode === 'select' && (
                    <motion.div
                        key="select"
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -20 }}
                        transition={{ duration: 0.3 }}
                        className="space-y-4"
                    >
                        {/* Create Room Option */}
                        <motion.button
                            onClick={handleCreateRoom}
                            className="w-full glass-card p-6 text-left group cursor-pointer"
                            whileHover={{ scale: 1.02 }}
                            whileTap={{ scale: 0.98 }}
                        >
                            <div className="flex items-center gap-4">
                                <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-cyan-500 to-emerald-500 flex items-center justify-center">
                                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                                        <path d="M12 5V19M5 12H19" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                                    </svg>
                                </div>
                                <div className="flex-1">
                                    <h3 className="text-lg font-semibold text-white mb-1">Create Room</h3>
                                    <p className="text-sm text-white/50">Generate a code and share with others</p>
                                </div>
                                <svg
                                    className="w-5 h-5 text-white/30 group-hover:text-white/60 transition-colors"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                >
                                    <path d="M9 18L15 12L9 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                                </svg>
                            </div>
                        </motion.button>

                        {/* Join Room Option */}
                        <motion.button
                            onClick={() => setMode('join')}
                            className="w-full glass-card p-6 text-left group cursor-pointer"
                            whileHover={{ scale: 1.02 }}
                            whileTap={{ scale: 0.98 }}
                        >
                            <div className="flex items-center gap-4">
                                <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-purple-500 to-violet-500 flex items-center justify-center">
                                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                                        <path d="M15 3H19C20.1046 3 21 3.89543 21 5V9M9 21H5C3.89543 21 3 20.1046 3 19V15M21 15V19C21 20.1046 20.1046 21 19 21H15M3 9V5C3 3.89543 3.89543 3 5 3H9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                                    </svg>
                                </div>
                                <div className="flex-1">
                                    <h3 className="text-lg font-semibold text-white mb-1">Join Room</h3>
                                    <p className="text-sm text-white/50">Enter a code to connect with peer</p>
                                </div>
                                <svg
                                    className="w-5 h-5 text-white/30 group-hover:text-white/60 transition-colors"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                >
                                    <path d="M9 18L15 12L9 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                                </svg>
                            </div>
                        </motion.button>
                    </motion.div>
                )}

                {mode === 'create' && (
                    <motion.div
                        key="create"
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -20 }}
                        transition={{ duration: 0.3 }}
                        className="space-y-6"
                    >
                        <button
                            onClick={handleBack}
                            className="flex items-center gap-2 text-white/50 hover:text-white transition-colors"
                        >
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                                <path d="M15 18L9 12L15 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                            Back
                        </button>

                        <div className="glass-card-static p-6 text-center">
                            <p className="text-white/50 text-sm mb-4">Share this code with your peer</p>

                            <motion.div
                                className="flex items-center justify-center gap-2 mb-4"
                                initial={{ scale: 0.8 }}
                                animate={{ scale: 1 }}
                                transition={{ type: 'spring', stiffness: 300 }}
                            >
                                {generatedCode.split('').map((char, i) => (
                                    <motion.span
                                        key={i}
                                        className="w-12 h-14 flex items-center justify-center text-2xl font-bold bg-white/5 border border-white/10 rounded-lg text-white"
                                        initial={{ opacity: 0, y: 10 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        transition={{ delay: i * 0.05 }}
                                    >
                                        {char}
                                    </motion.span>
                                ))}
                            </motion.div>

                            <Button
                                variant="ghost"
                                onClick={handleCopyCode}
                                icon={
                                    copied ? (
                                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                                            <path d="M20 6L9 17L4 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                                        </svg>
                                    ) : (
                                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                                            <rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" strokeWidth="2" />
                                            <path d="M5 15H4C2.89543 15 2 14.1046 2 13V4C2 2.89543 2.89543 2 4 2H13C14.1046 2 15 2.89543 15 4V5" stroke="currentColor" strokeWidth="2" />
                                        </svg>
                                    )
                                }
                            >
                                {copied ? 'Copied!' : 'Copy Code'}
                            </Button>
                        </div>

                        <Button
                            variant="primary"
                            fullWidth
                            onClick={handleConnect}
                            loading={isConnecting}
                        >
                            Start Waiting for Peer
                        </Button>
                    </motion.div>
                )}

                {mode === 'join' && (
                    <motion.div
                        key="join"
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -20 }}
                        transition={{ duration: 0.3 }}
                        className="space-y-6"
                    >
                        <button
                            onClick={handleBack}
                            className="flex items-center gap-2 text-white/50 hover:text-white transition-colors"
                        >
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                                <path d="M15 18L9 12L15 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                            Back
                        </button>

                        <div className="glass-card-static p-6 text-center">
                            <p className="text-white/50 text-sm mb-6">Enter the room code</p>

                            <OTPInput
                                value={joinCode}
                                onChange={setJoinCode}
                                length={6}
                            />
                        </div>

                        <Button
                            variant="primary"
                            fullWidth
                            onClick={handleConnect}
                            loading={isConnecting}
                            disabled={joinCode.length !== 6}
                        >
                            Join Room
                        </Button>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
};

export default RoomOptions;
