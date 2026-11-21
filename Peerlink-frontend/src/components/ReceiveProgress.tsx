import { Clock, Download } from "lucide-react";
import type { ReceivingFile } from "../types";
import { formatBytes, formatTime, calculateETA } from "../utils/helpers";
import "./transfer-workspace.css";

interface ReceiveProgressProps {
    receivings: ReceivingFile[];
}

export function ReceiveProgress({ receivings }: ReceiveProgressProps) {
    if (receivings.length === 0) return null;
    const activeReceivings = receivings.filter(file => file.status !== "failed");
    const totalBytes = activeReceivings.reduce((total, file) => total + file.size, 0);
    const receivedBytes = activeReceivings.reduce((total, file) => total + file.bytesReceived, 0);
    const progress = totalBytes > 0 ? Math.min(100, receivedBytes / totalBytes * 100) : 0;
    const totalSpeed = activeReceivings.reduce((total, file) => total + calculateETA(file.bytesReceived, file.size, file.startTime).speed, 0);
    const overallEta = totalSpeed > 0 ? Math.max(0, (totalBytes - receivedBytes) / totalSpeed) : Infinity;

    return (
        <section className="active-receivings" aria-label="Incoming transfers">
            {activeReceivings.length > 0 && <div className="receive-overall glass-card">
                <div className="receive-overall-heading">
                    <span className="section-title">Receiving files</span>
                    <span>{formatBytes(receivedBytes)} of {formatBytes(totalBytes)}</span>
                </div>
                <progress className="transfer-progress overall-progress" value={progress} max={100} aria-label="Overall receiving progress" />
                <div className="receive-overall-meta">
                    {totalSpeed > 0 && <span>{formatBytes(totalSpeed)}/s</span>}
                    {overallEta !== Infinity && overallEta > 0 && <span><Clock size={13} aria-hidden="true" />{formatTime(overallEta)} left</span>}
                </div>
            </div>}

            {receivings.map(receiving => {
                const failed = receiving.status === "failed";
                const { eta, speed } = failed
                    ? { eta: Infinity, speed: 0 }
                    : calculateETA(receiving.bytesReceived, receiving.size, receiving.startTime);
                const value = Math.min(99, Math.max(0, receiving.progress));
                return (
                    <article className={`receive-progress glass-card ${failed ? "receive-failed" : ""}`} key={`${receiving.peerId}:${receiving.fileId}`}>
                        <div className="receive-header">
                            <Download size={18} className="receive-icon" aria-hidden="true" />
                            <span className="receive-title">{failed ? "Transfer from" : "Receiving from"} {receiving.peerName}</span>
                            <span className="receive-status" role="status">{failed ? "Failed" : "Receiving"}</span>
                        </div>
                        <div className="receive-content">
                            <div className="receive-info">
                                <span className="file-name" title={receiving.name}>{receiving.name}</span>
                                <div className="receive-meta">
                                    <span>{formatBytes(receiving.bytesReceived)} / {formatBytes(receiving.size)}</span>
                                    {!failed && speed > 0 && <span>{formatBytes(speed)}/s</span>}
                                    {!failed && eta > 0 && eta !== Infinity && <span><Clock size={13} aria-hidden="true" />~{formatTime(eta)} left</span>}
                                </div>
                                {failed && <p className="receive-error" role="alert">{receiving.error || "The transfer stopped before finishing. Ask the sender to retry."}</p>}
                                <progress className="transfer-progress file-progress" value={value} max={100} aria-label={`Receiving ${receiving.name}: ${value}%`} />
                            </div>
                        </div>
                    </article>
                );
            })}
        </section>
    );
}
