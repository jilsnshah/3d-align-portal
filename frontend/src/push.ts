/* Turning device notifications on for this person, on this device.

   Three things have to line up: the browser supports push, the person has
   agreed, and the server has keys. Any of them missing and the portal simply
   keeps showing alerts in its own drawer, which is what it did before.

   Permission is never asked for on load. A prompt that appears before someone
   knows what the app is gets refused, and a refusal on this is permanent until
   they dig through settings — so it is asked only when they turn it on.
*/

import { api } from "./api";

export type PushState = "unsupported" | "unavailable" | "off" | "on" | "blocked";

function supported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/** The key arrives base64url; the browser wants raw bytes.

    Typed as ArrayBuffer rather than Uint8Array because a Uint8Array may be
    backed by a SharedArrayBuffer, which applicationServerKey will not take. */
function toBytes(base64url: string): ArrayBuffer {
  const padded = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out.buffer;
}

export async function pushState(): Promise<PushState> {
  if (!supported()) return "unsupported";
  if (Notification.permission === "denied") return "blocked";
  const { enabled } = await api.pushKey().catch(() => ({ enabled: false }));
  if (!enabled) return "unavailable";
  const reg = await navigator.serviceWorker.ready;
  return (await reg.pushManager.getSubscription()) ? "on" : "off";
}

export async function enablePush(): Promise<PushState> {
  if (!supported()) return "unsupported";

  const { enabled, public_key: key } = await api.pushKey();
  if (!enabled || !key) return "unavailable";

  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission === "denied" ? "blocked" : "off";

  const reg = await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  const sub =
    existing ??
    (await reg.pushManager.subscribe({
      // Every push must show something. Silent pushes are not allowed, and
      // this app has nothing to do quietly anyway.
      userVisibleOnly: true,
      applicationServerKey: toBytes(key),
    }));

  const raw = sub.toJSON() as { endpoint?: string; keys?: { p256dh: string; auth: string } };
  if (!raw.endpoint || !raw.keys) return "off";
  await api.pushSubscribe({ endpoint: raw.endpoint, keys: raw.keys });
  return "on";
}

export async function disablePush(): Promise<PushState> {
  if (!supported()) return "unsupported";
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    // Told to the server first: a device that unsubscribed locally but stayed
    // on the server's list is one every future alert is wasted on.
    await api.pushUnsubscribe(sub.endpoint).catch(() => {});
    await sub.unsubscribe();
  }
  return "off";
}
