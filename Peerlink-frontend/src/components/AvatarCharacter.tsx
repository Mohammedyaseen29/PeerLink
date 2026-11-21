import type { AvatarDef } from "./avatars";

const ink = "#202a25";
const paper = "#f7f5e9";

function Face({ y = 42, happy = false }: { y?: number; happy?: boolean }) {
    return (
        <g className="avatar-face" transform={`translate(0 ${y - 42})`}>
            <g className="avatar-eyes">
                <ellipse cx="31" cy="39" rx="5.2" ry="6.6" fill={paper} />
                <ellipse cx="49" cy="39" rx="5.2" ry="6.6" fill={paper} />
                <ellipse cx="32.5" cy="40" rx="2.4" ry="3.4" fill={ink} />
                <ellipse cx="50.5" cy="40" rx="2.4" ry="3.4" fill={ink} />
            </g>
            <path d={happy ? "M35 49Q40 56 45 49Z" : "M36 50Q40 53 44 50"} fill={happy ? ink : "none"} stroke={ink} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </g>
    );
}

/** Small, shared vector portraits: the picker and every profile use this artwork. */
export function AvatarCharacter({ avatar }: { avatar: AvatarDef }) {
    const fill = avatar.color;
    const character = (() => {
        switch (avatar.character) {
            case "spark": return <>
                <path d="M40 7Q43 7 46 22L59 17Q63 16 62 21L59 33L71 38Q76 41 70 44L58 49L61 63Q62 68 57 65L45 59L42 72Q40 77 37 71L33 59L18 65Q14 67 16 61L21 48L9 44Q4 41 10 38L22 33L18 19Q17 14 22 17L34 22L37 10Q38 7 40 7Z" fill={fill} />
                <Face happy />
            </>;
            case "planet": return <>
                <ellipse cx="40" cy="42" rx="36" ry="11" transform="rotate(-25 40 42)" fill="none" stroke="#d9c893" strokeWidth="6" />
                <circle cx="40" cy="40" r="25" fill={fill} />
                <path d="M23 26Q30 17 43 19M53 58L57 54" fill="none" stroke={paper} strokeOpacity=".4" strokeWidth="3" strokeLinecap="round" />
                <Face />
                <path d="M8 56Q23 63 57 43Q69 36 72 28" fill="none" stroke="#d9c893" strokeWidth="5" strokeLinecap="round" />
            </>;
            case "rabbit": return <>
                <path d="M23 35C8 9 25 0 31 16L38 34M44 32L49 12C54-3 68 6 59 34" fill={fill} />
                <path d="M24 16L29 31M54 12L50 30" stroke={paper} strokeOpacity=".55" strokeWidth="4" strokeLinecap="round" />
                <path d="M13 46C13 29 26 25 40 25S67 30 67 47C67 64 55 70 40 70S13 63 13 46Z" fill={fill} />
                <Face y={46} />
            </>;
            case "flower": return <>
                <g fill={fill}>
                    <ellipse cx="40" cy="23" rx="13" ry="16" /><ellipse cx="40" cy="57" rx="13" ry="16" />
                    <ellipse cx="24" cy="31" rx="16" ry="13" transform="rotate(30 24 31)" /><ellipse cx="56" cy="49" rx="16" ry="13" transform="rotate(30 56 49)" />
                    <ellipse cx="24" cy="49" rx="16" ry="13" transform="rotate(-30 24 49)" /><ellipse cx="56" cy="31" rx="16" ry="13" transform="rotate(-30 56 31)" />
                </g>
                <circle cx="40" cy="40" r="21" fill="#e9cc7d" /><Face happy />
            </>;
            case "ghost": return <>
                <path d="M15 41C15 7 65 7 65 41L68 66Q69 71 63 68L55 63L47 69L39 63L30 69L23 63L16 68Q11 72 12 65Z" fill={fill} />
                <path d="M21 32Q23 24 29 22" fill="none" stroke={paper} strokeWidth="3" strokeLinecap="round" />
                <Face y={43} />
            </>;
            case "robot": return <>
                <path d="M40 22V13" stroke={fill} strokeWidth="4" /><circle cx="40" cy="10" r="5" fill="#c4f55a" />
                <rect x="7" y="35" width="10" height="18" rx="5" fill={fill} /><rect x="63" y="35" width="10" height="18" rx="5" fill={fill} />
                <rect x="15" y="21" width="50" height="46" rx="15" fill={fill} />
                <rect x="22" y="29" width="36" height="24" rx="9" fill={ink} />
                <path d="M29 37V43M49 37V43" stroke="#c4f55a" strokeWidth="4" strokeLinecap="round" />
                <path d="M35 59H45" stroke={ink} strokeWidth="2" strokeLinecap="round" />
            </>;
            case "flame": return <>
                <path d="M40 7C40 24 59 20 55 38C60 37 63 32 62 28C77 49 63 71 40 71C14 71 3 49 21 29C19 41 25 42 25 35C24 20 36 17 40 7Z" fill={fill} />
                <path d="M32 68C22 61 28 50 34 46C33 55 44 52 44 45C57 57 51 69 42 70Z" fill="#f4c977" />
                <Face y={42} happy />
            </>;
            case "headphones": return <>
                <circle cx="40" cy="43" r="26" fill={fill} />
                <path d="M13 44V36C13 3 67 3 67 36V44" fill="none" stroke="#afbb9b" strokeWidth="7" />
                <path d="M13 43V36C13 3 67 3 67 36V43" fill="none" stroke={ink} strokeWidth="3" />
                <rect x="8" y="36" width="11" height="21" rx="5" fill={ink} /><rect x="61" y="36" width="11" height="21" rx="5" fill={ink} />
                <Face y={44} />
            </>;
            case "cat": return <>
                <path d="M15 43L16 12Q16 7 21 11L35 24H46L60 11Q65 7 65 13L66 43C72 64 55 70 40 70S9 63 15 43Z" fill={fill} />
                <path d="M22 18L24 30L31 27M59 18L50 27L58 30" fill="#e4b1c6" />
                <Face y={44} />
                <path d="M12 46L23 48M11 54L22 53M58 48L69 46M58 53L70 54" stroke={ink} strokeOpacity=".6" strokeWidth="1.6" strokeLinecap="round" />
            </>;
            case "cloud": return <>
                <path d="M20 61C0 59 2 36 17 33C14 14 36 10 44 22C57 11 73 25 66 38C85 49 73 67 60 63C53 75 37 69 34 63Q25 68 20 61Z" fill={fill} />
                <Face y={44} />
            </>;
            case "sprout": return <>
                <path d="M40 30V18" stroke={fill} strokeWidth="3" />
                <path d="M40 21C25 24 20 16 20 9C32 6 40 10 40 21ZM40 21C40 8 49 5 61 8C60 19 51 23 40 21Z" fill="#c4f55a" />
                <path d="M17 40C17 20 63 20 63 40L60 61C58 73 22 73 20 61Z" fill={fill} />
                <Face y={46} happy />
            </>;
            case "sun": return <>
                <g stroke={fill} strokeWidth="5" strokeLinecap="round">
                    <path d="M40 6V12M40 68V74M6 40H12M68 40H74M16 16L21 21M59 59L64 64M16 64L21 59M59 21L64 16" />
                </g>
                <circle cx="40" cy="40" r="23" fill={fill} /><Face happy />
            </>;
        }
    })();
    return <svg className="avatar-art" viewBox="0 0 80 80" fill="none" aria-hidden="true"><g className="avatar-character">{character}</g></svg>;
}
