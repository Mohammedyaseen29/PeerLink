import { useEffect, useRef, useState } from "react";
import { Check, Copy, QrCode, X } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import type { RoomType } from "../types";
import { buildRoomInviteUrl } from "../utils/roomInvite";

interface RoomInviteDialogProps {
  isOpen: boolean;
  onClose: () => void;
  roomId: string;
  roomType: RoomType;
}

export function RoomInviteDialog({ isOpen, onClose, roomId, roomType }: RoomInviteDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const inviteUrl = isOpen ? buildRoomInviteUrl(roomId, roomType) : null;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (isOpen && !dialog.open) dialog.showModal();
    else if (!isOpen && dialog.open) dialog.close();

    return () => {
      if (dialog.open) dialog.close();
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      setCopied(false);
      setCopyError(false);
    }
  }, [isOpen]);

  const copyInviteLink = async () => {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      setCopyError(false);
    } catch {
      setCopied(false);
      setCopyError(true);
    }
  };

  const closeDialog = () => {
    setCopied(false);
    setCopyError(false);
    onClose();
  };

  return (
    <dialog
      ref={dialogRef}
      className="room-invite-dialog"
      aria-modal="true"
      aria-labelledby="room-invite-title"
      aria-describedby="room-invite-description"
      onCancel={(event) => {
        event.preventDefault();
        closeDialog();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) closeDialog();
      }}
    >
      <div className="room-invite-content">
        <header className="room-invite-header">
          <div>
            <span className="room-invite-eyebrow"><QrCode size={14} /> Room invite</span>
            <h2 id="room-invite-title">Scan to join this room</h2>
          </div>
          <button type="button" className="room-invite-close" onClick={closeDialog} aria-label="Close room invite" autoFocus>
            <X size={18} />
          </button>
        </header>

        {inviteUrl ? (
          <>
            <p id="room-invite-description" className="room-invite-description">
              Scan with your phone camera. PeerLink will open and join this room automatically.
            </p>
            <div className="room-invite-details">
              <span className="room-invite-id">{roomId}</span>
              <span className={`room-invite-type ${roomType}`}>
                {roomType === "temporary" ? "Temporary room" : "Persistent room"}
              </span>
            </div>
            <div className="room-invite-qr" aria-label="Room invite QR code">
              <QRCodeSVG
                value={inviteUrl}
                size={240}
                level="M"
                marginSize={4}
                bgColor="#ffffff"
                fgColor="#090909"
                title={`Scan to join PeerLink room ${roomId}`}
              />
            </div>
            <label className="room-invite-link-label" htmlFor="room-invite-link">Invite link</label>
            <div className="room-invite-link-row">
              <input
                id="room-invite-link"
                className="room-invite-link-input"
                type="text"
                readOnly
                value={inviteUrl}
                onFocus={(event) => event.currentTarget.select()}
                aria-label="Room invitation link"
              />
              <button type="button" className="room-invite-copy" onClick={() => void copyInviteLink()}>
                {copied ? <Check size={15} /> : <Copy size={15} />}
                <span>{copied ? "Copied" : "Copy link"}</span>
              </button>
            </div>
            {copyError && <p className="room-invite-copy-error" role="status">Could not copy the link. Select the link above to copy it manually.</p>}
          </>
        ) : (
          <p id="room-invite-description" className="room-invite-description" role="status">
            This room ID cannot be shared as an invite link.
          </p>
        )}
      </div>
    </dialog>
  );
}
