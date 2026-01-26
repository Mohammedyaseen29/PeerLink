interface CircularProgressProps {
    progress: number;
    size?: number;
    strokeWidth?: number;
    className?: string;
    showPercentage?: boolean;
    status?: "sending" | "paused" | "pending" | "sent" | "receiving" | "failed";
}

export function CircularProgress({
    progress,
    size = 52,
    strokeWidth = 4,
    className = "",
    showPercentage = true,
    status = "sending",
}: CircularProgressProps) {
    const radius = (size - strokeWidth) / 2;
    const circumference = radius * 2 * Math.PI;
    const offset = circumference - (progress / 100) * circumference;

    const statusColors = {
        sending: "var(--progress-sending)",
        receiving: "var(--progress-receiving)",
        paused: "var(--progress-paused)",
        pending: "var(--progress-pending)",
        sent: "var(--progress-sent)",
    };

    return (
        <div className={`circular-progress ${className}`} style={{ width: size, height: size }}>
            <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
                {/* Background circle */}
                <circle
                    className="progress-bg"
                    cx={size / 2}
                    cy={size / 2}
                    r={radius}
                    fill="none"
                    strokeWidth={strokeWidth}
                />
                {/* Progress circle */}
                <circle
                    className="progress-ring"
                    cx={size / 2}
                    cy={size / 2}
                    r={radius}
                    fill="none"
                    strokeWidth={strokeWidth}
                    strokeDasharray={circumference}
                    strokeDashoffset={offset}
                    strokeLinecap="round"
                    style={{
                        stroke: statusColors[status],
                        transform: "rotate(-90deg)",
                        transformOrigin: "50% 50%",
                        transition: "stroke-dashoffset 0.3s ease-out",
                    }}
                />
            </svg>
            {showPercentage && (
                <span className="progress-text">{Math.round(progress)}%</span>
            )}
        </div>
    );
}
