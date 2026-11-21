interface BrandMarkProps {
    className?: string;
}

/** The original folded-file/transfer symbol, with fixed proportions. */
export function BrandMark({ className = "" }: BrandMarkProps) {
    return (
        <img
            className={`brand-mark ${className}`.trim()}
            src="/peerlink-mark.svg"
            width={32}
            height={32}
            alt=""
            aria-hidden="true"
            draggable={false}
        />
    );
}
