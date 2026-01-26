import { Wifi, Globe, Server, WifiOff } from "lucide-react";
import type { ConnectionType } from "../types";

interface ConnectionIndicatorProps {
    connected: boolean;
    connectionType: ConnectionType;
}

const connectionConfig = {
    disconnected: {
        icon: WifiOff,
        label: "Disconnected",
        color: "indicator-disconnected",
        description: "Not connected to any peer",
    },
    local: {
        icon: Wifi,
        label: "Local Network",
        color: "indicator-local",
        description: "Direct connection via local network",
    },
    p2p: {
        icon: Globe,
        label: "P2P Direct",
        color: "indicator-p2p",
        description: "Direct peer-to-peer connection",
    },
    relay: {
        icon: Server,
        label: "Relay (TURN)",
        color: "indicator-relay",
        description: "Connection via TURN relay server",
    },
};

export function ConnectionIndicator({ connected, connectionType }: ConnectionIndicatorProps) {
    const config = connected ? connectionConfig[connectionType] : connectionConfig.disconnected;
    const Icon = config.icon;

    return (
        <div className={`connection-indicator ${config.color}`} title={config.description}>
            <Icon size={16} />
            <span>{config.label}</span>
        </div>
    );
}
