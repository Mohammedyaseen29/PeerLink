import { useEffect, useRef, useState } from "react";
import { Camera, LoaderCircle, QrCode, RefreshCw, X } from "lucide-react";
import { parseRoomInvite, type RoomInvite } from "../utils/roomInvite";

const PRODUCTION_ORIGIN = "https://peer-link-rho.vercel.app";

type ScanStatus = "starting" | "scanning" | "error" | "joining";

function parseSupportedInvite(value: string): RoomInvite | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.origin !== window.location.origin && url.origin !== PRODUCTION_ORIGIN) return null;
    return parseRoomInvite(url.href);
  } catch {
    return null;
  }
}

function getCameraErrorMessage(error: unknown): string {
  const name = error && typeof error === "object" && "name" in error
    ? String(error.name)
    : String(error);
  if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") {
    return "Camera access was blocked. Allow camera access in your browser settings, then try again.";
  }
  if (name === "NotFoundError") {
    return "No camera was found on this device. You can enter the room ID manually.";
  }
  if (name.includes("Camera not found")) {
    return "Could not access a camera. Allow camera access and check that it is connected and not being used by another app, then try again.";
  }
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") {
    return "The camera is busy or unavailable. Close other apps using it, then try again.";
  }
  return "The camera could not be started. Check its permission and try again.";
}

interface RoomScanDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onScanned: (invite: RoomInvite) => void;
}

export function RoomScanDialog({ isOpen, onClose, onScanned }: RoomScanDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const videoViewportRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const onScannedRef = useRef(onScanned);
  const scanHandledRef = useRef(false);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<ScanStatus>("starting");
  const [scanError, setScanError] = useState<string | null>(null);

  onCloseRef.current = onClose;
  onScannedRef.current = onScanned;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!isOpen) {
      if (dialog.open) dialog.close();
      return;
    }

    if (!dialog.open) dialog.showModal();

    let destroyed = false;
    let scanner: { start: () => Promise<void>; destroy: () => void } | null = null;
    let video: HTMLVideoElement | null = null;
    scanHandledRef.current = false;
    setStatus("starting");
    setScanError(null);

    const stopSession = () => {
      if (destroyed) return;
      destroyed = true;
      const stream = video?.srcObject;
      if (typeof MediaStream !== "undefined" && stream instanceof MediaStream) {
        for (const track of stream.getTracks()) track.stop();
      }
      if (video) {
        video.pause();
        video.srcObject = null;
      }
      scanner?.destroy();
      video?.remove();
    };

    const cleanup = () => {
      stopSession();
      if (dialog.open) dialog.close();
    };

    const showCameraError = (message: string) => {
      stopSession();
      setScanError(message);
      setStatus("error");
    };

    if (!window.isSecureContext) {
      showCameraError("Camera scanning requires a secure connection (HTTPS). You can still enter the room ID manually.");
      return cleanup;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      showCameraError("This browser does not provide camera access. You can still enter the room ID manually.");
      return cleanup;
    }

    const activeVideo = document.createElement("video");
    activeVideo.className = "room-scan-video";
    activeVideo.autoplay = true;
    activeVideo.muted = true;
    activeVideo.playsInline = true;
    activeVideo.setAttribute("aria-hidden", "true");
    video = activeVideo;
    const viewport = videoViewportRef.current;
    if (!viewport) {
      showCameraError("The camera preview could not be opened. Close this window and try again.");
      return cleanup;
    }
    viewport.append(activeVideo);

    void import("qr-scanner").then(({ default: QrScanner }) => {
      if (destroyed) return;
      const activeScanner = new QrScanner(activeVideo, (result) => {
        if (destroyed || scanHandledRef.current) return;
        const invite = parseSupportedInvite(result.data);
        if (!invite) {
          setScanError("That QR code is not a supported PeerLink room invite. Try the sender’s Show QR code.");
          return;
        }

        scanHandledRef.current = true;
        setStatus("joining");
        setScanError(null);
        stopSession();
        onScannedRef.current(invite);
        onCloseRef.current();
      }, {
        preferredCamera: "environment",
        maxScansPerSecond: 8,
        returnDetailedScanResult: true,
        onDecodeError: () => undefined,
      });
      scanner = activeScanner;
      return activeScanner.start();
    }).then(() => {
      if (!destroyed) setStatus("scanning");
    }).catch((error: unknown) => {
      if (!destroyed) showCameraError(getCameraErrorMessage(error));
    });

    return cleanup;
  }, [isOpen, attempt]);

  const closeDialog = () => onCloseRef.current();
  const retryCamera = () => {
    setScanError(null);
    setStatus("starting");
    setAttempt((current) => current + 1);
  };

  return (
    <dialog
      ref={dialogRef}
      className="room-scan-dialog"
      aria-modal="true"
      aria-labelledby="room-scan-title"
      aria-describedby="room-scan-description"
      onCancel={(event) => {
        event.preventDefault();
        closeDialog();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) closeDialog();
      }}
    >
      <div className="room-scan-content">
        <header className="room-scan-header">
          <div>
            <span className="room-invite-eyebrow"><Camera size={14} /> Join a room</span>
            <h2 id="room-scan-title">Scan a room QR code</h2>
          </div>
          <button type="button" className="room-invite-close" onClick={closeDialog} aria-label="Close QR scanner" autoFocus>
            <X size={18} />
          </button>
        </header>

        <p id="room-scan-description" className="room-invite-description">
          Point your camera at the sender’s PeerLink room QR code.
        </p>

        <div ref={videoViewportRef} className="room-scan-video-frame" />

        <p className={`room-scan-status ${status}`} role={status === "error" ? "alert" : "status"} aria-live={status === "error" ? "assertive" : "polite"}>
          {status === "starting" && <><LoaderCircle size={15} className="room-status-spinner" /> Starting camera… approve access if prompted.</>}
          {status === "scanning" && <><QrCode size={15} /> Center the whole QR code in view and hold it steady.</>}
          {status === "joining" && <><LoaderCircle size={15} className="room-status-spinner" /> Joining room…</>}
          {status === "error" && <>{scanError}</>}
        </p>

        {scanError && status !== "error" && <p className="room-scan-error" role="alert">{scanError}</p>}

        {status === "error" && (
          <button type="button" className="room-scan-retry" onClick={retryCamera}>
            <RefreshCw size={15} /> Try camera again
          </button>
        )}
        {status !== "joining" && <p className="room-scan-manual-hint">Or close this window and enter the room ID manually.</p>}
      </div>
    </dialog>
  );
}
