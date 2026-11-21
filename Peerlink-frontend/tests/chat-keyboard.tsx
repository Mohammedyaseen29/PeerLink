import { useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatPanel } from "../src/components/ChatPanel";
import type { ChatMessage } from "../src/types";
import "../src/index.css";

// Model the keyboard changing only the visual viewport, leaving the page's
// layout height untouched. Resizing the browser window alone misses this bug.
class KeyboardViewport extends EventTarget {
    height = window.innerHeight;
    offsetTop = 0;
    offsetLeft = 0;
    get width() { return window.innerWidth; }
    setArea(height: number, offsetTop: number) {
        this.height = height;
        this.offsetTop = offsetTop;
        this.dispatchEvent(new Event("resize"));
        this.dispatchEvent(new Event("scroll"));
    }
}
const viewport = new KeyboardViewport();
Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
const initialMessages: ChatMessage[] = Array.from({ length: 24 }, (_, index) => ({
    id: `fixture-${index}`, senderId: index % 2 ? "self" : "peer", senderName: index % 2 ? "You" : "Peer",
    content: `Test message ${index + 1}`, timestamp: Date.now() - (24 - index) * 60_000, status: "delivered",
}));

function Harness() {
    const [mode, setMode] = useState<"closed" | "open" | "panned">("closed");
    const [chatOpen, setChatOpen] = useState(true);
    const [messages, setMessages] = useState(initialMessages);
    const [area, setArea] = useState({ height: window.innerHeight - 48, top: 0 });
    useLayoutEffect(() => {
        const update = () => {
            const top = mode === "panned" ? 52 : 0;
            const height = Math.max(180, window.innerHeight - (mode === "closed" ? 48 : 310) - top);
            viewport.setArea(height, top);
            setArea({ height, top });
        };
        update();
        window.addEventListener("resize", update);
        return () => window.removeEventListener("resize", update);
    }, [mode]);
    return <>
        <ChatPanel isOpen={chatOpen} onClose={() => setChatOpen(false)} messages={messages} selfPeerId="self" username="You" avatar="blob-lime" roomId="keyboard-regression" connected onSendMessage={content => {
            setMessages(current => [...current, { id: crypto.randomUUID(), senderId: "self", senderName: "You", content, timestamp: Date.now(), status: "sent" }]);
        }} />
        <div aria-label="Keyboard simulation" data-visible-height={area.height} data-visible-top={area.top} style={{ position: "fixed", inset: "auto 0 0", zIndex: 300, height: mode === "closed" ? 48 : 310, padding: 4, background: "#353c33", borderTop: "1px solid #829077" }}>
            <div style={{ display: "flex", gap: 4 }}>
                {([['open', 'Open keyboard'], ['panned', 'Pan viewport'], ['closed', 'Close keyboard']] as const).map(([value, label]) => <button key={value} onPointerDown={event => event.preventDefault()} onClick={() => setMode(value)} style={{ flex: 1, minHeight: 40, fontSize: 12 }}>{label}</button>)}
                {!chatOpen && <button onClick={() => setChatOpen(true)}>Reopen chat</button>}
            </div>
            {mode !== "closed" && <p style={{ margin: "24px 8px", fontSize: 14 }}>Simulated keyboard area. The composer must stay above this area.</p>}
        </div>
    </>;
}

createRoot(document.getElementById("root")!).render(<Harness />);
