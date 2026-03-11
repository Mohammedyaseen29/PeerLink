export type AvatarDef = {
    id: string;
    name: string;
    color: string;
    bgColor: string;
    emoji: string;
};

export const AVATARS: AvatarDef[] = [
    { id: "blob-coral",  name: "Nova",     color: "#FF6B6B", bgColor: "#FF6B6B22", emoji: "👾" },
    { id: "blob-mint",   name: "Orbit",    color: "#51CF66", bgColor: "#51CF6622", emoji: "👽" },
    { id: "blob-sky",    name: "Echo",     color: "#339AF0", bgColor: "#339AF022", emoji: "💀" },
    { id: "blob-violet", name: "Vortex",   color: "#CC5DE8", bgColor: "#CC5DE822", emoji: "👿" },
    { id: "blob-amber",  name: "Phantom",  color: "#FF922B", bgColor: "#FF922B22", emoji: "👻" },
    { id: "blob-cyan",   name: "Cipher",   color: "#22B8CF", bgColor: "#22B8CF22", emoji: "🤖" },
    { id: "blob-rose",   name: "Blaze",    color: "#F06595", bgColor: "#F0659522", emoji: "👹" },
    { id: "blob-lime",   name: "Pulse",    color: "#94D82D", bgColor: "#94D82D22", emoji: "💩" },
    { id: "blob-indigo", name: "Nebula",   color: "#5C7CFA", bgColor: "#5C7CFA22", emoji: "🐹" },
    { id: "blob-peach",  name: "Halo",     color: "#FFA8A8", bgColor: "#FFA8A822", emoji: "🐼" },
    { id: "blob-teal",   name: "Zenith",   color: "#20C997", bgColor: "#20C99722", emoji: "🦁" },
    { id: "blob-gold",   name: "Solstice", color: "#FAB005", bgColor: "#FAB00522", emoji: "🐯" },
];

export function getAvatarById(id: string): AvatarDef {
    return AVATARS.find(a => a.id === id) || AVATARS[0];
}

export function getRandomAvatar(): AvatarDef {
    return AVATARS[Math.floor(Math.random() * AVATARS.length)];
}
