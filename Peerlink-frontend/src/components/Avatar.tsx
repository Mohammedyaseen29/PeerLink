import { getAvatarById } from "./avatars";
import type { CSSProperties } from "react";
import { AvatarCharacter } from "./AvatarCharacter";
import "./avatar.css";

export type AvatarSize = "xs" | "sm" | "md" | "lg" | "xl";

interface AvatarProps {
    avatarId: string;
    size?: AvatarSize;
    className?: string;
}

export function Avatar({ avatarId, size = "md", className = "" }: AvatarProps) {
    const avatar = getAvatarById(avatarId);
    const sizeClass = `avatar-blob-${size}`;

    return (
        <div
            className={`avatar-blob character-avatar ${sizeClass} ${className}`}
            style={{ "--avatar-color": avatar.color, "--avatar-bg": avatar.bgColor } as CSSProperties}
            title={avatar.name}
            role="img"
            aria-label={`${avatar.name} avatar`}
            data-avatar-id={avatar.id}
        >
            <AvatarCharacter avatar={avatar} />
        </div>
    );
}
