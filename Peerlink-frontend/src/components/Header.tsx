import { Link2 } from "lucide-react";

export function Header() {
    return (
        <header className="header">
            <div className="header-content">
                <div className="logo">
                    <div className="logo-icon">
                        <Link2 size={28} strokeWidth={2.5} />
                    </div>
                    <h1 className="logo-text">PeerLink</h1>
                </div>
                <p className="tagline">Secure P2P File Transfer</p>
            </div>
        </header>
    );
}
