import { Wifi, Globe, Server, WifiOff, LoaderCircle } from "lucide-react";
import type { ConnectionType } from "../types";

interface ConnectionIndicatorProps {
    connected: boolean;
    connectionType: ConnectionType;
    status?: "idle" | "connecting" | "waiting" | "negotiating" | "offline" | "full";
}

const connectionConfig = {
    disconnected: {
        icon: WifiOff,
        label: "Disconnected",
        color: "indicator-disconnected",
        description: "Not connected to any peer",
    },
    waiting: {
        icon: LoaderCircle,
        label: "Waiting for peer",
        color: "indicator-p2p",
        description: "Room is ready for another peer",
    },
    connecting: {
        icon: LoaderCircle,
        label: "Connecting",
        color: "indicator-p2p",
        description: "Connecting to the signaling room",
    },
    negotiating: {
        icon: LoaderCircle,
        label: "Connecting peer",
        color: "indicator-p2p",
        description: "Establishing the peer connection",
    },
    offline: {
        icon: WifiOff,
        label: "Offline",
        color: "indicator-disconnected",
        description: "Signaling is unavailable; stored files remain accessible",
    },
    full: {
        icon: WifiOff,
        label: "Room full",
        color: "indicator-disconnected",
        description: "Rooms support up to two people",
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

export function ConnectionIndicator({ connected, connectionType, status }: ConnectionIndicatorProps) {
    const config = connected ? connectionConfig[connectionType] : connectionConfig[status && status !== "idle" ? status : "disconnected"];
    const Icon = config.icon;

    return (
        <div className={`connection-indicator ${config.color}`} title={config.description}>
            <Icon size={16} className={config.icon === LoaderCircle ? "room-status-spinner" : undefined} />
            <span>{config.label}</span>
        </div>
    );
}
