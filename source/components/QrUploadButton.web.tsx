import React, { useEffect, useRef } from "react";
import jsQR from "jsqr";

import { Button, ButtonText } from "@ds";

import type { QrUploadButtonProps } from "./QrUploadButton.types";

// Big photos are slow to decode and gain nothing past this size.
const MAX_SIDE = 1000;

async function decodeFile(file: File): Promise<string | null> {
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("image failed to load"));
      img.src = url;
    });
    const scale = Math.min(1, MAX_SIDE / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(image, 0, 0, width, height);
    const { data } = context.getImageData(0, 0, width, height);
    return jsQR(data, width, height, { inversionAttempts: "attemptBoth" })?.data || null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// The browser has its own file picker, so the web button opens a hidden file
// input directly.
const QrUploadButton: React.FC<QrUploadButtonProps> = ({ label, onOpen, onCancel, onDecoded }) => {
  const inputRef = useRef<HTMLInputElement | null>(null);
  // The token of the pick in progress; its cancel or result carries it, so a
  // slow photo still reports as the upload it came from.
  const tokenRef = useRef(-1);

  // React has no prop for the input's cancel event (picker closed, no file).
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const cancel = () => onCancel(tokenRef.current);
    input.addEventListener("cancel", cancel);
    return () => input.removeEventListener("cancel", cancel);
  }, [onCancel]);

  const onChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const token = tokenRef.current;
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      onCancel(token);
      return;
    }
    decodeFile(file).then(
      (data) => onDecoded(data, token),
      () => onDecoded(null, token),
    );
  };

  return (
    <>
      <Button
        size="lg"
        variant="soft"
        accessibilityLabel={label}
        onPress={() => {
          tokenRef.current = onOpen();
          inputRef.current?.click();
        }}
      >
        <ButtonText>{label}</ButtonText>
      </Button>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={onChange}
      />
    </>
  );
};

export default QrUploadButton;
