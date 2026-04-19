import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SPLAT_EXTENSIONS = ['ply', 'spz', 'splat', 'ksplat', 'sog', 'rad'] as const;
const MESH_EXTENSIONS = ['glb', 'gltf', 'obj'] as const;

const SPLAT_EXTENSION_SET = new Set<string>(SPLAT_EXTENSIONS);
const MESH_EXTENSION_SET = new Set<string>(MESH_EXTENSIONS);

export function isSparkSplatPath(filePath: string): boolean {
  return SPLAT_EXTENSION_SET.has(getExtension(filePath));
}

export function isMeshModelPath(filePath: string): boolean {
  return MESH_EXTENSION_SET.has(getExtension(filePath));
}

export function isRenderable3DModelPath(filePath: string): boolean {
  return isSparkSplatPath(filePath) || isMeshModelPath(filePath);
}

export async function renderModelPreviewBlob(filePath: string, size = 512): Promise<Blob> {
  if (!isRenderable3DModelPath(filePath)) {
    throw new Error(`Unsupported model file format: ${filePath}`);
  }

  const THREE = await import('three');
  const canvas = new OffscreenCanvas(size, size);
  const renderer = new THREE.WebGLRenderer({
    canvas: canvas as unknown as HTMLCanvasElement,
    antialias: true,
    alpha: true,
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(1);
  renderer.setSize(size, size, false);
  renderer.setClearColor(0x111111, 1);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 4000);

  const ambient = new THREE.AmbientLight(0xffffff, 0.6);
  const key = new THREE.DirectionalLight(0xffffff, 0.9);
  key.position.set(1.5, 2, 3);
  const rim = new THREE.DirectionalLight(0xffffff, 0.35);
  rim.position.set(-1.2, 0.5, -2.2);
  scene.add(ambient, key, rim);

  const ext = getExtension(filePath);
  const modelRoot = await loadModelRoot(filePath, ext, scene, renderer);
  frameObject(modelRoot, camera, THREE);

  if (SPLAT_EXTENSION_SET.has(ext)) {
    // Spark loads splat data asynchronously in background workers even after `splat.initialized`.
    // Render frames until a non-background pixel appears in the center, or time out after 5s.
    const gl = renderer.getContext();
    const pixel = new Uint8Array(4);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      renderer.render(scene, camera);
      gl.readPixels(size >> 1, size >> 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      // Background is 0x111111 — if center pixel differs, splat data has landed
      if (pixel[0] !== 0x11 || pixel[1] !== 0x11 || pixel[2] !== 0x11) {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 33));
    }
  } else {
    for (let i = 0; i < 3; i++) {
      renderer.render(scene, camera);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }

  const blob = await canvas.convertToBlob({ type: 'image/png', quality: 1 });

  disposeObjectTree(modelRoot);
  renderer.dispose();

  return blob;
}

async function loadModelRoot(
  filePath: string,
  ext: string,
  scene: any,
  renderer: any,
): Promise<any> {
  const fileUrl = pathToFileURL(filePath).toString();

  if (SPLAT_EXTENSION_SET.has(ext)) {
    const spark = await import('@sparkjsdev/spark');
    const sparkRenderer = new spark.SparkRenderer({ renderer, enableLod: false });
    scene.add(sparkRenderer);

    const splat = new spark.SplatMesh({
      url: fileUrl,
      fileName: path.basename(filePath),
    });
    await splat.initialized;
    scene.add(splat);
    return splat;
  }

  if (ext === 'glb' || ext === 'gltf') {
    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync(fileUrl);
    scene.add(gltf.scene);
    return gltf.scene;
  }

  if (ext === 'obj') {
    const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader.js');
    const loader = new OBJLoader();
    const obj = await loader.loadAsync(fileUrl);
    scene.add(obj);
    return obj;
  }

  throw new Error(`Model format not implemented: ${filePath}`);
}

function frameObject(object: any, camera: any, THREE: any): void {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) {
    camera.position.set(0.6, 0.4, 1.5);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    return;
  }

  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z) * 0.5 || 1;
  const fovRadians = (camera.fov * Math.PI) / 180;
  const distance = (radius / Math.tan(fovRadians / 2)) * 1.35;

  camera.near = Math.max(0.01, distance / 200);
  camera.far = Math.max(1000, distance * 80);
  camera.position.set(center.x + distance * 0.6, center.y + distance * 0.35, center.z + distance);
  camera.lookAt(center);
  camera.updateProjectionMatrix();
}

function disposeObjectTree(root: any): void {
  root.traverse((node: any) => {
    if (node.geometry?.dispose) {
      node.geometry.dispose();
    }

    const material = node.material;
    if (Array.isArray(material)) {
      material.forEach((entry) => entry?.dispose?.());
    } else if (material?.dispose) {
      material.dispose();
    }
  });

  if (typeof root.dispose === 'function') {
    root.dispose();
  }
}

function getExtension(filePath: string): string {
  return path.extname(filePath).slice(1).toLowerCase();
}
