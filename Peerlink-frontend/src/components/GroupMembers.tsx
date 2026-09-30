import { Check, Users } from "lucide-react";
import type { PeerMember } from "../types";
import { Avatar } from "./Avatar";

interface GroupMembersProps {
    members: PeerMember[];
    selectedPeerIds: string[];
    onSelectionChange: (peerIds: string[]) => void;
    username: string;
    avatar: string;
    maxPeers?: number;
}

export function GroupMembers({ members, selectedPeerIds, onSelectionChange, username, avatar, maxPeers = 4 }: GroupMembersProps) {
    const toggle = (member: PeerMember) => {
        if (member.status !== "connected") return;
        const next = selectedPeerIds.includes(member.peerId)
            ? selectedPeerIds.filter((peerId) => peerId !== member.peerId)
            : [...selectedPeerIds, member.peerId];
        onSelectionChange(next);
    };

    return (
        <section className="group-members glass-card" aria-label="Room members">
            <div className="group-members-heading">
                <div>
                    <h2 className="section-title"><Users size={17} /> Room members</h2>
                    <p className="group-members-help">Choose who receives the next files you add.</p>
                </div>
                <span className="group-members-count">{members.length + 1} / {maxPeers}</span>
            </div>

            <div className="member-list">
                <div className="member-row member-self">
                    <Avatar avatarId={avatar} size="sm" />
                    <div className="member-copy"><strong>{username} (you)</strong><span>Room member</span></div>
                    <span className="member-state">Here</span>
                </div>
                {members.map((member) => {
                    const isSelected = selectedPeerIds.includes(member.peerId);
                    const isConnected = member.status === "connected";
                    return (
                        <button
                            type="button"
                            key={member.peerId}
                            className={`member-row member-choice ${isSelected ? "selected" : ""}`}
                            onClick={() => toggle(member)}
                            disabled={!isConnected}
                            aria-pressed={isSelected}
                        >
                            <Avatar avatarId={member.avatar ?? "blob-coral"} size="sm" />
                            <span className="member-copy"><strong>{member.username}</strong><span>{isConnected ? "Ready to receive" : "Connecting…"}</span></span>
                            <span className={`member-selection-mark ${isSelected ? "active" : ""}`} aria-hidden="true">
                                {isSelected && <Check size={14} />}
                            </span>
                        </button>
                    );
                })}
                {members.length === 0 && <p className="member-empty">Share the room ID to invite up to three people.</p>}
            </div>
            {members.length > 0 && <p className="group-members-selection">{selectedPeerIds.length} selected for the next files you add</p>}
        </section>
    );
}
