import { RefreshCw, Users } from "lucide-react";
import type { PeerMember } from "../types";
import { Avatar } from "./Avatar";

interface GroupMembersProps {
    members: PeerMember[];
    username: string;
    avatar: string;
    selfOnline?: boolean;
    onRetryPeer?: (peerId: string) => void;
}

export function GroupMembers({ members, username, avatar, selfOnline = true, onRetryPeer }: GroupMembersProps) {
    return (
        <section className="group-members glass-card" aria-label="Room members">
            <div className="group-members-heading">
                <h2 className="section-title"><Users size={17} /> Room members</h2>
            </div>

            <div className="member-list">
                <div className="member-row member-self">
                    <Avatar avatarId={avatar} size="sm" />
                    <div className="member-copy"><strong>{username} (you)</strong><span>Your device</span></div>
                    <span className={`member-state ${selfOnline ? "member-state-online" : "member-state-offline"}`}>
                        {selfOnline ? "Here" : "Offline"}
                    </span>
                </div>

                {members.map((member) => {
                    const isConnected = member.status === "connected";
                    const statusText = isConnected ? "Ready to receive" : member.status === "disconnected" ? "Connection lost" : "Connecting";
                    const canRetry = member.status === "disconnected" && member.supportsReconnect === true && selfOnline && Boolean(onRetryPeer);

                    return (
                        <div className="member-row member-peer" key={member.peerId}>
                            <Avatar avatarId={member.avatar ?? "blob-coral"} size="sm" />
                            <div className="member-copy"><strong>{member.username}</strong><span>{statusText}</span></div>
                            {canRetry ? (
                                <button
                                    type="button"
                                    className="member-retry-btn"
                                    onClick={() => onRetryPeer?.(member.peerId)}
                                    aria-label={`Retry connection to ${member.username}`}
                                >
                                    <RefreshCw size={14} aria-hidden="true" />
                                    <span>Retry</span>
                                </button>
                            ) : (
                                <span className={`member-state member-state-${member.status}`}>
                                    {isConnected ? "Here" : member.status === "disconnected" ? "Offline" : "Connecting"}
                                </span>
                            )}
                        </div>
                    );
                })}
            </div>
        </section>
    );
}
