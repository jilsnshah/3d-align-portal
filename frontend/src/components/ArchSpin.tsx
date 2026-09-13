/* A real upper arch, turning, inside the curve of the arch diagram.
 *
 * The hero's arch is a drawing of the journey; the space inside it held only a
 * number. This puts the thing the lab actually works on in that space, so the
 * panel reads as 3D Align's own rather than as a generic dashboard chart.
 *
 * The model is a scan of a patient's upper teeth published by NIH 3D as
 * 3DPX-003002 ("Upper dental tooth model", Michael D Scherer DMD MS FACP),
 * dedicated to the public domain under CC0. The original is 95 MB and nearly
 * two million triangles; what ships here is that mesh reduced to about forty
 * thousand, which is more than enough at the size it is drawn. See
 * public/models/ATTRIBUTION.md.
 *
 * It is decoration, and it behaves like it: nothing is clickable, it is hidden
 * from screen readers, it stops when the tab is not being looked at, and a
 * reader who has asked for less motion gets one still frame instead. Where
 * WebGL is unavailable, or the model fails to load, it renders nothing at all
 * and the number stands alone.
 */

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const MODEL = "/models/upper-arch.glb";

export default function ArchSpin({ className = "" }: { className?: string }) {
  const holder = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = holder.current;
    if (!host) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      return; // No WebGL: the arch keeps its number and loses nothing else.
    }

    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
    camera.position.set(0, 0.82, 2.5);
    camera.lookAt(0, 0, 0);

    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    host.appendChild(renderer.domElement);
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    renderer.domElement.style.display = "block";

    const rig = new THREE.Group();
    // Tipped forward, so the arch is read as a shape sitting in space rather
    // than as a ring seen edge-on.
    rig.rotation.x = 0.34;
    scene.add(rig);

    /* Gold from one side, cool white from the other: the hero is nearly black,
       and a single light leaves the model a silhouette. */
    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const gold = new THREE.DirectionalLight(0xf1d57a, 3.4);
    gold.position.set(2.2, 2.4, 1.6);
    scene.add(gold);
    const cool = new THREE.DirectionalLight(0xbfd4ff, 1.2);
    cool.position.set(-2.4, 1.0, -1.6);
    scene.add(cool);
    const rim = new THREE.PointLight(0xffffff, 5, 12);
    rim.position.set(0, 1.6, -2.0);
    scene.add(rim);

    let mesh: THREE.Mesh | null = null;
    let dead = false;
    const material = new THREE.MeshPhysicalMaterial({
      color: 0xfaf6ee,
      roughness: 0.38,
      metalness: 0,
      clearcoat: 0.55,
      clearcoatRoughness: 0.3,
    });

    new GLTFLoader().load(
      MODEL,
      (gltf) => {
        if (dead) return;
        const found = gltf.scene.getObjectByProperty("type", "Mesh") as THREE.Mesh | undefined;
        if (!found) return;
        mesh = found;
        mesh.material = material;
        /* The export is centred on the origin and two units across its widest
           axis. It is stored crowns-down, sitting on its printable base, so it
           is turned over: the teeth are the half worth looking at. */
        mesh.rotation.x = Math.PI;
        mesh.scale.setScalar(0.82);
        rig.add(mesh);
      },
      undefined,
      () => {
        /* A missing model leaves the arch as it was before there was one. */
      },
    );

    function size() {
      const w = host!.clientWidth;
      const h = host!.clientHeight;
      if (w === 0 || h === 0) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
    size();
    const watch = new ResizeObserver(size);
    watch.observe(host);

    let frame = 0;
    let last = performance.now();
    function draw(now: number) {
      frame = requestAnimationFrame(draw);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (document.hidden) return;
      rig.rotation.y += dt * 0.4;
      // A slight nod, so it never looks like a GIF loop.
      rig.rotation.x = 0.34 + Math.sin(now / 2600) * 0.05;
      renderer.render(scene, camera);
    }
    if (still) {
      rig.rotation.y = 0.5;
      // The model arrives after this runs, so the one frame is drawn on load.
      const once = window.setInterval(() => {
        renderer.render(scene, camera);
        if (mesh) window.clearInterval(once);
      }, 200);
      window.setTimeout(() => window.clearInterval(once), 8000);
    } else {
      frame = requestAnimationFrame(draw);
    }

    return () => {
      dead = true;
      cancelAnimationFrame(frame);
      watch.disconnect();
      if (mesh) mesh.geometry.dispose();
      material.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  return <div className={`arch-spin ${className}`.trim()} ref={holder} aria-hidden="true" />;
}
