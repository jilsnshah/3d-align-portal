/* Turning device notifications on, from inside the alerts drawer.

   Asked for here rather than on load: a permission prompt that appears before
   someone knows what the app is gets refused, and refusing this one is
   effectively permanent — the browser will not ask again, and the person has
   to find it in settings to undo. So it is offered where they are already
   looking at alerts and the offer means something. */

import { useEffect, useState } from "react";

import { disablePush, enablePush, pushState } from "../push";
import type { PushState } from "../push";

export default function PushToggle() {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void pushState().then(setState);
  }, []);

  if (state === null || state === "unsupported" || state === "unavailable") return null;

  async function toggle() {
    setBusy(true);
    try {
      setState(state === "on" ? await disablePush() : await enablePush());
    } finally {
      setBusy(false);
    }
  }

  if (state === "blocked") {
    return (
      <p className="dim push-note">
        Notifications are blocked for this app. Turn them back on in your device settings
        to hear about a case without opening the portal.
      </p>
    );
  }

  return (
    <div className="push-row">
      <div>
        <strong>Notify me on this device</strong>
        <div className="dim">
          {state === "on"
            ? "You will hear about a case without opening the portal."
            : "Hear about a case without opening the portal."}
        </div>
      </div>
      <button
        type="button"
        className={state === "on" ? "btn-ghost btn-sm" : "btn-primary btn-sm"}
        disabled={busy}
        onClick={() => void toggle()}
      >
        {busy ? "…" : state === "on" ? "Turn off" : "Turn on"}
      </button>
    </div>
  );
}
