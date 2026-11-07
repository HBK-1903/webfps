// Test-only shim: all of Three.js is real except WebGLRenderer, which needs a
// GPU/WebGL context that jsdom cannot provide. Rendering is a no-op here, but
// every object, material and matrix the game builds is the real thing.
export * from '../../node_modules/three/build/three.module.js';

export class WebGLRenderer {
  constructor(params = {}) {
    this.domElement = params.canvas || { style: {}, getContext: () => null };
    this.shadowMap = { enabled: false, type: 0, needsUpdate: false };
    this.outputColorSpace = '';
    this.toneMapping = 0;
    this.toneMappingExposure = 1;
    this.info = { render: { calls: 0, triangles: 0 }, memory: { geometries: 0, textures: 0 } };
    this.renderCount = 0;
    globalThis.__rendererInstances = (globalThis.__rendererInstances || 0) + 1;
  }
  setPixelRatio() {}
  setSize() {}
  setClearColor() {}
  setAnimationLoop() {}
  compile() {}
  dispose() {}
  clear() {}
  render(scene, camera) {
    this.renderCount += 1;
    globalThis.__renderCount = (globalThis.__renderCount || 0) + 1;
    if (!scene || !camera) throw new Error('render() called without a scene or camera');
  }
}
