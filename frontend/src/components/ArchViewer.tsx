/* The staged treatment plan, in 3D.

   The lab exports one mesh per arch per step. This walks through them so a
   clinic can see the movement they are being asked to approve, rather than
   taking a number of aligners on trust.

   Meshes arrive in the compact indexed format the backend converts to — an
   8 MB STL becomes ~3 MB of positions and indices, which is the difference
   between a viewer that opens and one that does not. */

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import { api } from "../api";
import type { Articulation, Simulation, Stage } from "../api";

type ArchKey = "upper" | "lower";

interface Loaded {
  geometry: THREE.BufferGeometry;
  centre: THREE.Vector3;
  lo: THREE.Vector3;
  hi: THREE.Vector3;
  radius: number;
  /** Millimetres moved from the starting arch, per vertex. */
  movement: Float32Array | null;
  maxMovement: number;
}

/** Parses the backend's A3DM buffer. Header is documented in services/meshes.py. */
function parseMesh(buffer: ArrayBuffer): Loaded {
  const view = new DataView(buffer);
  const magic = String.fromCharCode(
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3),
  );
  if (magic !== "A3DM") throw new Error("Unexpected mesh format.");

  const vertexCount = view.getUint32(8, true);
  const triangleCount = view.getUint32(12, true);
  const flags = view.getUint32(16, true);
  const lo = new THREE.Vector3(
    view.getFloat32(20, true),
    view.getFloat32(24, true),
    view.getFloat32(28, true),
  );
  const hi = new THREE.Vector3(
    view.getFloat32(32, true),
    view.getFloat32(36, true),
    view.getFloat32(40, true),
  );
  const centre = new THREE.Vector3(
    view.getFloat32(44, true),
    view.getFloat32(48, true),
    view.getFloat32(52, true),
  );

  const headerBytes = 56;
  const positions = new Float32Array(buffer, headerBytes, vertexCount * 3);
  const indices = new Uint32Array(buffer, headerBytes + vertexCount * 12, triangleCount * 3);

  // Tenths of a millimetre, one byte per vertex.
  let movement: Float32Array | null = null;
  let maxMovement = 0;
  if (flags & 1) {
    const raw = new Uint8Array(
      buffer,
      headerBytes + vertexCount * 12 + triangleCount * 12,
      vertexCount,
    );
    movement = new Float32Array(vertexCount);
    for (let i = 0; i < vertexCount; i += 1) {
      movement[i] = raw[i] / 10;
      if (movement[i] > maxMovement) maxMovement = movement[i];
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  // The lab's STL carries normals but they cost 12 bytes a triangle to ship;
  // recomputing here is faster than downloading them.
  geometry.computeVertexNormals();

  return {
    geometry,
    centre,
    lo,
    hi,
    radius: lo.distanceTo(hi) / 2,
    movement,
    maxMovement,
  };
}

/** Fallback gap when the patient's own bite is not available. */
const BITE_GAP_MM = 1.2;

/** The centre of the two arches once the bite transforms have been applied,
    so the pair can be framed about the origin the camera orbits. Derived from
    the transformed corners of each arch's bounding box, which for a rigid
    transform enclose the arch. */
function articulatedCentre(
  all: readonly (readonly [ArchKey, Loaded | null])[],
  art: Articulation,
): THREE.Vector3 {
  const lo = new THREE.Vector3(Infinity, Infinity, Infinity);
  const hi = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  all.forEach(([arch, loaded]) => {
    if (!loaded) return;
    const m = matrixOf(art, arch);
    for (const x of [loaded.lo.x, loaded.hi.x])
      for (const y of [loaded.lo.y, loaded.hi.y])
        for (const z of [loaded.lo.z, loaded.hi.z]) {
          const p = new THREE.Vector3(x, y, z).applyMatrix4(m);
          lo.min(p);
          hi.max(p);
        }
  });
  if (!Number.isFinite(lo.x)) return new THREE.Vector3();
  return lo.add(hi).multiplyScalar(0.5);
}

/** The backend sends row-major matrices; Matrix4.set takes its arguments in
    that order, unlike fromArray which expects column-major. */
function matrixOf(art: Articulation, arch: ArchKey): THREE.Matrix4 {
  const a = arch === "upper" ? art.upper : art.lower;
  return new THREE.Matrix4().set(
    a[0], a[1], a[2], a[3],
    a[4], a[5], a[6], a[7],
    a[8], a[9], a[10], a[11],
    a[12], a[13], a[14], a[15],
  );
}

/** Sits the two arches together.

    When the case has intraoral scans, the backend registers step 0 of each arch
    onto the scan of that arch, and the scans carry the bite the scanner
    recorded with the bite registration. Applying those transforms puts the
    staged arches into the patient's real occlusion: the overjet, the overbite
    and the cusps that actually meet are the patient's own, not a nominal gap.

    Without usable scans there is no bite to apply, so the arches are assembled
    instead — lower as the floor, upper turned over and set on top with a fixed
    clearance. That is an assembly, not an occlusion, and the viewer labels it
    as such rather than letting it pass for a measured bite. */
function place(
  mesh: THREE.Mesh,
  arch: ArchKey,
  loaded: Loaded,
  all: readonly (readonly [ArchKey, Loaded | null])[],
  art: Articulation | null,
  centre: THREE.Vector3,
) {
  if (art) {
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(matrixOf(art, arch));
    // Recentre the articulated pair on the origin the camera orbits, without
    // disturbing how the two arches sit against each other.
    mesh.matrix.premultiply(
      new THREE.Matrix4().makeTranslation(-centre.x, -centre.y, -centre.z),
    );
    mesh.matrixWorldNeedsUpdate = true;
    return;
  }

  const lower = all.find(([a]) => a === "lower")?.[1] ?? null;
  const lowerTop = lower ? lower.hi.z - lower.lo.z : loaded.hi.z - loaded.lo.z;

  if (arch === "lower") {
    // Centred in plan, standing on z = 0.
    mesh.position.set(-loaded.centre.x, -loaded.centre.y, -loaded.lo.z);
    return;
  }

  // Turning the upper over maps z to -z and y to -y, so the plan offset flips
  // with it. Its lowest point after the flip is its old ceiling.
  mesh.rotation.x = Math.PI;
  mesh.position.set(
    -loaded.centre.x,
    loaded.centre.y,
    lowerTop + BITE_GAP_MM + loaded.hi.z,
  );
}

/** Blue where nothing has moved, through gold, to red at the largest movement.
    Kept deliberately coarse: this is a map of where the plan is doing work, not
    a measurement to a tenth of a millimetre. */
function heatColours(movement: Float32Array, ceiling: number): THREE.BufferAttribute {
  const colours = new Float32Array(movement.length * 3);
  const top = Math.max(ceiling, 0.5);
  for (let i = 0; i < movement.length; i += 1) {
    const t = Math.min(movement[i] / top, 1);
    let r: number, g: number, b: number;
    if (t < 0.5) {
      const k = t / 0.5; // still to gold
      r = 0.35 + 0.55 * k;
      g = 0.55 + 0.25 * k;
      b = 0.75 - 0.55 * k;
    } else {
      const k = (t - 0.5) / 0.5; // gold to red
      r = 0.9;
      g = 0.8 - 0.62 * k;
      b = 0.2 - 0.14 * k;
    }
    colours[i * 3] = r;
    colours[i * 3 + 1] = g;
    colours[i * 3 + 2] = b;
  }
  return new THREE.BufferAttribute(colours, 3);
}

const VIEWS: Record<string, [number, number, number]> = {
  Front: [0, -1, 0.15],
  Right: [1, 0, 0.15],
  Left: [-1, 0, 0.15],
  Upper: [0, 0, -1],
  Lower: [0, 0, 1],
};

export default function ArchViewer({
  orderId,
  simulation,
}: {
  orderId: string;
  simulation: Simulation;
}) {
  const holder = useRef<HTMLDivElement | null>(null);
  const scene = useRef<THREE.Scene | null>(null);
  const camera = useRef<THREE.PerspectiveCamera | null>(null);
  const controls = useRef<OrbitControls | null>(null);
  const meshes = useRef<Record<ArchKey, THREE.Mesh | null>>({ upper: null, lower: null });
  // Geometry is expensive to fetch and cheap to keep; a whole case is ~100 MB
  // so the cache is capped and the oldest entries are released.
  const cache = useRef(new Map<string, Loaded>());
  const framed = useRef(false);

  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [show, setShow] = useState<Record<ArchKey, boolean>>({ upper: true, lower: true });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [heat, setHeat] = useState(false);
  const [ghost, setGhost] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [spin, setSpin] = useState(false);
  const [clip, setClip] = useState(0);
  const [measured, setMeasured] = useState<string | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const [maxMove, setMaxMove] = useState(0);

  // The bite the scans recorded, if the case has one that registers.
  const art = simulation.articulation ?? null;
  const artCentre = (results: readonly (readonly [ArchKey, Loaded | null])[]) =>
    art ? articulatedCentre(results, art) : new THREE.Vector3();

  const ghosts = useRef<Record<ArchKey, THREE.Mesh | null>>({ upper: null, lower: null });
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const measurePoints = useRef<THREE.Vector3[]>([]);
  const markerGroup = useRef<THREE.Group | null>(null);
  const measuringRef = useRef(false);
  const spinRef = useRef(false);
  const maxMoveRef = useRef(0);

  const stages = simulation.stages;
  const current: Stage | undefined = stages[step];

  // -- scene ---------------------------------------------------------------
  useEffect(() => {
    if (!holder.current) return;
    const width = holder.current.clientWidth;
    const height = holder.current.clientHeight;

    const s = new THREE.Scene();
    s.background = new THREE.Color(0x14141a);
    const cam = new THREE.PerspectiveCamera(35, width / height, 0.1, 2000);
    cam.up.set(0, 0, 1);
    // preserveDrawingBuffer keeps the frame readable for Snapshot.
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    holder.current.appendChild(renderer.domElement);

    s.add(new THREE.AmbientLight(0xffffff, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 0.85);
    key.position.set(1, -1, 1);
    s.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.35);
    fill.position.set(-1, 1, 0.5);
    s.add(fill);

    const orbit = new OrbitControls(cam, renderer.domElement);
    orbit.enableDamping = true;
    orbit.dampingFactor = 0.08;

    scene.current = s;
    camera.current = cam;
    controls.current = orbit;
    rendererRef.current = renderer;
    renderer.localClippingEnabled = true;
    const markers = new THREE.Group();
    s.add(markers);
    markerGroup.current = markers;

    // Click two points to measure between them.
    const ray = new THREE.Raycaster();
    const onClick = (event: MouseEvent) => {
      if (!measuringRef.current) return;
      const rect = renderer.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      ray.setFromCamera(ndc, cam);
      const targets = Object.values(meshes.current).filter(Boolean) as THREE.Mesh[];
      const hit = ray.intersectObjects(targets, false)[0];
      if (!hit) return;
      measurePoints.current.push(hit.point.clone());
      const dot = new THREE.Mesh(
        new THREE.SphereGeometry(0.4, 12, 12),
        new THREE.MeshBasicMaterial({ color: 0xd4af37 }),
      );
      dot.position.copy(hit.point);
      markers.add(dot);
      if (measurePoints.current.length === 2) {
        const [a, b] = measurePoints.current;
        setMeasured(`${a.distanceTo(b).toFixed(2)} mm`);
        markers.add(
          new THREE.Line(
            new THREE.BufferGeometry().setFromPoints([a, b]),
            new THREE.LineBasicMaterial({ color: 0xd4af37 }),
          ),
        );
        measurePoints.current = [];
      }
    };
    renderer.domElement.addEventListener("click", onClick);

    let alive = true;
    const tick = () => {
      if (!alive) return;
      if (spinRef.current) orbit.autoRotate = true;
      else orbit.autoRotate = false;
      orbit.autoRotateSpeed = 1.6;
      orbit.update();
      renderer.render(s, cam);
      requestAnimationFrame(tick);
    };
    tick();

    const onResize = () => {
      if (!holder.current) return;
      const w = holder.current.clientWidth;
      const h = holder.current.clientHeight;
      cam.aspect = w / h;
      cam.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener("resize", onResize);

    return () => {
      alive = false;
      window.removeEventListener("resize", onResize);
      renderer.domElement.removeEventListener("click", onClick);
      orbit.dispose();
      renderer.dispose();
      cache.current.forEach((entry) => entry.geometry.dispose());
      cache.current.clear();
      renderer.domElement.remove();
    };
  }, []);

  // -- loading a step ------------------------------------------------------
  async function fetchMesh(fileId: string): Promise<Loaded> {
    const hit = cache.current.get(fileId);
    if (hit) return hit;

    const response = await fetch(api.meshUrl(orderId, fileId), { credentials: "include" });
    if (!response.ok) throw new Error(`Could not load model (${response.status}).`);
    const parsed = parseMesh(await response.arrayBuffer());

    if (cache.current.size >= 12) {
      const oldest = cache.current.keys().next().value as string | undefined;
      if (oldest) {
        cache.current.get(oldest)?.geometry.dispose();
        cache.current.delete(oldest);
      }
    }
    cache.current.set(fileId, parsed);
    return parsed;
  }

  useEffect(() => {
    if (!current || !scene.current) return;
    let cancelled = false;
    setBusy(true);
    setError(null);

    const wanted: [ArchKey, string | null][] = [
      ["upper", current.upper?.file_id ?? null],
      ["lower", current.lower?.file_id ?? null],
    ];

    Promise.all(
      wanted.map(async ([arch, fileId]) => {
        if (!fileId) return [arch, null] as const;
        return [arch, await fetchMesh(fileId)] as const;
      }),
    )
      .then((results) => {
        if (cancelled || !scene.current) return;
        results.forEach(([arch, loaded]) => {
          const existing = meshes.current[arch];
          if (existing) {
            scene.current!.remove(existing);
            meshes.current[arch] = null;
          }
          if (!loaded) return;
          if (loaded.movement && heat) {
            loaded.geometry.setAttribute("color", heatColours(loaded.movement, loaded.maxMovement));
          } else {
            loaded.geometry.deleteAttribute("color");
          }
          const material = new THREE.MeshPhongMaterial({
            color: heat && loaded.movement ? 0xffffff : arch === "upper" ? 0xf3f0ea : 0xe6e0d4,
            vertexColors: Boolean(heat && loaded.movement),
            shininess: heat ? 8 : 35,
            specular: 0x222222,
            flatShading: false,
          });
          const mesh = new THREE.Mesh(loaded.geometry, material);
          mesh.visible = show[arch];
          place(mesh, arch, loaded, results, art, artCentre(results));
          scene.current!.add(mesh);
          meshes.current[arch] = mesh;

          if (loaded.maxMovement > maxMoveRef.current) {
            maxMoveRef.current = loaded.maxMovement;
            setMaxMove(loaded.maxMovement);
          }

          if (!framed.current) {
            framed.current = true;
            const distance = Math.max(loaded.radius * 3.4, 70);
            camera.current!.position.set(0, -distance, distance * 0.12);
            controls.current!.target.set(0, 0, 0);
            camera.current!.lookAt(0, 0, 0);
          }
        });
      })
      .catch((err) => !cancelled && setError(err.message))
      .finally(() => !cancelled && setBusy(false));

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, simulation.order_reference]);

  // The starting position, held behind the current step. Superimposition is
  // the clearest way to show a clinic what the plan actually achieves.
  useEffect(() => {
    if (!scene.current || !ghost) {
      (Object.keys(ghosts.current) as ArchKey[]).forEach((arch) => {
        const mesh = ghosts.current[arch];
        if (mesh && scene.current) scene.current.remove(mesh);
        ghosts.current[arch] = null;
      });
      return;
    }
    const first = stages[0];
    if (!first) return;
    let cancelled = false;

    Promise.all(
      ([["upper", first.upper?.file_id], ["lower", first.lower?.file_id]] as const).map(
        async ([arch, fileId]) =>
          [arch, fileId ? await fetchMesh(fileId) : null] as const,
      ),
    )
      .then((results) => {
        if (cancelled || !scene.current) return;
        results.forEach(([arch, loaded]) => {
          const old = ghosts.current[arch];
          if (old) scene.current!.remove(old);
          if (!loaded) return;
          const mesh = new THREE.Mesh(
            loaded.geometry,
            new THREE.MeshPhongMaterial({
              color: 0x6d8bb5,
              transparent: true,
              opacity: 0.28,
              depthWrite: false,
              shininess: 5,
            }),
          );
          place(mesh, arch, loaded, results, art, artCentre(results));
          mesh.visible = show[arch];
          scene.current!.add(mesh);
          ghosts.current[arch] = mesh;
        });
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ghost, simulation.order_reference]);

  // Pull the next step down while the current one is on screen, so pressing
  // play does not stutter on every frame.
  useEffect(() => {
    const next = stages[step + 1];
    if (!next) return;
    const ids = [next.upper?.file_id, next.lower?.file_id].filter(Boolean) as string[];
    ids.forEach((id) => void fetchMesh(id).catch(() => undefined));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // Recolouring must not wait for the next step change: the meshes on screen
  // are re-materialised in place when the mode is toggled.
  useEffect(() => {
    (Object.keys(meshes.current) as ArchKey[]).forEach((arch) => {
      const mesh = meshes.current[arch];
      if (!mesh) return;
      const loaded = [...cache.current.values()].find((c) => c.geometry === mesh.geometry);
      const movement = loaded?.movement ?? null;

      if (movement && heat) {
        mesh.geometry.setAttribute("color", heatColours(movement, loaded!.maxMovement));
      } else {
        mesh.geometry.deleteAttribute("color");
      }
      const material = mesh.material as THREE.MeshPhongMaterial;
      material.vertexColors = Boolean(movement && heat);
      material.color.set(
        movement && heat ? 0xffffff : arch === "upper" ? 0xf3f0ea : 0xe6e0d4,
      );
      material.shininess = heat ? 8 : 35;
      material.needsUpdate = true;
    });
  }, [heat, step]);

  useEffect(() => {
    measuringRef.current = measuring;
    if (!measuring) {
      measurePoints.current = [];
      markerGroup.current?.clear();
      setMeasured(null);
    }
  }, [measuring]);

  useEffect(() => {
    spinRef.current = spin;
  }, [spin]);

  // A plane that cuts the models open, for looking at intercuspation.
  useEffect(() => {
    const planes = clip > 0 ? [new THREE.Plane(new THREE.Vector3(0, 1, 0), clip)] : [];
    [meshes.current, ghosts.current].forEach((group) =>
      Object.values(group).forEach((mesh) => {
        if (mesh) (mesh.material as THREE.Material).clippingPlanes = planes;
      }),
    );
  }, [clip, step, heat, ghost]);

  useEffect(() => {
    (Object.keys(show) as ArchKey[]).forEach((arch) => {
      const mesh = meshes.current[arch];
      if (mesh) mesh.visible = show[arch];
      const shadow = ghosts.current[arch];
      if (shadow) shadow.visible = show[arch] && ghost;
    });
  }, [show, ghost]);

  useEffect(() => {
    if (!playing) return;
    const timer = setTimeout(() => {
      setStep((s) => (s + 1 >= stages.length ? 0 : s + 1));
    }, (busy ? 900 : 650) / speed);
    return () => clearTimeout(timer);
  }, [playing, step, busy, stages.length, speed]);

  // Arrow keys step, space plays.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.key === "ArrowRight") setStep((s) => Math.min(s + 1, stages.length - 1));
      if (e.key === "ArrowLeft") setStep((s) => Math.max(s - 1, 0));
      if (e.key === " ") {
        e.preventDefault();
        setPlaying((p) => !p);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stages.length]);

  function look(from: [number, number, number]) {
    const cam = camera.current;
    const orbit = controls.current;
    if (!cam || !orbit) return;
    const distance = cam.position.distanceTo(orbit.target);
    cam.position.set(
      orbit.target.x + from[0] * distance,
      orbit.target.y + from[1] * distance,
      orbit.target.z + from[2] * distance,
    );
    cam.lookAt(orbit.target);
  }

  function reset() {
    framed.current = false;
    const loaded = cache.current.values().next().value as Loaded | undefined;
    const distance = Math.max((loaded?.radius ?? 40) * 3.4, 70);
    controls.current?.target.set(0, 0, 0);
    camera.current?.position.set(0, -distance, distance * 0.12);
    camera.current?.lookAt(0, 0, 0);
  }

  function fullscreen() {
    const el = holder.current?.parentElement;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen?.();
  }

  function snapshot() {
    const renderer = rendererRef.current;
    if (!renderer || !scene.current || !camera.current) return;
    // The drawing buffer is cleared after each frame, so render once more
    // immediately before reading it.
    renderer.render(scene.current, camera.current);
    const link = document.createElement("a");
    link.download = `${simulation.order_reference}-step-${current?.step ?? 0}.png`;
    link.href = renderer.domElement.toDataURL("image/png");
    link.click();
  }

  const label = useMemo(() => {
    if (!current) return "";
    const parts = [`Step ${current.step} of ${stages[stages.length - 1]?.step ?? 0}`];
    if (current.upper?.kind) parts.push(`upper ${current.upper.kind}`);
    if (current.lower?.kind) parts.push(`lower ${current.lower.kind}`);
    return parts.join(" · ");
  }, [current, stages]);

  return (
    <div className="viewer">
      <div className="viewer-stage" ref={holder}>
        {busy && <div className="viewer-busy">Loading step {current?.step}…</div>}
        {error && <div className="viewer-error">{error}</div>}
      </div>

      <div className="viewer-controls stack-sm">
        <div className="row-between">
          <b className="num">{label}</b>
          <div className="row" style={{ gap: 6 }}>
            {(["upper", "lower"] as ArchKey[]).map((arch) => (
              <button
                key={arch}
                type="button"
                className={show[arch] ? "btn-dark btn-sm" : "btn-ghost btn-sm"}
                onClick={() => setShow((v) => ({ ...v, [arch]: !v[arch] }))}
              >
                {arch === "upper" ? "Upper" : "Lower"}
              </button>
            ))}
          </div>
        </div>

        <div className="row" style={{ gap: 10, alignItems: "center" }}>
          <button
            type="button"
            className="btn-primary"
            onClick={() => setPlaying((p) => !p)}
            style={{ minWidth: 84 }}
          >
            {playing ? "Pause" : "Play"}
          </button>
          <input
            type="range"
            min={0}
            max={Math.max(stages.length - 1, 0)}
            value={step}
            onChange={(e) => {
              setPlaying(false);
              setStep(Number(e.target.value));
            }}
            style={{ flex: 1 }}
          />
          <span className="dim num">
            {step + 1}/{stages.length}
          </span>
        </div>

        <div className="row" style={{ gap: 6 }}>
          <span className="dim">View</span>
          {Object.entries(VIEWS).map(([name, from]) => (
            <button key={name} type="button" className="btn-ghost btn-sm" onClick={() => look(from)}>
              {name}
            </button>
          ))}
          <button type="button" className="btn-ghost btn-sm" onClick={reset}>
            Reset
          </button>
          <button
            type="button"
            className={spin ? "btn-dark btn-sm" : "btn-ghost btn-sm"}
            onClick={() => setSpin((v) => !v)}
          >
            Spin
          </button>
          <button type="button" className="btn-ghost btn-sm" onClick={fullscreen}>
            Fullscreen
          </button>
          <button type="button" className="btn-ghost btn-sm" onClick={snapshot}>
            Snapshot
          </button>
        </div>

        <div className="row" style={{ gap: 6 }}>
          <button
            type="button"
            className={ghost ? "btn-dark btn-sm" : "btn-ghost btn-sm"}
            onClick={() => setGhost((v) => !v)}
          >
            Compare with start
          </button>
          <button
            type="button"
            className={heat ? "btn-dark btn-sm" : "btn-ghost btn-sm"}
            onClick={() => setHeat((v) => !v)}
          >
            Movement map
          </button>
          <button
            type="button"
            className={measuring ? "btn-dark btn-sm" : "btn-ghost btn-sm"}
            onClick={() => setMeasuring((v) => !v)}
          >
            {measured ? `Measured ${measured}` : measuring ? "Click two points" : "Measure"}
          </button>
          <span className="dim">Speed</span>
          <select
            value={speed}
            onChange={(e) => setSpeed(Number(e.target.value))}
            style={{ width: "auto" }}
          >
            <option value={0.5}>0.5×</option>
            <option value={1}>1×</option>
            <option value={2}>2×</option>
            <option value={4}>4×</option>
          </select>
        </div>

        <div className="row" style={{ gap: 10, alignItems: "center" }}>
          <span className="dim">Cross-section</span>
          <input
            type="range"
            min={0}
            max={30}
            value={clip}
            onChange={(e) => setClip(Number(e.target.value))}
            style={{ flex: 1, maxWidth: 220 }}
          />
          {clip > 0 && (
            <button type="button" className="btn-link" onClick={() => setClip(0)}>
              clear
            </button>
          )}
          {heat && maxMove > 0 && (
            <span className="heat-key">
              <i /> 0 mm — {maxMove.toFixed(1)} mm moved
            </span>
          )}
        </div>

        {/* Whether the occlusion on screen is the patient's own or a stand-in
            is a clinical fact, not a detail — it decides whether the overjet
            and overbite shown can be judged at all. */}
        <p className="bite-note">
          {art ? (
            <>
              <b>Bite from the patient's scans.</b>{" "}
              {art.method === "bite-registered"
                ? "Each arch was registered onto the bite registration scan."
                : "The bite registration confirms the arch scans are in occlusion."}{" "}
              Arches fitted to {art.rms_upper.toFixed(2)} mm (upper) and{" "}
              {art.rms_lower.toFixed(2)} mm (lower).
              {art.bite_median_mm !== null && (
                <> Bite scan agrees to {art.bite_median_mm.toFixed(2)} mm.</>
              )}
            </>
          ) : (
            <>
              <b>Nominal bite.</b> The arches are shown assembled with a {BITE_GAP_MM} mm
              clearance. Movement within each arch is still exact; the overjet and
              overbite are not.
              {simulation.articulation_note && (
                <> {simulation.articulation_note}</>
              )}
            </>
          )}
        </p>
      </div>
    </div>
  );
}
