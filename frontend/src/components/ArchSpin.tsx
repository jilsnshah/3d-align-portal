/* A clear aligner, turning, inside the curve of the arch diagram.
 *
 * The hero's arch is a drawing of the journey; the space inside it held only a
 * number. This puts the thing the lab actually makes in that space — a shell
 * with teeth in it, lit from two sides and turning slowly — so the panel reads
 * as 3D Align's own rather than as a generic dashboard chart.
 *
 * It is decoration, and it behaves like it: nothing is clickable, it is hidden
 * from screen readers, it stops when the tab is not being looked at, and a
 * reader who has asked for less motion gets one still frame instead. Where
 * WebGL is unavailable it renders nothing at all and the number stands alone.
 */

import { useEffect, useRef } from "react";
import * as THREE from "three";

/** The arch the aligner is built on: half an ellipse, widening at the back. */
function archCurve(): THREE.CatmullRomCurve3 {
  const points: THREE.Vector3[] = [];
  for (let i = 0; i <= 24; i += 1) {
    const t = i / 24;
    // 200° of arc rather than 180°, so the ends turn inwards the way real
    // arches do instead of stopping flat.
    const a = Math.PI * (1.06 - 1.12 * t);
    const rx = 1.0;
    const rz = 1.22;
    points.push(new THREE.Vector3(Math.cos(a) * rx, 0, -Math.sin(a) * rz));
  }
  return new THREE.CatmullRomCurve3(points, false, "catmullrom", 0.4);
}

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
    const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
    camera.position.set(0, 1.42, 2.95);
    camera.lookAt(0, -0.05, 0);

    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    host.appendChild(renderer.domElement);
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    renderer.domElement.style.display = "block";

    const rig = new THREE.Group();
    // Tipped forward, so the arch is read as a shape sitting in space rather
    // than as a ring seen edge-on.
    rig.rotation.x = 0.42;
    scene.add(rig);

    const curve = archCurve();

    /* The shell. Transmission would be truer to a real aligner and costs far
       more to draw than a decoration on a dashboard is worth, so this is a
       thin translucent skin with a strong specular instead. */
    const shell = new THREE.Mesh(
      new THREE.TubeGeometry(curve, 220, 0.115, 14, false),
      new THREE.MeshPhysicalMaterial({
        color: 0xf4f1e6,
        transparent: true,
        opacity: 0.36,
        roughness: 0.1,
        metalness: 0,
        clearcoat: 1,
        clearcoatRoughness: 0.08,
        side: THREE.DoubleSide,
      }),
    );
    // Taller than it is thick: an aligner is a band down the side of a tooth.
    shell.scale.y = 1.75;
    rig.add(shell);

    /* The teeth inside it. Rounded blocks rather than spheres — a sphere reads
       as a bead, and a row of beads is a bracelet, not an arch. */
    const tooth = new THREE.SphereGeometry(0.085, 18, 14);
    const enamel = new THREE.MeshPhysicalMaterial({
      color: 0xfbf7ee,
      roughness: 0.34,
      metalness: 0,
      clearcoat: 0.6,
      clearcoatRoughness: 0.3,
    });
    const teeth = new THREE.Group();
    const COUNT = 14;
    for (let i = 0; i < COUNT; i += 1) {
      const t = (i + 0.5) / COUNT;
      const at = curve.getPointAt(t);
      const m = new THREE.Mesh(tooth, enamel);
      m.position.copy(at);
      // Front teeth narrow and tall, molars wider and flatter.
      const front = 1 - Math.abs(t - 0.5) * 2;
      m.scale.set(0.85 + 0.5 * (1 - front), 1.5 - 0.35 * (1 - front), 0.9 + 0.35 * (1 - front));
      teeth.add(m);
    }
    rig.add(teeth);

    // Gold from one side, cool white from the other: the hero is nearly black,
    // and a single light makes the shell disappear into it.
    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const gold = new THREE.DirectionalLight(0xf1d57a, 3.2);
    gold.position.set(2.2, 2.4, 1.6);
    scene.add(gold);
    const cool = new THREE.DirectionalLight(0xbfd4ff, 1.1);
    cool.position.set(-2.4, 0.8, -1.8);
    scene.add(cool);
    const rim = new THREE.PointLight(0xffffff, 6, 12);
    rim.position.set(0, 1.4, -2.2);
    scene.add(rim);

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
      if (!document.hidden) {
        rig.rotation.y += dt * 0.45;
        // A slight nod, so it never looks like a GIF loop.
        rig.rotation.x = 0.42 + Math.sin(now / 2600) * 0.06;
        renderer.render(scene, camera);
      }
    }
    if (still) {
      rig.rotation.y = 0.6;
      renderer.render(scene, camera);
    } else {
      frame = requestAnimationFrame(draw);
    }

    return () => {
      cancelAnimationFrame(frame);
      watch.disconnect();
      renderer.dispose();
      shell.geometry.dispose();
      (shell.material as THREE.Material).dispose();
      tooth.dispose();
      enamel.dispose();
      renderer.domElement.remove();
    };
  }, []);

  return <div className={`arch-spin ${className}`.trim()} ref={holder} aria-hidden="true" />;
}
