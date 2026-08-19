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
  const [progress, setProgress] = useState("");
  const folderRef = useRef<HTMLInputElement>(null);
  // The staged export always lands in one folder, so the lab points at the
  // folder rather than shift-selecting thirty-odd files.
  const isFolderImport = category === "SIMULATION_MODEL";
  const [error, setError] = useState<unknown>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      // A staged plan is 30-odd files of several MB each, so say where we are
      // rather than looking frozen. Picking a folder also drags in the log and
      // any stray files, which the backend would reject — so only send meshes.
      const list = Array.from(files).filter(
        (f) => !isFolderImport || f.name.toLowerCase().endsWith(".stl"),
      );
      if (list.length === 0) {
        setError(new Error("That folder has no .stl files in it."));
        setBusy(false);
        return;
      }
      for (const [index, file] of list.entries()) {
        if (list.length > 1) setProgress(`${index + 1} of ${list.length} — ${file.name}`);
        await api.uploadFile(orderId, category, file, slot);
      }
      setProgress("");
      onUploaded();
      if (inputRef.current) inputRef.current.value = "";
      if (folderRef.current) folderRef.current.value = "";
    } catch (err) {
      setError(err);
      setProgress("");
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
        {isFolderImport && (
          <>
            <span className="dim">or</span>
            <input
              ref={folderRef}
              type="file"
              multiple
              // Not in the TS lib yet, but supported by every browser the lab uses.
              {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
              disabled={busy}
              onChange={(e) => void handleFiles(e.target.files)}
              style={{ maxWidth: 280 }}
            />
          </>
        )}
      </div>
      {slotOptions.length > 0 && !slot && (
        <p className="dim">Choose which view this is before selecting a file.</p>
      )}
      {isFolderImport && (
        <p className="dim">
          Point the second box at the case's BioModels folder — every
          <code> N-S-…stl</code> and <code>N-I-…stl</code> is imported and the step numbers are
          read from the filenames. Anything that is not an .stl is skipped.
        </p>
      )}
      {hint && <p className="dim">{hint}</p>}
      {busy && <p className="dim">Uploading…</p>}
      {progress && <span className="dim">Uploading {progress}</span>}
      <ErrorText error={error} />
    </div>
  );
}
