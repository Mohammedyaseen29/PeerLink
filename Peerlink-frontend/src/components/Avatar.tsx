import { getAvatarById } from "./avatars";

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
            className={`avatar-blob ${sizeClass} ${className}`}
            style={{
                backgroundColor: avatar.bgColor,
                color: avatar.color,
            }}
            title={avatar.name}
        >
            {avatar.emoji}
        </div>
    );
}
