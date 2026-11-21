export type AvatarDef = {
    id: string;
    name: string;
    color: string;
    bgColor: string;
    character: "spark" | "planet" | "rabbit" | "flower" | "ghost" | "robot" | "flame" | "headphones" | "cat" | "cloud" | "sprout" | "sun";
    description: string;
};

export const AVATARS: AvatarDef[] = [
    { id: "blob-coral",  name: "Nova",     color: "#f58e7e", bgColor: "#342823", character: "spark", description: "A little spark. A lot of energy." },
    { id: "blob-mint",   name: "Orbit",    color: "#afd8ad", bgColor: "#25332b", character: "planet", description: "Always in your corner of the universe." },
    { id: "blob-sky",    name: "Echo",     color: "#9bc9ed", bgColor: "#24313b", character: "rabbit", description: "All ears. Ready for a good conversation." },
    { id: "blob-violet", name: "Vortex",   color: "#bfa7e8", bgColor: "#302b3a", character: "flower", description: "A happy little twist on the everyday." },
    { id: "blob-amber",  name: "Phantom",  color: "#e9ddba", bgColor: "#333126", character: "ghost", description: "Quietly here. Occasionally mischievous." },
    { id: "blob-cyan",   name: "Cipher",   color: "#9ad8d8", bgColor: "#223536", character: "robot", description: "Your friendly neighbourhood file enthusiast." },
    { id: "blob-rose",   name: "Blaze",    color: "#ed9aac", bgColor: "#38282f", character: "flame", description: "Warm heart. Full send." },
    { id: "blob-lime",   name: "Pulse",    color: "#c4f55a", bgColor: "#2a3520", character: "headphones", description: "Good files. Better playlists." },
    { id: "blob-indigo", name: "Nebula",   color: "#a6b2e9", bgColor: "#292e40", character: "cat", description: "Curious by nature. A night owl at heart." },
    { id: "blob-peach",  name: "Halo",     color: "#edbda1", bgColor: "#382d26", character: "cloud", description: "Taking the scenic route through the day." },
    { id: "blob-teal",   name: "Zenith",   color: "#89cbb0", bgColor: "#23372e", character: "sprout", description: "Small beginnings. Room to grow." },
    { id: "blob-gold",   name: "Solstice", color: "#e9cc7d", bgColor: "#373322", character: "sun", description: "A pocket-sized dose of sunshine." },
];

export function getAvatarById(id: string): AvatarDef {
    return AVATARS.find(a => a.id === id) || AVATARS[0];
}

export function getRandomAvatar(): AvatarDef {
    return AVATARS[Math.floor(Math.random() * AVATARS.length)];
}
