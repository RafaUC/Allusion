import path from 'node:path';
import { pathToFileURL } from 'node:url';
import React, { useEffect, useRef } from 'react';

const SPLAT_EXTENSIONS = new Set(['ply', 'spz', 'splat', 'ksplat', 'sog', 'rad']);

interface ModelViewerProps {
  absolutePath: string;
  width: number;
  height: number;
}

const ModelViewer: React.FC<ModelViewerProps> = ({ absolutePath, width, height }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<any>(null);

  // Resize renderer when container dimensions change
  useEffect(() => {
    const r = rendererRef.current;
    if (!r) return;
    r.setSize(width, height, false);
    r.camera?.updateProjectionMatrix?.();
  }, [width, height]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let animationId: number;
    let disposed = false;
    let cleanupFn: (() => void) | undefined;

    (async () => {
      const THREE = await import('three');
      const { OrbitControls } = await import(
        'three/examples/jsm/controls/OrbitControls.js' as string
      );
      if (disposed) return;

      const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
      renderer.setPixelRatio(window.devicePixelRatio);
      renderer.setSize(width, height, false);
      renderer.setClearColor(0x111111, 1);

      const camera = new THREE.PerspectiveCamera(45, width / height, 0.01, 4000);
      // Expose to resize effect
      (renderer as any).camera = camera;
      rendererRef.current = renderer;

      const scene = new THREE.Scene();
      const ambient = new THREE.AmbientLight(0xffffff, 0.6);
      const key = new THREE.DirectionalLight(0xffffff, 0.9);
      key.position.set(1.5, 2, 3);
      const rim = new THREE.DirectionalLight(0xffffff, 0.35);
      rim.position.set(-1.2, 0.5, -2.2);
      scene.add(ambient, key, rim);

      const controls = new OrbitControls(camera, canvas);
      controls.enableDamping = true;
      controls.dampingFactor = 0.05;

      const ext = path.extname(absolutePath).slice(1).toLowerCase();
      const fileUrl = pathToFileURL(absolutePath).toString();

      let sparkRenderer: any;
      let modelRoot: any;

      if (SPLAT_EXTENSIONS.has(ext)) {
        const spark = await import('@sparkjsdev/spark');
        if (disposed) return;
        sparkRenderer = new spark.SparkRenderer({ renderer, enableLod: true });
        scene.add(sparkRenderer);
        const splat = new spark.SplatMesh({
          url: fileUrl,
          fileName: path.basename(absolutePath),
        });
        await splat.initialized;
        if (disposed) return;
        scene.add(splat);
        modelRoot = splat;
      } else if (ext === 'glb' || ext === 'gltf') {
        const { GLTFLoader } = await import(
          'three/examples/jsm/loaders/GLTFLoader.js' as string
        );
        if (disposed) return;
        const gltf = await new GLTFLoader().loadAsync(fileUrl);
        if (disposed) return;
        scene.add(gltf.scene);
        modelRoot = gltf.scene;
      } else if (ext === 'obj') {
        const { OBJLoader } = await import(
          'three/examples/jsm/loaders/OBJLoader.js' as string
        );
        if (disposed) return;
        const obj = await new OBJLoader().loadAsync(fileUrl);
        if (disposed) return;
        scene.add(obj);
        modelRoot = obj;
      }

      if (modelRoot) {
        const box = new THREE.Box3().setFromObject(modelRoot);
        if (!box.isEmpty()) {
          const center = box.getCenter(new THREE.Vector3());
          const size = box.getSize(new THREE.Vector3());
          const radius = Math.max(size.x, size.y, size.z) * 0.5 || 1;
          const fovR = (camera.fov * Math.PI) / 180;
          const distance = (radius / Math.tan(fovR / 2)) * 1.35;
          camera.near = Math.max(0.01, distance / 200);
          camera.far = Math.max(1000, distance * 80);
          camera.position.set(
            center.x + distance * 0.6,
            center.y + distance * 0.35,
            center.z + distance,
          );
          camera.lookAt(center);
          camera.updateProjectionMatrix();
          controls.target.copy(center);
          controls.update();
        } else {
          camera.position.set(0.6, 0.4, 1.5);
          camera.lookAt(0, 0, 0);
        }
      }

      const animate = () => {
        animationId = requestAnimationFrame(animate);
        controls.update();
        renderer.render(scene, camera);
      };
      animate();

      cleanupFn = () => {
        cancelAnimationFrame(animationId);
        controls.dispose();
        rendererRef.current = null;
        modelRoot?.traverse?.((node: any) => {
          node.geometry?.dispose();
          if (Array.isArray(node.material)) node.material.forEach((m: any) => m?.dispose?.());
          else node.material?.dispose?.();
        });
        if (typeof modelRoot?.dispose === 'function') modelRoot.dispose();
        renderer.dispose();
      };
    })().catch(console.error);

    return () => {
      disposed = true;
      cleanupFn?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [absolutePath]);

  return (
    <canvas
      ref={canvasRef}
      style={{ display: 'block', width, height, cursor: 'grab' }}
    />
  );
};

export default ModelViewer;
