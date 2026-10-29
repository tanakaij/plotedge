import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
export async function createScanViewer(
  host,
  blob,
  format,
  units,
  options = {},
) {
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: "low-power",
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
  renderer.setClearColor(0x101c29);
  host.replaceChildren(renderer.domElement);
  const scene = new THREE.Scene(),
    camera = new THREE.PerspectiveCamera(45, 1, 0.001, 10000000),
    controls = new OrbitControls(camera, renderer.domElement);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x607084, 2.5));
  const light = new THREE.DirectionalLight(0xffffff, 3);
  light.position.set(5, 8, 3);
  scene.add(light);
  let root,
    worker,
    disposed = false,
    measuring = false,
    points = [],
    markers = [],
    line = null,
    origin = [0, 0, 0],
    pointCloud = false,
    radius = 1,
    unit = units;
  function render() {
    if (!disposed) renderer.render(scene, camera);
  }
  function resize() {
    if (disposed) return;
    const w = host.clientWidth || 300,
      h = host.clientHeight || 360;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    render();
  }
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  controls.addEventListener("change", render);
  function reset() {
    if (!root) return;
    const box = new THREE.Box3().setFromObject(root),
      center = box.getCenter(new THREE.Vector3());
    radius = Math.max(box.getSize(new THREE.Vector3()).length(), 0.001);
    controls.target.copy(center);
    camera.position
      .copy(center)
      .add(new THREE.Vector3(0.85, 0.6, 1).multiplyScalar(radius));
    camera.near = Math.max(radius / 10000, 0.00001);
    camera.far = Math.max(radius * 100, 100);
    camera.updateProjectionMatrix();
    controls.update();
    resize();
  }
  function clearMarkers() {
    markers.forEach((m) => {
      scene.remove(m);
      m.geometry.dispose();
      m.material.dispose();
    });
    markers = [];
    if (line) {
      scene.remove(line);
      line.geometry.dispose();
      line.material.dispose();
      line = null;
    }
    points = [];
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    if (worker) worker.terminate();
    observer.disconnect();
    controls.dispose();
    renderer.domElement.removeEventListener("pointerdown", down);
    renderer.domElement.removeEventListener("pointerup", up);
    clearMarkers();
    scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      (o.material
        ? Array.isArray(o.material)
          ? o.material
          : [o.material]
        : []
      ).forEach((m) => {
        Object.values(m).forEach((v) => {
          if (v && v.isTexture) {
            if (v.image && v.image.close) v.image.close();
            v.dispose();
          }
        });
        m.dispose();
      });
    });
    renderer.dispose();
    renderer.forceContextLoss();
    renderer.domElement.remove();
  }
  let pointer = null;
  function down(e) {
    pointer = { x: e.clientX, y: e.clientY };
  }
  function up(e) {
    if (
      !measuring ||
      !root ||
      !pointer ||
      Math.hypot(e.clientX - pointer.x, e.clientY - pointer.y) > 7
    )
      return;
    const r = renderer.domElement.getBoundingClientRect(),
      mouse = new THREE.Vector2(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        (-(e.clientY - r.top) / r.height) * 2 + 1,
      ),
      ray = new THREE.Raycaster();
    ray.params.Points.threshold = radius * 0.012;
    ray.setFromCamera(mouse, camera);
    const hit = ray.intersectObject(root, true)[0];
    if (!hit) return;
    const p = hit.point.clone();
    if (pointCloud && hit.index != null)
      p.fromBufferAttribute(
        root.geometry.attributes.position,
        hit.index,
      ).applyMatrix4(root.matrixWorld);
    points.push(p);
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(radius * 0.006, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0x5ae6cb, depthTest: false }),
    );
    m.position.copy(p);
    m.renderOrder = 999;
    scene.add(m);
    markers.push(m);
    if (points.length === 2) {
      line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(points),
        new THREE.LineBasicMaterial({ color: 0x5ae6cb, depthTest: false }),
      );
      line.renderOrder = 998;
      scene.add(line);
      const factor = { m: 1, cm: 0.01, mm: 0.001 }[unit];
      if (factor)
        options.onMeasure?.({
          metres: points[0].distanceTo(points[1]) * factor,
          points: points.map((p) => p.toArray().map((v, i) => v + origin[i])),
          units: unit,
        });
      measuring = false;
      renderer.domElement.style.cursor = "grab";
    }
    render();
  }
  renderer.domElement.addEventListener("pointerdown", down);
  renderer.domElement.addEventListener("pointerup", up);
  try {
    const buffer = await blob.arrayBuffer();
    if (format === "ply") {
      pointCloud = true;
      const cloud = await new Promise((resolve, reject) => {
        worker = new Worker(options.workerUrl, { type: "module" });
        worker.onmessage = (e) => {
          worker.terminate();
          worker = null;
          e.data.ok ? resolve(e.data) : reject(new Error(e.data.error));
        };
        worker.onerror = () => {
          worker.terminate();
          worker = null;
          reject(new Error("Point cloud preview could not be read."));
        };
        worker.postMessage(buffer, [buffer]);
      });
      origin = cloud.origin;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        "position",
        new THREE.BufferAttribute(cloud.positions, 3),
      );
      if (cloud.colors)
        geometry.setAttribute(
          "color",
          new THREE.BufferAttribute(cloud.colors, 3),
        );
      root = new THREE.Points(
        geometry,
        new THREE.PointsMaterial({
          size: 2,
          sizeAttenuation: false,
          vertexColors: !!cloud.colors,
          color: cloud.colors ? 0xffffff : 0x5ae6cb,
        }),
      );
      options.onStatus?.(
        cloud.displayed.toLocaleString() +
          " preview points · " +
          cloud.count.toLocaleString() +
          " in original" +
          (cloud.count > cloud.displayed ? " · preview sampled" : ""),
      );
    } else {
      const v = new DataView(buffer),
        len = v.getUint32(12, true);
      if (
        v.getUint32(16, true) !== 0x4e4f534a ||
        len > 8388608 ||
        20 + len > buffer.byteLength
      )
        throw new Error("Invalid GLB metadata.");
      const json = JSON.parse(
          new TextDecoder().decode(buffer.slice(20, 20 + len)),
        ),
        count = (json.meshes || [])
          .flatMap((m) => m.primitives || [])
          .reduce(
            (n, p) =>
              n + Number(json.accessors?.[p.attributes?.POSITION]?.count || 0),
            0,
          );
      if (count > 2000000)
        throw new Error(
          "Simplify this model below 2 million vertices for mobile preview.",
        );
      if (
        [...(json.buffers || []), ...(json.images || [])].some(
          (r) => r.uri && !r.uri.startsWith("data:"),
        )
      )
        throw new Error("Export a self-contained GLB with embedded textures.");
      const manager = new THREE.LoadingManager();
      manager.setURLModifier((url) => {
        if (!/^(blob:|data:)/.test(url))
          throw new Error("External model resources are not loaded.");
        return url;
      });
      const gltf = await new GLTFLoader(manager).parseAsync(buffer, "");
      root = gltf.scene;
      options.onStatus?.(
        count.toLocaleString() + " model vertices · original preserved",
      );
    }
    scene.add(root);
    reset();
    return {
      reset,
      dispose,
      setUnits: (v) => {
        unit = v;
        clearMarkers();
        render();
      },
      measure: () => {
        clearMarkers();
        measuring = true;
        renderer.domElement.style.cursor = "crosshair";
        render();
      },
    };
  } catch (e) {
    dispose();
    throw e;
  }
}
