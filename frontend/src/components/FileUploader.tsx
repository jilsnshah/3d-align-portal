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
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const blocked = busy || (slotOptions.length > 0 && !slot);

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
    <div
      className={`dropzone${dragging ? " dragging" : ""}${blocked ? " blocked" : ""}`}
      /* A lab uploading a staged export has thirty files in a folder already
         open. Making them go through a file picker to reach files they are
         looking at is work the browser can do for them. */
      onDragOver={(e) => {
        if (blocked) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        // Only when the pointer leaves the zone itself, not on every child it
        // crosses on the way in.
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (!blocked) void handleFiles(e.dataTransfer.files);
      }}
    >
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
        <label className={`file-trigger${blocked ? " is-disabled" : ""}`}>
          <input
            ref={inputRef}
            type="file"
            multiple
            disabled={blocked}
            onChange={(e) => void handleFiles(e.target.files)}
          />
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M12 16V5m0 0L8 9m4-4 4 4" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2" strokeLinecap="round" />
          </svg>
          <span>Choose files</span>
        </label>
        <span className="dim drop-hint">or drop them here</span>
        {isFolderImport && (
          <>
            <span className="dim">or</span>
            <label className={`file-trigger${busy ? " is-disabled" : ""}`}>
              <input
                ref={folderRef}
                type="file"
                multiple
                // Not in the TS lib yet, but supported by every browser the lab uses.
                {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
                disabled={busy}
                onChange={(e) => void handleFiles(e.target.files)}
              />
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M3 7h5l2 2h11v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" strokeLinejoin="round" />
              </svg>
              <span>Choose a folder</span>
            </label>
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
