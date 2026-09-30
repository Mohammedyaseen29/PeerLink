import { Download, Clock } from "lucide-react";
import type { ReceivingFile } from "../types";
import { formatBytes, formatTime, calculateETA } from "../utils/helpers";
import { CircularProgress } from "./CircularProgress";

interface ReceiveProgressProps {
    receivings: ReceivingFile[];
}

export function ReceiveProgress({ receivings }: ReceiveProgressProps) {
    if (receivings.length === 0) return null;
    return (
        <section className="active-receivings" aria-label="Incoming transfers">
            {receivings.map((receiving) => {
                const { eta, speed } = calculateETA(receiving.bytesReceived, receiving.size, receiving.startTime);
                return (
                    <div className="receive-progress glass-card" key={`${receiving.peerId}:${receiving.fileId}`}>
                        <div className="receive-header">
                            <Download size={18} className="receive-icon" />
                            <span className="receive-title">Receiving from {receiving.peerName}</span>
                        </div>
                        <div className="receive-content">
                            <CircularProgress progress={receiving.progress} size={56} strokeWidth={4} status="receiving" />
                            <div className="receive-info">
                                <span className="file-name">{receiving.name}</span>
                                <div className="receive-meta">
                                    <span className="file-size">{formatBytes(receiving.bytesReceived)} / {formatBytes(receiving.size)}</span>
                                    {speed > 0 && <><span className="separator">•</span><span className="transfer-speed">{formatBytes(speed)}/s</span></>}
                                </div>
                                {eta > 0 && eta !== Infinity && <div className="eta"><Clock size={14} /><span>~{formatTime(eta)} remaining</span></div>}
                            </div>
                        </div>
                    </div>
                );
            })}
        </section>
    );
}
