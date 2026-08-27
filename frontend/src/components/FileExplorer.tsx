/* Records browser.

   A scan is a set — upper arch, lower arch, bite — not a pile of files, so each
   category renders as its named views. A filled view shows its thumbnail; an
   empty required one shows what is still needed and takes a drop straight into
   that slot. Photographs preview inline, because opening a case should not mean
   downloading eight JPEGs to see them. */

import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { api, formatBytes, formatDate } from "../api";
import type { BinnedFile, OrderDetail, OrderFile, RecordSet, SlotState } from "../api";
import SlotDiagram, { hasDiagram } from "./SlotDiagram";
import { Banner, ConfirmButton, ErrorText, Loading } from "./ui";

export default function FileExplorer({
  order,
  onChanged,
}: {
  order: OrderDetail;
  onChanged: () => void;
}) {
  const [preview, setPreview] = useState<OrderFile | null>(null);
  const [showBin, setShowBin] = useState(false);

  const sets = order.record_sets;

  return (
    <div className="stack-sm">
      <div className="row-between">
        <h4>Records</h4>
        {order.binned_count > 0 && (
          <button type="button" className="btn-link" onClick={() => setShowBin((v) => !v)}>
            {showBin ? "Hide" : "Show"} recycle bin ({order.binned_count})
          </button>
        )}
      </div>

      {showBin && <RecycleBin order={order} onChanged={onChanged} onPreview={setPreview} />}

      {sets.length === 0 ? (
        <p className="dim">Nothing uploaded yet.</p>
      ) : (
        sets.map((set) => (
          <RecordSetCard
            key={set.category}
            order={order}
            set={set}
            onChanged={onChanged}
            onPreview={setPreview}
          />
        ))
      )}

      {preview && (
        <Lightbox order={order} file={preview} onClose={() => setPreview(null)} />
      )}
    </div>
  );
}

function RecordSetCard({
  order,
  set,
  onChanged,
  onPreview,
}: {
  order: OrderDetail;
  set: RecordSet;
  onChanged: () => void;
  onPreview: (f: OrderFile) => void;
}) {
  const hasSlots = set.slots.length > 0;
  const canEdit = set.editable;
  const current = set.slots.filter((s) => s.file).length + set.extras.filter((f) => f.is_current).length;

  return (
    <details className="fold" open={!set.complete || set.category === "INTRAORAL_SCAN"}>
      <summary>
        <span className="fold-chevron">▶</span>
        <h4>{set.label}</h4>
        <span className="fold-sub">
          {hasSlots && set.complete && <span className="pill pill-ok">complete</span>}
          {hasSlots && !set.complete && (
            <span className="pill pill-warn">{set.missing.length} missing</span>
          )}
          {!hasSlots && current > 0 && <span className="pill pill-ok">on file</span>}
          {!hasSlots && current === 0 && (
            <span className={set.required ? "pill pill-warn" : "pill"}>
              {set.required ? "required" : "none yet"}
            </span>
          )}
          {set.revision > 1 && <span className="dim"> · v{set.revision}</span>}
        </span>
      </summary>

      <div className="fold-body">
        {hasSlots && !set.complete && (
          <Banner tone="warn">Still needed: {set.missing.join(", ")}</Banner>
        )}

        {hasSlots && (
          <div className="slot-tiles" style={{ marginTop: set.complete ? 0 : 12 }}>
            {set.slots.map((slotState) => (
              <SlotTile
                key={slotState.slot}
                order={order}
                set={set}
                state={slotState}
                canEdit={canEdit}
                onChanged={onChanged}
                onPreview={onPreview}
              />
            ))}
          </div>
        )}

        {!hasSlots && (
          <PlainUploader order={order} set={set} onChanged={onChanged} />
        )}

        {set.extras.length > 0 && (
          <div style={{ marginTop: hasSlots || !canEdit ? 14 : 10 }}>
            {hasSlots && <h4 style={{ marginBottom: 8 }}>Earlier rounds &amp; extras</h4>}
            {set.extras.map((file) => (
              <FileRow
                key={file.id}
                order={order}
                file={file}
                canEdit={canEdit}
                onChanged={onChanged}
                onPreview={onPreview}
              />
            ))}
          </div>
        )}

        {!canEdit && set.locked_reason && (
          <p className="dim" style={{ marginTop: 10 }}>
            {set.locked_reason}
          </p>
        )}
      </div>
    </details>
  );
}

/** Upload control for categories that are a single document rather than a set —
    OPG, CBCT, treatment plan, simulation video. */
