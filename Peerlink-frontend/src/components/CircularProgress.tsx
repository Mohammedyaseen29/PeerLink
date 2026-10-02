import { Check } from "lucide-react";

interface CircularProgressProps {
    progress: number;
    size?: number;
    strokeWidth?: number;
    className?: string;
    showPercentage?: boolean;
    ariaLabel?: string;
    status?: 'sending' | 'receiving' | 'paused' | 'pending' | 'sent' | 'failed' ;
}

export function CircularProgress({
    progress,
    size = 52,
    strokeWidth = 4,
    className = "",
    showPercentage = true,
    ariaLabel = "Transfer progress",
    status = "sending",
}:CircularProgressProps) {
    const margin = 4; 
    const svgSize = size + margin;
    const center = svgSize / 2;
    
    const radius = (size - strokeWidth) / 2;
    const circumference = radius * 2 * Math.PI;
    const offset = circumference - (progress / 100) * circumference;

    const statusColors = {
        sending: "var(--progress-sending, #f59e0b)",
        receiving: "var(--progress-receiving, #10b981)",
        paused: "var(--progress-paused, #6b7280)",
        pending: "var(--progress-pending, #6366f1)",
        sent: "var(--progress-sent, #22c55e)",
        failed: "var(--progress-failed, var(--danger, #fca5a5))",
    };

    const boundedProgress = Math.max(0, Math.min(100, Math.round(progress)));
    const isComplete = status === "sent";

    return (
        <div 
            className={`circular-progress ${className}`} 
            role="progressbar"
            aria-label={ariaLabel}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={boundedProgress}
            aria-valuetext={`${boundedProgress}% complete`}
            style={{ 
                width: size, 
                height: size, 
                display: 'flex', 
                alignItems: 'center', 
                justifyContent: 'center',
                position: 'relative'
            }}
        >
            <svg 
                width={svgSize} 
                height={svgSize} 
                viewBox={`0 0 ${svgSize} ${svgSize}`}
                style={{ 
                    position: 'absolute',
                    overflow: 'visible' 
                }}
            >
                {/* Background circle */}
                <circle
                    className="progress-bg"
                    cx={center}
                    cy={center}
                    r={radius}
                    fill="none"
                    strokeWidth={strokeWidth}
                    stroke="rgba(255, 255, 255, 0.1)" 
                />
                {/* Progress circle */}
                <circle
                    className="progress-ring"
                    cx={center}
                    cy={center}
                    r={radius}
                    fill="none"
                    strokeWidth={strokeWidth}
                    strokeDasharray={circumference}
                    strokeDashoffset={offset}
                    strokeLinecap="round"
                    style={{
                        stroke: statusColors[status as keyof typeof statusColors],
                        transform: "rotate(-90deg)",
                        transformOrigin: "center",
                        transition: "stroke-dashoffset 0.3s ease-out",
                    }}
                />
            </svg>
            {isComplete ? (
                <div style={{
                    width: size * 0.5,
                    height: size * 0.5,
                    borderRadius: '50%',
                    backgroundColor: statusColors.sent,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center'
                }}>
                    <Check size={size * 0.35} color="white" strokeWidth={3} />
                </div>
            ) : showPercentage && (
                <span className="progress-text" style={{ zIndex: 1, fontSize: '12px', fontWeight: 'bold' }}>
                    {Math.round(progress)}%
                </span>
            )}
        </div>
    );
}
