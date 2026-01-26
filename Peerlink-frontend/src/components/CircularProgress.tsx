export function CircularProgress({
    progress,
    size = 52,
    strokeWidth = 4,
    className = "",
    showPercentage = true,
    status = "sending",
}: CircularProgressProps) {
    // 1. We create a slightly larger SVG area so the stroke never touches the "walls"
    const margin = 4; 
    const svgSize = size + margin;
    const center = svgSize / 2;
    
    // 2. The radius stays based on the original intended size
    const radius = (size - strokeWidth) / 2;
    const circumference = radius * 2 * Math.PI;
    const offset = circumference - (progress / 100) * circumference;

    const statusColors = {
        sending: "var(--progress-sending, #f59e0b)", // Added hex fallback
        receiving: "var(--progress-receiving, #10b981)",
        paused: "var(--progress-paused, #6b7280)",
        pending: "var(--progress-pending, #6366f1)",
        sent: "var(--progress-sent, #3b82f6)",
    };

    return (
        <div 
            className={`circular-progress ${className}`} 
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
            {showPercentage && (
                <span className="progress-text" style={{ zIndex: 1, fontSize: '12px', fontWeight: 'bold' }}>
                    {Math.round(progress)}%
                </span>
            )}
        </div>
    );
}