import { useState } from "react";
import { ChevronDown, ChevronUp, Terminal } from "lucide-react";

interface LogPanelProps {
    logs: string[];
}

export function LogPanel({ logs }: LogPanelProps) {
    const [isExpanded, setIsExpanded] = useState(false);

    return (
        <div className={`log-panel glass-card ${isExpanded ? "expanded" : "collapsed"}`}>
            <button
                className="log-header"
                onClick={() => setIsExpanded(!isExpanded)}
            >
                <div className="log-title">
                    <Terminal size={16} />
                    <span>Activity Log</span>
                    <span className="log-count">{logs.length}</span>
                </div>
                {isExpanded ? <ChevronDown size={20} /> : <ChevronUp size={20} />}
            </button>

            {isExpanded && (
                <div className="log-content">
                    {logs.length === 0 ? (
                        <p className="log-empty">No activity yet</p>
                    ) : (
                        logs.map((log, index) => (
                            <div key={index} className="log-entry">
                                {log}
                            </div>
                        ))
                    )}
                </div>
            )}
        </div>
    );
}
