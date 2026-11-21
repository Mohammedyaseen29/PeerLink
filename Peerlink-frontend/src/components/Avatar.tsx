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
                backgroundColor: `color-mix(in srgb, ${avatar.color} 12%, white)`,
                color: `color-mix(in srgb, ${avatar.color} 35%, #1b2638)`,
            }}
            title={avatar.name}
        >
            <span aria-hidden="true">{avatar.name.slice(0, 1)}</span>
        </div>
    );
}
