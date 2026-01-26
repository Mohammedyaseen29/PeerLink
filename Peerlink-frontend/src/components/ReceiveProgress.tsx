import { Download, Clock } from "lucide-react";
import type { ReceivingFile } from "../types";
import { formatBytes, formatTime, calculateETA } from "../utils/helpers";
import { CircularProgress } from "./CircularProgress";

interface ReceiveProgressProps {
    receiving: ReceivingFile;
}

export function ReceiveProgress({ receiving }: ReceiveProgressProps) {
    const { eta, speed } = calculateETA(
        receiving.bytesReceived,
        receiving.size,
        receiving.startTime
    );

    return (
        <div className="receive-progress glass-card">
            <div className="receive-header">
                <Download size={20} className="receive-icon" />
                <span className="receive-title">Receiving File</span>
            </div>

            <div className="receive-content">
                <CircularProgress
                    progress={receiving.progress}
                    size={72}
                    strokeWidth={5}
                    status="receiving"
                />

                <div className="receive-info">
                    <span className="file-name">{receiving.name}</span>
                    <div className="receive-meta">
                        <span className="file-size">
                            {formatBytes(receiving.bytesReceived)} / {formatBytes(receiving.size)}
                        </span>
                        {speed > 0 && (
                            <>
                                <span className="separator">•</span>
                                <span className="transfer-speed">{formatBytes(speed)}/s</span>
                            </>
                        )}
                    </div>
                    {eta > 0 && eta !== Infinity && (
                        <div className="eta">
                            <Clock size={14} />
                            <span>~{formatTime(eta)} remaining</span>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