function PlainUploader({
  order,
  set,
  onChanged,
}: {
  order: OrderDetail;
  set: RecordSet;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<unknown>(null);
  const inputId = `plain-${set.category}`;
  // Planning output arrives as folders — thirty-odd meshes for the simulation,
  // and a plan is rarely one PDF — so these are chosen as a folder rather than
  // shift-selected.
  const isFolderImport =
    set.category === "SIMULATION_MODEL" || set.category === "TREATMENT_PLAN";
  const meshesOnly = set.category === "SIMULATION_MODEL";

  if (!set.editable) return null;

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    setError(null);
    try {
      const list = Array.from(files).filter(
        (f) =>
          // A folder always drags in .DS_Store and the exporter's log.
          !f.name.startsWith(".") &&
          f.name !== "Thumbs.db" &&
          (!meshesOnly || f.name.toLowerCase().endsWith(".stl")),
      );
      if (list.length === 0) {
        setError(
          new Error(meshesOnly ? "That folder has no .stl files in it." : "That folder is empty."),
        );
        return;
      }
      for (const [index, file] of list.entries()) {
        if (list.length > 1) setProgress(`${index + 1} of ${list.length} — ${file.name}`);
        await api.uploadFile(order.id, set.category, file);
      }
      setProgress("");
      onChanged();
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
        <input
          id={inputId}
          type="file"
          multiple
          disabled={busy}
          onChange={(e) => void upload(e.target.files)}
        />
        {isFolderImport && (
          <>
            <span className="dim">or pick the folder</span>
            <input
              type="file"
              multiple
              {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
              disabled={busy}
              onChange={(e) => void upload(e.target.files)}
            />
          </>
        )}
      </div>
      {isFolderImport && !busy && (
        <p className="dim">
          {meshesOnly
            ? "Choose the case's BioModels folder — step numbers are read from the filenames and anything that is not an .stl is skipped."
            : "Pick files, or choose a folder to bring in everything inside it."}
        </p>
      )}
      {busy && <p className="dim">Uploading {progress || "…"}</p>}
      <ErrorText error={error} />
    </div>
  );
}

function SlotTile({
  order,
  set,
  state,
  canEdit,
  onChanged,
  onPreview,
}: {
  order: OrderDetail;
  set: RecordSet;
  state: SlotState;
  canEdit: boolean;
  onChanged: () => void;
  onPreview: (f: OrderFile) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const inputId = `up-${set.category}-${state.slot}`;

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    setError(null);
    try {
      await api.uploadFile(order.id, set.category, files[0], state.slot);
      onChanged();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (state.file) {
    const file = state.file;
    return (
      <figure className="tile-file">
        <button
          type="button"
          className="tile-thumb"
          onClick={() => onPreview(file)}
          title={file.filename}
        >
          {file.is_image ? (
            <img src={api.previewUrl(order.id, file.id)} alt={state.label} loading="lazy" />
          ) : (
            <span className="tile-ext">{file.filename.split(".").pop()?.toUpperCase()}</span>
          )}
          {busy && <span className="tile-busy">Uploading…</span>}
        </button>
        <figcaption>
          <b>
            {hasDiagram(state.slot) && (
              <SlotDiagram slot={state.slot} className="slot-diagram-inline" />
            )}
            {state.label}
          </b>
          <span className="dim">{formatBytes(file.size_bytes)}</span>
          <div className="tile-actions">
            <a href={api.downloadUrl(order.id, file.id)} className="btn-link">
              Download
            </a>
            {canEdit && (
              <>
                {/* A current file is replaced, not deleted — the one it replaces
                    retires to the bin on its own, so a set can never be broken
                    by removing the view it depends on. */}
                <input
                  id={inputId}
                  type="file"
                  hidden
                  disabled={busy}
                  onChange={(e) => void upload(e.target.files)}
                />
                <label htmlFor={inputId} className="btn-link" style={{ cursor: "pointer" }}>
                  Replace
                </label>
              </>
            )}
          </div>
          <ErrorText error={error} />
        </figcaption>
      </figure>
    );
  }

  return (
    <div className={`tile-empty${state.required ? " required" : ""}`}>
      <div className="tile-thumb placeholder">
        {/* The diagram is the instruction. The word underneath only says
            whether the set is incomplete without this view. */}
        {hasDiagram(state.slot) ? (
          <>
            <SlotDiagram slot={state.slot} className="slot-diagram" />
            <span className="slot-need">{state.required ? "Required" : "Optional"}</span>
          </>
        ) : (
          state.required ? "Required" : "Optional"
        )}
      </div>
      <div>
        <b>{state.label}</b>
        {canEdit && (
          <>
            <input
              id={inputId}
              type="file"
              hidden
              disabled={busy}
              onChange={(e) => void upload(e.target.files)}
            />
            <label htmlFor={inputId} className="btn-link" style={{ cursor: "pointer" }}>
              {busy ? "Uploading…" : "Upload"}
            </label>
          </>
        )}
        <ErrorText error={error} />
      </div>
    </div>
  );
}

function FileRow({
  order,
  file,
  canEdit,
  onChanged,
  onPreview,
}: {
  order: OrderDetail;
  file: OrderFile;
  canEdit: boolean;
  onChanged: () => void;
  onPreview: (f: OrderFile) => void;
}) {
  const remove = useMutation({
    mutationFn: () => api.deleteFile(order.id, file.id),
    onSuccess: onChanged,
  });

  return (
    <div className={`file-row${file.is_current ? "" : " superseded"}`}>
      {file.is_image ? (
        <button type="button" className="row-thumb" onClick={() => onPreview(file)}>
          <img src={api.previewUrl(order.id, file.id)} alt="" loading="lazy" />
        </button>
      ) : (
        <span className="row-thumb placeholder">
          {file.filename.split(".").pop()?.toUpperCase()}
        </span>
      )}
      <span className="name" title={file.filename}>
        {file.filename}
        {!file.is_current && <span className="dim"> · v{file.revision} superseded</span>}
      </span>
      <span className="dim num">{formatBytes(file.size_bytes)}</span>
      <a className="btn-link" href={api.downloadUrl(order.id, file.id)}>
        Download
      </a>
      {canEdit && !file.is_current && (
        <ConfirmButton
          label="Delete"
          confirmLabel="Move to bin"
          className="btn-link"
          onConfirm={() => remove.mutate()}
        />
      )}
    </div>
  );
}

function RecycleBin({
  order,
  onChanged,
  onPreview,
}: {
  order: OrderDetail;
  onChanged: () => void;
  onPreview: (f: OrderFile) => void;
}) {
  const queryClient = useQueryClient();
  const bin = useQuery({ queryKey: ["bin", order.id], queryFn: () => api.listBin(order.id) });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["bin", order.id] });
    onChanged();
  };

  const restore = useMutation({
    mutationFn: (id: string) => api.restoreFile(order.id, id),
    onSuccess: refresh,
  });
  const purge = useMutation({
    mutationFn: (id: string) => api.purgeFile(order.id, id),
    onSuccess: refresh,
  });

  if (bin.isLoading) return <Loading what="the bin" />;

  return (
    <div className="card" style={{ background: "var(--paper)" }}>
      <div className="card-head">
        <h4>Recycle bin</h4>
        <span className="dim">Recoverable for 30 days, then deleted for good.</span>
      </div>
      <ErrorText error={restore.error ?? purge.error} />
      {bin.data?.length === 0 ? (
        <p className="dim">Nothing here.</p>
      ) : (
        bin.data?.map((file: BinnedFile) => (
          <div key={file.id} className="file-row">
            {file.is_image ? (
              <button type="button" className="row-thumb" onClick={() => onPreview(file)}>
                <img src={api.previewUrl(order.id, file.id)} alt="" loading="lazy" />
              </button>
            ) : (
              <span className="row-thumb placeholder">
                {file.filename.split(".").pop()?.toUpperCase()}
              </span>
            )}
            <span className="name" title={file.filename}>
              {file.slot_label || file.filename}
              <div className="dim">
                Deleted {formatDate(file.deleted_at)} · purges in {file.purges_in_days} day(s)
              </div>
            </span>
            <button
              type="button"
              className="btn-ghost btn-sm"
              disabled={restore.isPending}
              onClick={() => restore.mutate(file.id)}
            >
              Restore
            </button>
            <ConfirmButton
              label="Delete now"
              confirmLabel="Gone for good"
              className="btn-link"
              onConfirm={() => purge.mutate(file.id)}
            />
          </div>
        ))
      )}
    </div>
  );
}

function Lightbox({
  order,
  file,
  onClose,
}: {
  order: OrderDetail;
  file: OrderFile;
  onClose: () => void;
}) {
  // Into the body, for the same reason the catalogue's dialog is: `.page`
  // carries an entrance animation on transform with fill-mode "both", which
  // keeps filling for good, and a filling transform animation makes an element
  // the containing block for position:fixed inside it. Left in place, a
  // full-screen preview is trapped in the page and opens wherever the middle
  // of a long case happens to be.
  return createPortal(
    <div
      className="lightbox"
      role="dialog"
      aria-label={file.slot_label || file.filename}
      onClick={onClose}
    >
      <div className="lightbox-inner" onClick={(e) => e.stopPropagation()}>
        <div className="lightbox-bar">
          <div>
            <b>{file.slot_label || file.filename}</b>
            <div className="dim">
              {file.filename} · {formatBytes(file.size_bytes)}
              {file.uploaded_by ? ` · ${file.uploaded_by}` : ""}
            </div>
          </div>
          <div className="row">
            <a className="btn-ghost btn-sm" href={api.downloadUrl(order.id, file.id)}>
              Download
            </a>
            <button type="button" className="btn-dark btn-sm" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
        {file.is_image ? (
          <img src={api.previewUrl(order.id, file.id)} alt={file.slot_label || file.filename} />
        ) : (
          <p className="dim" style={{ padding: 40, textAlign: "center" }}>
            {file.filename.split(".").pop()?.toUpperCase()} files cannot be previewed here — download
            it to open in your scanner software.
          </p>
        )}
      </div>
    </div>,
    document.body,
  );
}
