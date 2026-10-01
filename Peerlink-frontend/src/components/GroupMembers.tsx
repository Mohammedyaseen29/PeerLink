import { Check, RefreshCw, Users } from "lucide-react";
import type { PeerMember } from "../types";
import { Avatar } from "./Avatar";

interface GroupMembersProps {
    members: PeerMember[];
    selectedPeerIds: string[];
    onSelectionChange: (peerIds: string[]) => void;
    username: string;
    avatar: string;
    selfOnline?: boolean;
    onRetryPeer?: (peerId: string) => void;
    maxPeers?: number;
}

export function GroupMembers({ members, selectedPeerIds, onSelectionChange, username, avatar, selfOnline = true,
    onRetryPeer, maxPeers = 4 }: GroupMembersProps) {
    const toggle = (member: PeerMember) => {
        const selected = selectedPeerIds.includes(member.peerId);
        if (member.status !== "connected" && !selected) return;
        const next = selected ? selectedPeerIds.filter((peerId) => peerId !== member.peerId) : [...selectedPeerIds, member.peerId];
        onSelectionChange(next);
    };

    return (
        <section className="group-members glass-card" aria-label="Room members">
            <div className="group-members-heading">
                <div>
                    <h2 className="section-title"><Users size={17} /> Room members</h2>
                    <p className="group-members-help">Choose who receives the next files you add.</p>
                </div>
                <span className="group-members-count">{selfOnline ? `${members.length + 1} / ${maxPeers}` : "Offline"}</span>
            </div>

            <div className="member-list">
                <div className="member-row member-self">
                    <Avatar avatarId={avatar} size="sm" />
                    <div className="member-copy"><strong>{username} (you)</strong><span>{selfOnline ? "Room member" : "Signaling disconnected"}</span></div>
                    <span className="member-state">{selfOnline ? "Here" : "Offline"}</span>
                </div>
                {members.map((member) => {
                    const isSelected = selectedPeerIds.includes(member.peerId);
                    const isConnected = member.status === "connected";
                    const statusText = isConnected ? "Ready to receive" : member.status === "disconnected" ? "Connection lost" : "Connecting…";
                    return (
                        <div className="member-entry" key={member.peerId}>
                            <button
                                type="button"
                                className={`member-row member-choice ${isSelected ? "selected" : ""}`}
                                onClick={() => toggle(member)}
                                disabled={!isConnected && !isSelected}
                                aria-pressed={isSelected}
                            >
                                <Avatar avatarId={member.avatar ?? "blob-coral"} size="sm" />
                                <span className="member-copy"><strong>{member.username}</strong><span>{statusText}</span></span>
                                <span className={`member-selection-mark ${isSelected ? "active" : ""}`} aria-hidden="true">
                                    {isSelected && <Check size={14} />}
                                </span>
                            </button>
                            {!isConnected && member.status === "disconnected" && member.supportsReconnect && selfOnline && onRetryPeer &&
                                <button type="button" className="room-status-retry" onClick={() => onRetryPeer(member.peerId)} aria-label={`Retry connection to ${member.username}`}>
                                    <RefreshCw size={14} /> Retry
                                </button>}
                        </div>
                    );
                })}
                {members.length === 0 && <p className="member-empty">Share the room ID to invite up to three people.</p>}
            </div>
            {members.length > 0 && <p className="group-members-selection">{selectedPeerIds.length} selected for the next files you add</p>}
        </section>
    );
}
