import { useRef, useState } from "react";

import { CATEGORY_LABEL, SLOT_OPTIONS, api } from "../api";
import type { FileCategory } from "../api";
import { ErrorText } from "./ui";

export default function FileUploader({
  orderId,
  categories,
  onUploaded,
  hint,
}: {
  orderId: string;
  categories: FileCategory[];
  onUploaded: () => void;
  hint?: string;
}) {
  const [category, setCategory] = useState<FileCategory>(categories[0]);
  const slotOptions = SLOT_OPTIONS[category] ?? [];
  const [slot, setSlot] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      for (const file of Array.from(files)) {
        await api.uploadFile(orderId, category, file, slot);
      }
      onUploaded();
      if (inputRef.current) inputRef.current.value = "";
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dropzone">
      <div className="row">
        <select
          value={category}
          onChange={(e) => {
            setCategory(e.target.value as FileCategory);
            setSlot("");
          }}
          style={{ maxWidth: 220 }}
          disabled={categories.length === 1}
        >
          {categories.map((option) => (
            <option key={option} value={option}>
              {CATEGORY_LABEL[option]}
            </option>
          ))}
        </select>
        {slotOptions.length > 0 && (
          <select value={slot} onChange={(e) => setSlot(e.target.value)} style={{ maxWidth: 200 }}>
            <option value="">Which view?</option>
            {slotOptions.map((option) => (
              <option key={option.slot} value={option.slot}>
                {option.label}
                {option.required ? "" : " (optional)"}
              </option>
            ))}
          </select>
        )}
        <input
          ref={inputRef}
          type="file"
          multiple
          disabled={busy || (slotOptions.length > 0 && !slot)}
          onChange={(e) => void handleFiles(e.target.files)}
          style={{ maxWidth: 300 }}
        />
      </div>
      {slotOptions.length > 0 && !slot && (
        <p className="dim">Choose which view this is before selecting a file.</p>
      )}
      {hint && <p className="dim">{hint}</p>}
      {busy && <p className="dim">Uploading…</p>}
      <ErrorText error={error} />
    </div>
  );
}
