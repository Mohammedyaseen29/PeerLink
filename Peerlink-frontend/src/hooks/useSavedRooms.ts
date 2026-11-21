import { useCallback, useEffect, useRef, useState } from "react";
import { getStoredFiles, type FileMetadata } from "../ProgressDB";
import { collectSavedRooms, type SavedRoom } from "../utils/savedRooms";

export function useSavedRooms(receivedFiles: FileMetadata[], inRoom: boolean) {
    const [rooms, setRooms] = useState<SavedRoom[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const generation = useRef(0);
    const refresh = useCallback(async () => {
        const request = ++generation.current;
        try {
            const files = await getStoredFiles();
            if (request !== generation.current) return;
            setRooms(collectSavedRooms(files));
            setError(null);
        } catch {
            if (request === generation.current) setError("Your saved rooms couldn’t be loaded. Try again.");
        } finally {
            if (request === generation.current) setLoading(false);
        }
    }, []);
    useEffect(() => {
        void refresh();
        return () => { generation.current++; };
    }, [refresh, receivedFiles, inRoom]);
    useEffect(() => {
        const onFocus = () => { void refresh(); };
        const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
        window.addEventListener("focus", onFocus);
        document.addEventListener("visibilitychange", onVisible);
        return () => {
            window.removeEventListener("focus", onFocus);
            document.removeEventListener("visibilitychange", onVisible);
        };
    }, [refresh]);
    return { rooms, loading, error, refresh };
}
