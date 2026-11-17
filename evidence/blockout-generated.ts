import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export type ProceduralModelOptions = {
  wireframe?: boolean;
  castShadow?: boolean;
  receiveShadow?: boolean;
  textureSize?: number;
  textureAnisotropy?: number;
  qualityPriority?: 'reference-fidelity' | 'balanced';
};

export type ProceduralModelRuntime = {
  nodes: Record<string, THREE.Object3D>;
  meshes: Record<string, THREE.Mesh>;
  sockets: Record<string, THREE.Object3D>;
  colliders: Record<string, unknown>;
  destructionGroups: Record<string, THREE.Object3D[]>;
};

type SculptMaterialSpec = Record<string, any>;

// bevelEnabled defaults to true on THREE.ExtrudeGeometry and rounds every
// corner — sharp/pointed profiles (blades, fork tines, spikes) need
// bevelEnabled: false plus lineTo()-only path segments near the tip, since a
// curve command cannot produce a true converging point.
function buildExtrudeShape(points: [number, number][], holes?: [number, number][][]): THREE.Shape {
  const shape = new THREE.Shape();
  if (points.length > 0) {
    shape.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i += 1) {
      shape.lineTo(points[i][0], points[i][1]);
    }
  }
  // Cutouts (e.g. an oval wire-cutter hole) as THREE.Path added to shape.holes —
  // dep-free boolean subtraction via the tessellator, no CSG library needed.
  for (const loop of holes ?? []) {
    if (loop.length < 3) continue;
    const path = new THREE.Path();
    path.moveTo(loop[0][0], loop[0][1]);
    for (let i = 1; i < loop.length; i += 1) path.lineTo(loop[i][0], loop[i][1]);
    path.closePath();
    shape.holes.push(path);
  }
  return shape;
}

// Build an N-gon oval loop (for hole authoring from a compact {cx,cy,rx,ry} descriptor).
function ovalLoop(cx: number, cy: number, rx: number, ry: number, seg = 24): [number, number][] {
  const loop: [number, number][] = [];
  for (let i = 0; i < seg; i += 1) {
    const a = (i / seg) * Math.PI * 2;
    loop.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return loop;
}

function buildExtrudeGeometry(profile: { points: [number, number][]; depth: number; holes?: [number, number][][]; ovalHoles?: { cx: number; cy: number; rx: number; ry: number }[] }): THREE.ExtrudeGeometry {
  const holes = [...(profile.holes ?? []), ...((profile.ovalHoles ?? []).map((o) => ovalLoop(o.cx, o.cy, o.rx, o.ry)))];
  const shape = buildExtrudeShape(profile.points, holes);
  return new THREE.ExtrudeGeometry(shape, {
    depth: profile.depth,
    bevelEnabled: false,
    steps: 1,
  });
}

function buildLatheGeometry(profile: { points: [number, number][]; segments?: number }): THREE.LatheGeometry {
  const points = profile.points.map(([x, y]) => new THREE.Vector2(Math.max(0.0001, x), y));
  return new THREE.LatheGeometry(points, profile.segments ?? 24);
}

function buildTubeGeometry(
  path: { points: [number, number, number][]; radius?: number; radialSegments?: number; closed?: boolean },
): THREE.TubeGeometry {
  const vectors = path.points.map(([x, y, z]) => new THREE.Vector3(x, y, z));
  const curve = new THREE.CatmullRomCurve3(vectors, path.closed ?? false);
  const tubularSegments = Math.max(8, path.points.length * 6);
  return new THREE.TubeGeometry(curve, tubularSegments, path.radius ?? 0.05, path.radialSegments ?? 8, path.closed ?? false);
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function readLayerNumber(value: unknown, keys: string[], fallback: number): number {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of keys) {
      if (typeof record[key] === 'number') return record[key] as number;
    }
  }
  return fallback;
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = /^#[0-9a-f]{3}$/i.test(hex)
    ? '#' + hex.slice(1).split('').map((part) => part + part).join('')
    : hex;
  const value = /^#[0-9a-f]{6}$/i.test(normalized) ? Number.parseInt(normalized.slice(1), 16) : 0x8a7a5f;
  return [clampAlbedoChannel((value >> 16) & 255), clampAlbedoChannel((value >> 8) & 255), clampAlbedoChannel(value & 255)];
}

function materialPalette(spec: SculptMaterialSpec): string[] {
  const palette = spec.colorVariation?.palette;
  if (Array.isArray(palette) && palette.length > 0) return palette.filter((value) => typeof value === 'string');
  const secondary = spec.albedo?.secondary;
  const colors = [spec.baseColor ?? spec.color ?? spec.albedo?.dominant, ...(Array.isArray(secondary) ? secondary : [])];
  return colors.filter((value): value is string => typeof value === 'string' && value.startsWith('#'));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampAlbedoChannel(value: number): number {
  return Math.max(30, Math.min(240, Math.round(value)));
}

function clampPbrF0(value: number): number {
  return Math.max(0.02, Math.min(1, value));
}

function clampPbrIor(value: number): number {
  return Math.max(1, Math.min(2.5, value));
}

function clampPbrMetalness(value: number): number {
  return value >= 0.5 ? 1 : 0;
}

function clampedAlbedoColor(spec: SculptMaterialSpec): THREE.Color {
  const source = typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F';
  // setStyle with an explicit SRGBColorSpace, NOT the numeric constructor.
  //
  // `new THREE.Color(r, g, b)` treats its arguments as LINEAR working-space components,
  // while an authored `baseColor` hex is sRGB. Feeding one to the other skipped the
  // transfer function and lifted every dark albedo: #2e2a28, authored as a near-black
  // vinyl, rendered at roughly sRGB 0.46 — a mid grey. The error is largest exactly where
  // it matters most, because the transfer curve is steepest near black.
  return new THREE.Color().setStyle(source, THREE.SRGBColorSpace);
}

function smoothCurve(value: number): number {
  return value * value * (3 - 2 * value);
}

function periodicHash(x: number, y: number, seed: number, periodX: number, periodY: number): number {
  const wrappedX = ((x % periodX) + periodX) % periodX;
  const wrappedY = ((y % periodY) + periodY) % periodY;
  let value = Math.imul(wrappedX + seed * 17, 374761393) ^ Math.imul(wrappedY + seed * 31, 668265263);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}

function periodicValueNoise(u: number, v: number, seed: number, periodX: number, periodY: number): number {
  const x = u * periodX;
  const y = v * periodY;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = smoothCurve(x - x0);
  const ty = smoothCurve(y - y0);
  const a = periodicHash(x0, y0, seed, periodX, periodY);
  const b = periodicHash(x0 + 1, y0, seed, periodX, periodY);
  const c = periodicHash(x0, y0 + 1, seed, periodX, periodY);
  const d = periodicHash(x0 + 1, y0 + 1, seed, periodX, periodY);
  return THREE.MathUtils.lerp(THREE.MathUtils.lerp(a, b, tx), THREE.MathUtils.lerp(c, d, tx), ty);
}

type SurfaceBand = {
  frequency: number;
  amplitude: number;
  stretchX: number;
  stretchY: number;
  ridge: boolean;
};

function surfaceBands(spec: SculptMaterialSpec): SurfaceBand[] {
  const source = Array.isArray(spec.surfaceFrequencyBands) ? spec.surfaceFrequencyBands : [];
  const parsed = source.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return [];
    const band = item as Record<string, unknown>;
    const frequency = typeof band.frequency === 'number' ? band.frequency : 0;
    const amplitude = typeof band.amplitude === 'number' ? band.amplitude : 0;
    if (frequency <= 0 || amplitude <= 0) return [];
    const stretch = Array.isArray(band.stretch) ? band.stretch : [1, 1];
    const description = `${String(band.pattern ?? '')} ${String(band.role ?? '')}`.toLowerCase();
    return [{
      frequency,
      amplitude,
      stretchX: typeof stretch[0] === 'number' ? Math.max(0.1, stretch[0]) : 1,
      stretchY: typeof stretch[1] === 'number' ? Math.max(0.1, stretch[1]) : 1,
      ridge: /(ridge|groove|grain|fiber|striated|crack)/.test(description),
    }];
  });
  return parsed.length > 0 ? parsed : [
    { frequency: 2, amplitude: 0.42, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 12, amplitude: 0.22, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 56, amplitude: 0.08, stretchX: 1, stretchY: 1, ridge: false },
  ];
}

function sampleSurface(u: number, v: number, bands: SurfaceBand[], seed: number): number {
  let value = 0;
  let weight = 0;
  for (let index = 0; index < bands.length; index += 1) {
    const band = bands[index];
    const periodX = Math.max(1, Math.round(band.frequency * band.stretchX));
    const periodY = Math.max(1, Math.round(band.frequency * band.stretchY));
    let sample = periodicValueNoise(u, v, seed + index * 1013, periodX, periodY);
    if (band.ridge) sample = 1 - Math.abs(sample * 2 - 1);
    value += sample * band.amplitude;
    weight += band.amplitude;
  }
  return weight > 0 ? clamp01(value / weight) : 0.5;
}

function mixPalette(colors: [number, number, number][], value: number): [number, number, number] {
  if (colors.length === 1) return colors[0];
  const scaled = clamp01(value) * (colors.length - 1);
  const index = Math.min(colors.length - 2, Math.floor(scaled));
  const mix = scaled - index;
  const a = colors[index];
  const b = colors[index + 1];
  return [
    Math.round(THREE.MathUtils.lerp(a[0], b[0], mix)),
    Math.round(THREE.MathUtils.lerp(a[1], b[1], mix)),
    Math.round(THREE.MathUtils.lerp(a[2], b[2], mix)),
  ];
}

type ColorGradientStop = { offset: number; color: string };
type ColorGradientSpec = {
  type: 'linear' | 'radial';
  axis: [number, number];
  stops: ColorGradientStop[];
};

function parseRgba(value: string): [number, number, number] {
  const match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(value);
  if (!match) return [138, 122, 95];
  return [clampAlbedoChannel(Number(match[1])), clampAlbedoChannel(Number(match[2])), clampAlbedoChannel(Number(match[3]))];
}

// Analytical per-pixel gradient sample. The extraction schema's colorGradient carries
// exact rgba(...) stop colors (see extract_part_color_recipe.py), so this samples the
// same trend directly in JS math rather than round-tripping through a Canvas 2D
// createLinearGradient/createRadialGradient object — same visual result, and it composes
// directly with the existing noise/height-correlated colorVariation blend below.
function sampleColorGradient(gradient: ColorGradientSpec, u: number, v: number): [number, number, number] {
  const stops = gradient.stops.length >= 2 ? gradient.stops : [{ offset: 0, color: 'rgba(138,122,95,1)' }, { offset: 1, color: 'rgba(138,122,95,1)' }];
  let t: number;
  if (gradient.type === 'radial') {
    const [cx, cy] = gradient.axis;
    const dx = u - cx;
    const dy = v - cy;
    const maxRadius = Math.max(0.001, Math.hypot(Math.max(cx, 1 - cx), Math.max(cy, 1 - cy)));
    t = clamp01(Math.hypot(dx, dy) / maxRadius);
  } else {
    const [ax, ay] = gradient.axis;
    const projection = (u - 0.5) * ax + (v - 0.5) * ay;
    const maxProjection = 0.5 * (Math.abs(ax) + Math.abs(ay)) || 0.5;
    t = clamp01(projection / maxProjection + 0.5);
  }
  const scaled = t * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.max(0, Math.floor(scaled)));
  const mix = scaled - index;
  const a = parseRgba(stops[index].color);
  const b = parseRgba(stops[index + 1].color);
  return [
    THREE.MathUtils.lerp(a[0], b[0], mix),
    THREE.MathUtils.lerp(a[1], b[1], mix),
    THREE.MathUtils.lerp(a[2], b[2], mix),
  ];
}

function writePixel(data: Uint8ClampedArray, offset: number, red: number, green: number, blue: number): void {
  data[offset] = Math.max(0, Math.min(255, Math.round(red)));
  data[offset + 1] = Math.max(0, Math.min(255, Math.round(green)));
  data[offset + 2] = Math.max(0, Math.min(255, Math.round(blue)));
  data[offset + 3] = 255;
}

function makeCanvas(size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

function createMapTexture(
  canvas: HTMLCanvasElement,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [2, 2];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 2,
    typeof repeat[1] === 'number' ? repeat[1] : 2,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

type ProceduralTextureSet = {
  albedo: THREE.Texture;
  roughness: THREE.Texture;
  height: THREE.Texture;
  normal: THREE.Texture;
  ao: THREE.Texture;
  source: 'reference-pixel-extraction' | 'procedural';
};

function referenceMapUrl(spec: SculptMaterialSpec, channel: string): string | null {
  const reference = spec.referencePbr;
  if (!reference || typeof reference !== 'object') return null;
  if (reference.usable === false) return null;
  const confidence = typeof reference.confidence === 'number'
    ? reference.confidence
    : (typeof reference.estimatedFidelity === 'number' ? reference.estimatedFidelity : 0);
  const threshold = typeof reference.targetThreshold === 'number' ? reference.targetThreshold : 0.7;
  if (confidence < threshold) return null;
  const maps = reference.maps;
  if (!maps || typeof maps !== 'object') return null;
  const map = (maps as Record<string, unknown>)[channel];
  if (!map || typeof map !== 'object') return null;
  const record = map as Record<string, unknown>;
  const url = typeof record.url === 'string' && record.url.trim() ? record.url : record.path;
  return typeof url === 'string' && url.trim() ? url : null;
}

function createLoadedMapTexture(
  url: string,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.Texture {
  const texture = new THREE.TextureLoader().load(url);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [1, 1];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 1,
    typeof repeat[1] === 'number' ? repeat[1] : 1,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

function makeReferenceTextureSet(spec: SculptMaterialSpec, options: ProceduralModelOptions): ProceduralTextureSet | null {
  const albedo = referenceMapUrl(spec, 'albedo');
  const roughness = referenceMapUrl(spec, 'roughness');
  const height = referenceMapUrl(spec, 'height');
  const normal = referenceMapUrl(spec, 'normal');
  const ao = referenceMapUrl(spec, 'ao');
  if (!albedo || !roughness || !height || !normal || !ao) return null;
  return {
    albedo: createLoadedMapTexture(albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createLoadedMapTexture(roughness, THREE.NoColorSpace, spec, options),
    height: createLoadedMapTexture(height, THREE.NoColorSpace, spec, options),
    normal: createLoadedMapTexture(normal, THREE.NoColorSpace, spec, options),
    ao: createLoadedMapTexture(ao, THREE.NoColorSpace, spec, options),
    source: 'reference-pixel-extraction',
  };
}

function makeProceduralTextureSet(
  id: string,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): ProceduralTextureSet | null {
  if (typeof document === 'undefined') return null;
  const qualityFirst = (options.qualityPriority ?? 'reference-fidelity') === 'reference-fidelity';
  const requested = options.textureSize ?? spec.textureResolution;
  const requestedSize = typeof requested === 'number' && Number.isFinite(requested)
    ? requested
    : (qualityFirst ? 1024 : 512);
  const size = Math.max(256, Math.min(2048, 2 ** Math.round(Math.log2(requestedSize))));
  const canvases = {
    albedo: makeCanvas(size),
    roughness: makeCanvas(size),
    height: makeCanvas(size),
    normal: makeCanvas(size),
    ao: makeCanvas(size),
  };
  const contexts = {
    albedo: canvases.albedo.getContext('2d'),
    roughness: canvases.roughness.getContext('2d'),
    height: canvases.height.getContext('2d'),
    normal: canvases.normal.getContext('2d'),
    ao: canvases.ao.getContext('2d'),
  };
  if (!contexts.albedo || !contexts.roughness || !contexts.height || !contexts.normal || !contexts.ao) return null;
  const images = {
    albedo: contexts.albedo.createImageData(size, size),
    roughness: contexts.roughness.createImageData(size, size),
    height: contexts.height.createImageData(size, size),
    normal: contexts.normal.createImageData(size, size),
    ao: contexts.ao.createImageData(size, size),
  };
  const seed = hashString(id);
  const bands = surfaceBands(spec);
  const heightField = new Float32Array(size * size);
  const roughnessField = new Float32Array(size * size);
  const palette = materialPalette(spec);
  const fallback = typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F';
  const colors = (palette.length >= 2 ? palette : [fallback, '#6E614B', '#A08F70']).map(hexToRgb);
  const baseRoughness = clamp01(readLayerNumber(spec.roughness, ['base'], 0.76));
  const roughnessVariation = clamp01(readLayerNumber(spec.roughness, ['variation'], 0.18));
  const colorAmplitude = clamp01(readLayerNumber(spec.colorVariation, ['amplitude', 'variation'], 0.18));
  const heightCorrelation = clamp01(readLayerNumber(spec.colorVariation, ['heightCorrelation'], 0.3));
  const colorGradient: ColorGradientSpec | undefined = spec.colorGradient;
  for (let y = 0; y < size; y += 1) {
    const v = y / size;
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const index = y * size + x;
      const height = sampleSurface(u, v, bands, seed + 101);
      const roughNoise = sampleSurface(u, v, bands, seed + 7001);
      const colorNoise = sampleSurface(u, v, bands, seed + 15013);
      heightField[index] = height;
      roughnessField[index] = clamp01(baseRoughness + (roughNoise - 0.5) * roughnessVariation * 2);
      let color: [number, number, number];
      if (colorGradient) {
        // Evidence-derived spatial gradient (Plan 1.3 Workstream C) takes priority
        // over the noise-based palette blend below — it is a measured trend, not a guess.
        color = sampleColorGradient(colorGradient, u, v);
      } else {
        const paletteValue = clamp01(
          0.5 + (colorNoise - 0.5) * colorAmplitude * 2 + (height - 0.5) * heightCorrelation
        );
        color = mixPalette(colors, paletteValue);
      }
      writePixel(images.albedo.data, index * 4, color[0], color[1], color[2]);
    }
  }
  const normalStrength = Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35));
  const aoStrength = clamp01(readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35));
  for (let y = 0; y < size; y += 1) {
    const up = ((y - 1 + size) % size) * size;
    const down = ((y + 1) % size) * size;
    for (let x = 0; x < size; x += 1) {
      const left = (x - 1 + size) % size;
      const right = (x + 1) % size;
      const index = y * size + x;
      const center = heightField[index];
      const dx = (heightField[y * size + right] - heightField[y * size + left]) * normalStrength * 6;
      const dy = (heightField[down + x] - heightField[up + x]) * normalStrength * 6;
      const inverseLength = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const normalX = -dx * inverseLength;
      const normalY = -dy * inverseLength;
      const normalZ = inverseLength;
      const neighborAverage = (
        heightField[y * size + left] + heightField[y * size + right]
        + heightField[up + x] + heightField[down + x]
      ) * 0.25;
      const cavity = Math.max(0, neighborAverage - center);
      const ao = clamp01(1 - aoStrength * (cavity * 12 + (1 - center) * 0.16));
      const offset = index * 4;
      const heightByte = center * 255;
      const roughnessByte = roughnessField[index] * 255;
      writePixel(images.height.data, offset, heightByte, heightByte, heightByte);
      writePixel(images.roughness.data, offset, roughnessByte, roughnessByte, roughnessByte);
      writePixel(
        images.normal.data, offset,
        (normalX * 0.5 + 0.5) * 255,
        (normalY * 0.5 + 0.5) * 255,
        (normalZ * 0.5 + 0.5) * 255,
      );
      writePixel(images.ao.data, offset, ao * 255, ao * 255, ao * 255);
    }
  }
  contexts.albedo.putImageData(images.albedo, 0, 0);
  contexts.roughness.putImageData(images.roughness, 0, 0);
  contexts.height.putImageData(images.height, 0, 0);
  contexts.normal.putImageData(images.normal, 0, 0);
  contexts.ao.putImageData(images.ao, 0, 0);
  return {
    albedo: createMapTexture(canvases.albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createMapTexture(canvases.roughness, THREE.NoColorSpace, spec, options),
    height: createMapTexture(canvases.height, THREE.NoColorSpace, spec, options),
    normal: createMapTexture(canvases.normal, THREE.NoColorSpace, spec, options),
    ao: createMapTexture(canvases.ao, THREE.NoColorSpace, spec, options),
    source: 'procedural',
  };
}

function createSculptMaterial(id: string, spec: SculptMaterialSpec, options: ProceduralModelOptions, denseComponent = false): THREE.MeshPhysicalMaterial {
  // A material that declares -- with evidence -- that its subject carries no texture
  // detail gets NO texture set. Synthesising one anyway is not a harmless default: the
  // branch below then forces color to white and roughness to 1 and reads both from the
  // generated maps, so the authored albedo and the reference-derived roughness are both
  // discarded, and the model gains mottling the reference does not have. Measured on the
  // tuxedo cat, whose black fur rendered as speckled grey-and-white from a palette that
  // only ever described two flat regions.
  const textureless = (spec.textureless as { declared?: boolean } | undefined)?.declared === true;
  const textures = textureless
    ? null
    : makeReferenceTextureSet(spec, options) ?? makeProceduralTextureSet(id, spec, options);
  const material = new THREE.MeshPhysicalMaterial({
    color: textures ? 0xffffff : clampedAlbedoColor(spec),
    roughness: textures ? 1 : clamp01(readLayerNumber(spec.roughness, ['base'], 0.76)),
    metalness: clampPbrMetalness(readLayerNumber(spec.metalness, ['base'], 0.0)),
    clearcoat: clamp01(readLayerNumber(spec.clearcoat, ['base', 'amount'], 0)),
    clearcoatRoughness: clamp01(readLayerNumber(spec.clearcoatRoughness, ['base'], 0.25)),
    transmission: clamp01(readLayerNumber(spec.transmission, ['base', 'amount'], 0)),
    ior: clampPbrIor(readLayerNumber(spec.ior, ['base', 'value'], 1.5)),
    thickness: Math.max(0, readLayerNumber(spec.thickness, ['base', 'amount'], 0)),
    attenuationDistance: Math.max(0.001, readLayerNumber(spec.attenuationDistance, ['base', 'value'], Infinity)),
    attenuationColor: new THREE.Color(typeof spec.attenuationColor === 'string' ? spec.attenuationColor : '#ffffff'),
    sheen: clamp01(readLayerNumber(spec.sheen, ['base', 'amount'], 0)),
    sheenColor: new THREE.Color(typeof spec.sheenColor === 'string' ? spec.sheenColor : '#ffffff'),
    sheenRoughness: clamp01(readLayerNumber(spec.sheenRoughness, ['base'], 1.0)),
    iridescence: clamp01(readLayerNumber(spec.iridescence, ['base', 'amount'], 0)),
    iridescenceIOR: clampPbrIor(readLayerNumber(spec.iridescenceIOR, ['base', 'value'], 1.3)),
    anisotropy: clamp01(readLayerNumber(spec.anisotropy, ['base', 'amount'], 0)),
    anisotropyRotation: readLayerNumber(spec.anisotropy, ['rotation'], 0),
    specularIntensity: clampPbrF0(readLayerNumber(spec.specularF0 ?? spec.f0 ?? spec.specularIntensity, ['base', 'value'], 1.0)),
    specularColor: new THREE.Color(typeof spec.specularColor === 'string' ? spec.specularColor : '#ffffff'),
    emissive: new THREE.Color(typeof spec.emissive === 'string' ? spec.emissive : '#000000'),
    emissiveIntensity: Math.max(0, readLayerNumber(spec.emissiveIntensity, ['base'], 1.0)),
    opacity: clamp01(readLayerNumber(spec.opacity, ['base'], 1)),
    transparent: readLayerNumber(spec.transmission, ['base', 'amount'], 0) > 0 || readLayerNumber(spec.opacity, ['base'], 1) < 1,
    alphaTest: Math.max(0, readLayerNumber(spec.alpha, ['cutoff', 'alphaTest'], 0)),
    wireframe: options.wireframe ?? false,
    side: spec.doubleSided === true ? THREE.DoubleSide : THREE.FrontSide,
    flatShading: spec.flatShading === true,
  });
  if (textures) {
    material.map = textures.albedo;
    material.roughnessMap = textures.roughness;
    material.normalMap = textures.normal;
    material.normalScale.setScalar(Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35)));
    material.aoMap = textures.ao;
    material.aoMap.channel = 0;
    material.aoMapIntensity = readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35);
    const denseMesh = denseComponent || spec.denseMesh === true || spec.geometryDensity === 'dense' || spec.topologyClass === 'dense';
    const bumpScale = Math.max(0, readLayerNumber(spec.bump, ['amplitude', 'strength'], 0));
    const effectiveBumpScale = denseMesh ? Math.max(0.05, bumpScale) : bumpScale;
    if (effectiveBumpScale > 0) {
      material.bumpMap = textures.height;
      material.bumpScale = effectiveBumpScale;
    }
    const displacementScale = Math.max(0, readLayerNumber(spec.displacement, ['amplitude', 'strength'], 0));
    const effectiveDisplacementScale = denseMesh ? Math.max(0.005, displacementScale) : displacementScale;
    if (effectiveDisplacementScale > 0) {
      material.displacementMap = textures.height;
      material.displacementScale = effectiveDisplacementScale;
      material.displacementBias = -effectiveDisplacementScale * 0.5;
    }
  }
  material.envMapIntensity = readLayerNumber(spec, ['envMapIntensity'], 0.8);
  material.userData.sculptMaterial = spec;
  material.userData.proceduralMapsIndependent = true;
  material.userData.pbrConstraints = { albedoRange: [30, 240], binaryMetalness: true, f0Range: [0.02, 1], iorRange: [1, 2.5] };
  material.userData.pbrTextureSource = textures?.source ?? 'flat-fallback';
  material.userData.referencePbr = spec.referencePbr ?? null;
  material.userData.referenceMaterialId = spec.referenceMaterialId ?? spec.materialReference?.profileId ?? null;
  material.userData.materialEvidence = spec.materialEvidence ?? null;
  material.userData.validationViews = spec.materialReference?.validationViews ?? [];
  material.needsUpdate = true;
  return material;
}

type AttachmentEndpoint = {
  start: THREE.Vector3;
  midpoint: THREE.Vector3;
  quaternion: THREE.Quaternion;
  length: number;
  baseRadius: number;
  endRadius: number;
};

function readVector3(value: unknown, fallback: [number, number, number]): THREE.Vector3 {
  if (Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === 'number')) {
    return new THREE.Vector3(value[0], value[1], value[2]);
  }
  return new THREE.Vector3(fallback[0], fallback[1], fallback[2]);
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function makeAttachmentEndpoint(attachment: unknown): AttachmentEndpoint | null {
  if (!attachment || typeof attachment !== 'object') return null;
  const record = attachment as Record<string, unknown>;
  const start = readVector3(record.localStart, [0, 0, 0]);
  const end = readVector3(record.localEnd, [0, 1, 0]);
  const delta = end.clone().sub(start);
  const length = delta.length();
  if (length <= 0.0001) return null;
  const direction = delta.clone().normalize();
  const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
  const baseRadius = Math.max(0.005, readNumber(record.baseRadius, 0.06));
  const endRadius = Math.max(0.003, readNumber(record.endRadius, baseRadius * 0.55));
  return {
    start,
    midpoint: delta.multiplyScalar(0.5),
    quaternion,
    length,
    baseRadius,
    endRadius,
  };
}

// Generated from ObjectSculptSpec target: Six-axis Hexacopter
// Sculpt build pass: blockout
// This factory is intentionally pass-gated. Finish browser screenshot review before unlocking deeper passes.
export function createSixAxisHexacopterModel(options: ProceduralModelOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = "Six-axis Hexacopter";
  root.userData.reconstructionEvidence = {"itemFamily": null, "subtype": null, "componentAdapter": null, "route": null, "exactnessTier": null, "referenceCamera": {"solved": false, "fovDegrees": 33, "aspect": 1.78, "orientation": {"yaw": 42, "pitch": 26, "roll": 0}, "positionHint": [5.8, 4.4, 7.5], "target": [0, 1, 0], "note": "Visually matched three-quarter camera; not a solved calibration."}, "approximationNotes": []};
  root.userData.materialPipeline = {};
  root.userData.materialReferenceRegistry = null;

  const materialMap: Record<string, THREE.Material> = {};
  materialMap["white"] = createSculptMaterial(
    "white",
    {"id": "white", "name": "white", "type": "physical", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#edf1f5", "color": "#edf1f5", "albedo": {"dominant": "#edf1f5", "secondary": ["#edf1f5"], "samplingNotes": "Observed de-lit target of solid material; studio highlights are not pigmentation"}, "colorVariation": {"palette": ["#edf1f5"], "pattern": "uniform", "amplitude": 0, "heightCorrelation": 0}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2, 2], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1, "amplitude": 0.001, "role": "uniform paint"}, {"id": "meso", "frequency": 20, "amplitude": 0.001, "role": "no fictional damage"}, {"id": "micro", "frequency": 256, "amplitude": 0.003, "role": "manufacturing finish"}], "roughness": {"base": 0.28, "variation": 0.015, "map": "independent-procedural-field", "localResponse": "subtle manufactured finish"}, "metalness": {"base": 0, "variation": 0}, "normal": {"pattern": "micro-finish", "strength": 0.015, "scale": 256, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0, "scale": 1}, "displacement": {"pattern": "none", "amplitude": 0, "scale": 1, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0, "scratches": [], "chips": []}, "dirt": {"amount": 0, "cavityBias": 0, "color": "#2F2A22"}, "localOverrides": [{"id": "white-edges", "region": "edge fillet", "roughness": 0.24000000000000002, "clearcoat": 0.3, "evidenceRefs": ["full-object"]}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Single-color manufactured finish, no wear visible. RGB inferred from rendered reference, not a calibrated measurement.", "clearcoat": 0.3, "clearcoatRoughness": 0.2, "referencePbr": {"usable": true, "confidence": 0.716, "targetThreshold": 0.7, "maps": {"albedo": {"path": "C:\\Users\\Administrator\\Documents\\Qoder\\2026-11-06\\194fb39d\\evidence\\materials\\white\\white_albedo.png", "url": "white_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "C:\\Users\\Administrator\\Documents\\Qoder\\2026-11-06\\194fb39d\\evidence\\materials\\white\\white_roughness.png", "url": "white_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "C:\\Users\\Administrator\\Documents\\Qoder\\2026-11-06\\194fb39d\\evidence\\materials\\white\\white_height.png", "url": "white_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "C:\\Users\\Administrator\\Documents\\Qoder\\2026-11-06\\194fb39d\\evidence\\materials\\white\\white_normal.png", "url": "white_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "C:\\Users\\Administrator\\Documents\\Qoder\\2026-11-06\\194fb39d\\evidence\\materials\\white\\white_ao.png", "url": "white_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "sourceImage": "C:\\Users\\Administrator\\Documents\\Qoder\\2026-11-06\\194fb39d\\evidence\\material-white.png", "source": "reference-pixel-extraction", "limitation": "single-image PBR extraction is an estimate; 70%+ extraction confidence still needs render screenshot review"}},
    options
  );
  materialMap["blue"] = createSculptMaterial(
    "blue",
    {"id": "blue", "name": "blue", "type": "physical", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#244b75", "color": "#244b75", "albedo": {"dominant": "#244b75", "secondary": ["#244b75"], "samplingNotes": "Observed de-lit target of solid material; studio highlights are not pigmentation"}, "colorVariation": {"palette": ["#244b75"], "pattern": "uniform", "amplitude": 0, "heightCorrelation": 0}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2, 2], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1, "amplitude": 0.001, "role": "uniform paint"}, {"id": "meso", "frequency": 20, "amplitude": 0.001, "role": "no fictional damage"}, {"id": "micro", "frequency": 256, "amplitude": 0.003, "role": "manufacturing finish"}], "roughness": {"base": 0.32, "variation": 0.015, "map": "independent-procedural-field", "localResponse": "subtle manufactured finish"}, "metalness": {"base": 0.25, "variation": 0}, "normal": {"pattern": "micro-finish", "strength": 0.015, "scale": 256, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0, "scale": 1}, "displacement": {"pattern": "none", "amplitude": 0, "scale": 1, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0, "scratches": [], "chips": []}, "dirt": {"amount": 0, "cavityBias": 0, "color": "#2F2A22"}, "localOverrides": [{"id": "blue-edges", "region": "edge fillet", "roughness": 0.28, "clearcoat": 0, "evidenceRefs": ["full-object"]}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Single-color manufactured finish, no wear visible. RGB inferred from rendered reference, not a calibrated measurement.", "clearcoat": 0, "clearcoatRoughness": 0.2, "referencePbr": {"usable": true, "confidence": 0.789, "targetThreshold": 0.7, "maps": {"albedo": {"path": "C:\\Users\\Administrator\\Documents\\Qoder\\2026-11-06\\194fb39d\\evidence\\materials\\blue\\blue_albedo.png", "url": "blue_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "C:\\Users\\Administrator\\Documents\\Qoder\\2026-11-06\\194fb39d\\evidence\\materials\\blue\\blue_roughness.png", "url": "blue_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "C:\\Users\\Administrator\\Documents\\Qoder\\2026-11-06\\194fb39d\\evidence\\materials\\blue\\blue_height.png", "url": "blue_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "C:\\Users\\Administrator\\Documents\\Qoder\\2026-11-06\\194fb39d\\evidence\\materials\\blue\\blue_normal.png", "url": "blue_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "C:\\Users\\Administrator\\Documents\\Qoder\\2026-11-06\\194fb39d\\evidence\\materials\\blue\\blue_ao.png", "url": "blue_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "sourceImage": "C:\\Users\\Administrator\\Documents\\Qoder\\2026-11-06\\194fb39d\\evidence\\material-blue.png", "source": "reference-pixel-extraction", "limitation": "single-image PBR extraction is an estimate; 70%+ extraction confidence still needs render screenshot review"}},
    options
  );
  materialMap["silver"] = createSculptMaterial(
    "silver",
    {"id": "silver", "name": "silver", "type": "physical", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#c6ced8", "color": "#c6ced8", "albedo": {"dominant": "#c6ced8", "secondary": ["#c6ced8"], "samplingNotes": "Observed de-lit target of solid material; studio highlights are not pigmentation"}, "colorVariation": {"palette": ["#c6ced8"], "pattern": "uniform", "amplitude": 0, "heightCorrelation": 0}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2, 2], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1, "amplitude": 0.001, "role": "uniform paint"}, {"id": "meso", "frequency": 20, "amplitude": 0.001, "role": "no fictional damage"}, {"id": "micro", "frequency": 256, "amplitude": 0.003, "role": "manufacturing finish"}], "roughness": {"base": 0.26, "variation": 0.015, "map": "independent-procedural-field", "localResponse": "subtle manufactured finish"}, "metalness": {"base": 0.92, "variation": 0}, "normal": {"pattern": "micro-finish", "strength": 0.015, "scale": 256, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0, "scale": 1}, "displacement": {"pattern": "none", "amplitude": 0, "scale": 1, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0, "scratches": [], "chips": []}, "dirt": {"amount": 0, "cavityBias": 0, "color": "#2F2A22"}, "localOverrides": [{"id": "silver-edges", "region": "edge fillet", "roughness": 0.22, "clearcoat": 0, "evidenceRefs": ["full-object"]}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Single-color manufactured finish, no wear visible. RGB inferred from rendered reference, not a calibrated measurement.", "clearcoat": 0, "clearcoatRoughness": 0.2, "referencePbr": {"usable": true, "confidence": 0.842, "targetThreshold": 0.7, "maps": {"albedo": {"path": "C:\\Users\\Administrator\\Documents\\Qoder\\2026-11-06\\194fb39d\\evidence\\materials\\silver\\silver_albedo.png", "url": "silver_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "C:\\Users\\Administrator\\Documents\\Qoder\\2026-11-06\\194fb39d\\evidence\\materials\\silver\\silver_roughness.png", "url": "silver_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "C:\\Users\\Administrator\\Documents\\Qoder\\2026-11-06\\194fb39d\\evidence\\materials\\silver\\silver_height.png", "url": "silver_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "C:\\Users\\Administrator\\Documents\\Qoder\\2026-11-06\\194fb39d\\evidence\\materials\\silver\\silver_normal.png", "url": "silver_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "C:\\Users\\Administrator\\Documents\\Qoder\\2026-11-06\\194fb39d\\evidence\\materials\\silver\\silver_ao.png", "url": "silver_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "sourceImage": "C:\\Users\\Administrator\\Documents\\Qoder\\2026-11-06\\194fb39d\\evidence\\material-silver.png", "source": "reference-pixel-extraction", "limitation": "single-image PBR extraction is an estimate; 70%+ extraction confidence still needs render screenshot review"}},
    options
  );
  materialMap["graphite"] = createSculptMaterial(
    "graphite",
    {"id": "graphite", "name": "graphite", "type": "physical", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#303640", "color": "#303640", "albedo": {"dominant": "#303640", "secondary": ["#303640"], "samplingNotes": "Observed de-lit target of solid material; studio highlights are not pigmentation"}, "colorVariation": {"palette": ["#303640"], "pattern": "uniform", "amplitude": 0, "heightCorrelation": 0}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2, 2], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1, "amplitude": 0.001, "role": "uniform paint"}, {"id": "meso", "frequency": 20, "amplitude": 0.001, "role": "no fictional damage"}, {"id": "micro", "frequency": 256, "amplitude": 0.003, "role": "manufacturing finish"}], "roughness": {"base": 0.38, "variation": 0.015, "map": "independent-procedural-field", "localResponse": "subtle manufactured finish"}, "metalness": {"base": 0.2, "variation": 0}, "normal": {"pattern": "micro-finish", "strength": 0.015, "scale": 256, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0, "scale": 1}, "displacement": {"pattern": "none", "amplitude": 0, "scale": 1, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0, "scratches": [], "chips": []}, "dirt": {"amount": 0, "cavityBias": 0, "color": "#2F2A22"}, "localOverrides": [{"id": "graphite-edges", "region": "edge fillet", "roughness": 0.34, "clearcoat": 0, "evidenceRefs": ["full-object"]}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Single-color manufactured finish, no wear visible. RGB inferred from rendered reference, not a calibrated measurement.", "clearcoat": 0, "clearcoatRoughness": 0.2, "referencePbr": {"usable": true, "confidence": 0.831, "targetThreshold": 0.7, "maps": {"albedo": {"path": "C:\\Users\\Administrator\\Documents\\Qoder\\2026-11-06\\194fb39d\\evidence\\materials\\graphite\\graphite_albedo.png", "url": "graphite_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "C:\\Users\\Administrator\\Documents\\Qoder\\2026-11-06\\194fb39d\\evidence\\materials\\graphite\\graphite_roughness.png", "url": "graphite_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "C:\\Users\\Administrator\\Documents\\Qoder\\2026-11-06\\194fb39d\\evidence\\materials\\graphite\\graphite_height.png", "url": "graphite_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "C:\\Users\\Administrator\\Documents\\Qoder\\2026-11-06\\194fb39d\\evidence\\materials\\graphite\\graphite_normal.png", "url": "graphite_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "C:\\Users\\Administrator\\Documents\\Qoder\\2026-11-06\\194fb39d\\evidence\\materials\\graphite\\graphite_ao.png", "url": "graphite_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "sourceImage": "C:\\Users\\Administrator\\Documents\\Qoder\\2026-11-06\\194fb39d\\evidence\\material-graphite.png", "source": "reference-pixel-extraction", "limitation": "single-image PBR extraction is an estimate; 70%+ extraction confidence still needs render screenshot review"}},
    options
  );
  materialMap["black"] = createSculptMaterial(
    "black",
    {"id": "black", "name": "black", "type": "physical", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#101720", "color": "#101720", "albedo": {"dominant": "#101720", "secondary": ["#101720"], "samplingNotes": "Observed de-lit target of solid material; studio highlights are not pigmentation"}, "colorVariation": {"palette": ["#101720"], "pattern": "uniform", "amplitude": 0, "heightCorrelation": 0}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2, 2], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1, "amplitude": 0.001, "role": "uniform paint"}, {"id": "meso", "frequency": 20, "amplitude": 0.001, "role": "no fictional damage"}, {"id": "micro", "frequency": 256, "amplitude": 0.003, "role": "manufacturing finish"}], "roughness": {"base": 0.34, "variation": 0.015, "map": "independent-procedural-field", "localResponse": "subtle manufactured finish"}, "metalness": {"base": 0, "variation": 0}, "normal": {"pattern": "micro-finish", "strength": 0.015, "scale": 256, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0, "scale": 1}, "displacement": {"pattern": "none", "amplitude": 0, "scale": 1, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0, "scratches": [], "chips": []}, "dirt": {"amount": 0, "cavityBias": 0, "color": "#2F2A22"}, "localOverrides": [{"id": "black-edges", "region": "edge fillet", "roughness": 0.30000000000000004, "clearcoat": 0, "evidenceRefs": ["full-object"]}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Single-color manufactured finish, no wear visible. RGB inferred from rendered reference, not a calibrated measurement.", "clearcoat": 0, "clearcoatRoughness": 0.2, "referencePbr": {"usable": true, "confidence": 0.8, "targetThreshold": 0.7, "maps": {"albedo": {"path": "C:\\Users\\Administrator\\Documents\\Qoder\\2026-11-06\\194fb39d\\evidence\\materials\\black\\black_albedo.png", "url": "black_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "C:\\Users\\Administrator\\Documents\\Qoder\\2026-11-06\\194fb39d\\evidence\\materials\\black\\black_roughness.png", "url": "black_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "C:\\Users\\Administrator\\Documents\\Qoder\\2026-11-06\\194fb39d\\evidence\\materials\\black\\black_height.png", "url": "black_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "C:\\Users\\Administrator\\Documents\\Qoder\\2026-11-06\\194fb39d\\evidence\\materials\\black\\black_normal.png", "url": "black_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "C:\\Users\\Administrator\\Documents\\Qoder\\2026-11-06\\194fb39d\\evidence\\materials\\black\\black_ao.png", "url": "black_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "sourceImage": "C:\\Users\\Administrator\\Documents\\Qoder\\2026-11-06\\194fb39d\\evidence\\material-black.png", "source": "reference-pixel-extraction", "limitation": "single-image PBR extraction is an estimate; 70%+ extraction confidence still needs render screenshot review"}},
    options
  );
  materialMap["rubber"] = createSculptMaterial(
    "rubber",
    {"id": "rubber", "name": "rubber", "type": "physical", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#171d24", "color": "#171d24", "albedo": {"dominant": "#171d24", "secondary": ["#171d24"], "samplingNotes": "Observed de-lit target of solid material; studio highlights are not pigmentation"}, "colorVariation": {"palette": ["#171d24"], "pattern": "uniform", "amplitude": 0, "heightCorrelation": 0}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2, 2], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1, "amplitude": 0.001, "role": "uniform paint"}, {"id": "meso", "frequency": 20, "amplitude": 0.001, "role": "no fictional damage"}, {"id": "micro", "frequency": 256, "amplitude": 0.003, "role": "manufacturing finish"}], "roughness": {"base": 0.72, "variation": 0.015, "map": "independent-procedural-field", "localResponse": "subtle manufactured finish"}, "metalness": {"base": 0, "variation": 0}, "normal": {"pattern": "micro-finish", "strength": 0.015, "scale": 256, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0, "scale": 1}, "displacement": {"pattern": "none", "amplitude": 0, "scale": 1, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0, "scratches": [], "chips": []}, "dirt": {"amount": 0, "cavityBias": 0, "color": "#2F2A22"}, "localOverrides": [{"id": "rubber-edges", "region": "edge fillet", "roughness": 0.6799999999999999, "clearcoat": 0, "evidenceRefs": ["full-object"]}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Single-color manufactured finish, no wear visible. RGB inferred from rendered reference, not a calibrated measurement.", "clearcoat": 0, "clearcoatRoughness": 0.2, "referencePbr": {"usable": true, "confidence": 0.86, "targetThreshold": 0.7, "maps": {"albedo": {"path": "C:\\Users\\Administrator\\Documents\\Qoder\\2026-11-06\\194fb39d\\evidence\\materials\\rubber\\rubber_albedo.png", "url": "rubber_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "C:\\Users\\Administrator\\Documents\\Qoder\\2026-11-06\\194fb39d\\evidence\\materials\\rubber\\rubber_roughness.png", "url": "rubber_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "C:\\Users\\Administrator\\Documents\\Qoder\\2026-11-06\\194fb39d\\evidence\\materials\\rubber\\rubber_height.png", "url": "rubber_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "C:\\Users\\Administrator\\Documents\\Qoder\\2026-11-06\\194fb39d\\evidence\\materials\\rubber\\rubber_normal.png", "url": "rubber_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "C:\\Users\\Administrator\\Documents\\Qoder\\2026-11-06\\194fb39d\\evidence\\materials\\rubber\\rubber_ao.png", "url": "rubber_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "sourceImage": "C:\\Users\\Administrator\\Documents\\Qoder\\2026-11-06\\194fb39d\\evidence\\material-rubber.png", "source": "reference-pixel-extraction", "limitation": "single-image PBR extraction is an estimate; 70%+ extraction confidence still needs render screenshot review"}},
    options
  );

  const nodes: Record<string, THREE.Object3D> = { root };
  const meshes: Record<string, THREE.Mesh> = {};
  const sockets: Record<string, THREE.Object3D> = {};
  const colliders: Record<string, unknown> = {};
  const destructionGroups: Record<string, THREE.Object3D[]> = {};

  const endpoint_root_0 = makeAttachmentEndpoint(null);
  const node_root_0 = new THREE.Group();
  node_root_0.name = "root__pivot";
  node_root_0.scale.set(1, 1, 1);
  if (endpoint_root_0) {
    node_root_0.position.copy(endpoint_root_0.start);
    node_root_0.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_root_0.position.set(0.0, 0.0, 0.0);
    node_root_0.rotation.set(0.0, 0.0, 0.0);
  }
  node_root_0.userData.sculptComponent = {"id": "root", "name": "root", "level": "macro", "role": "body", "importance": 0.9, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Discrete cylindrical, extruded or tubular mechanical element.", "geometryDescriptor": {"topologyIntent": "closed profiled mechanical solid", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "invisibleRoot": true}, "parent": null, "attachment": null, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "boom-1", "name": "boom-1", "localPosition": [0.48, 1.19, 0.83], "localRotation": [0, 0, 0], "direction": [1, 0, 1], "radius": 0.055}, {"id": "boom-2", "name": "boom-2", "localPosition": [0.62, 1.19, 0], "localRotation": [0, 0, 0], "direction": [1, 0, 0], "radius": 0.055}, {"id": "boom-3", "name": "boom-3", "localPosition": [0.48, 1.19, -0.83], "localRotation": [0, 0, 0], "direction": [1, 0, -1], "radius": 0.055}, {"id": "boom-4", "name": "boom-4", "localPosition": [-0.48, 1.19, -0.83], "localRotation": [0, 0, 0], "direction": [-1, 0, -1], "radius": 0.055}, {"id": "boom-5", "name": "boom-5", "localPosition": [-0.62, 1.19, 0], "localRotation": [0, 0, 0], "direction": [-1, 0, 0], "radius": 0.055}, {"id": "boom-6", "name": "boom-6", "localPosition": [-0.48, 1.19, 0.83], "localRotation": [0, 0, 0], "direction": [-1, 0, 1], "radius": 0.055}, {"id": "fuselage-socket", "name": "fuselage-socket", "localPosition": [0, 1.01, 0], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.7}, {"id": "antenna-socket", "name": "antenna-socket", "localPosition": [0, 1.665, -0.65], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.365}, {"id": "landing-gear-socket", "name": "landing-gear-socket", "localPosition": [0, -0.475, 0], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.6}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "white", "materialLayers": ["white"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object", "structural-plan"], "details": ["root observed in reference"], "fidelityTier": "reference-proportional", "colorMaterialRecipe": {"dominantAlbedo": "rgba(237,241,245,1)", "secondaryAlbedo": "rgba(237,241,245,1)", "materialClass": "plastic", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "roughness": 0.28, "metalness": 0}};
  node_root_0.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "boom-1", "name": "boom-1", "localPosition": [0.48, 1.19, 0.83], "localRotation": [0, 0, 0], "direction": [1, 0, 1], "radius": 0.055}, {"id": "boom-2", "name": "boom-2", "localPosition": [0.62, 1.19, 0], "localRotation": [0, 0, 0], "direction": [1, 0, 0], "radius": 0.055}, {"id": "boom-3", "name": "boom-3", "localPosition": [0.48, 1.19, -0.83], "localRotation": [0, 0, 0], "direction": [1, 0, -1], "radius": 0.055}, {"id": "boom-4", "name": "boom-4", "localPosition": [-0.48, 1.19, -0.83], "localRotation": [0, 0, 0], "direction": [-1, 0, -1], "radius": 0.055}, {"id": "boom-5", "name": "boom-5", "localPosition": [-0.62, 1.19, 0], "localRotation": [0, 0, 0], "direction": [-1, 0, 0], "radius": 0.055}, {"id": "boom-6", "name": "boom-6", "localPosition": [-0.48, 1.19, 0.83], "localRotation": [0, 0, 0], "direction": [-1, 0, 1], "radius": 0.055}, {"id": "fuselage-socket", "name": "fuselage-socket", "localPosition": [0, 1.01, 0], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.7}, {"id": "antenna-socket", "name": "antenna-socket", "localPosition": [0, 1.665, -0.65], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.365}, {"id": "landing-gear-socket", "name": "landing-gear-socket", "localPosition": [0, -0.475, 0], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.6}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_root_0);
  nodes["root"] = node_root_0;
  const mesh_root_0Geometry = endpoint_root_0
    ? new THREE.CylinderGeometry(endpoint_root_0.endRadius, endpoint_root_0.baseRadius, endpoint_root_0.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_root_0) {
    mesh_root_0Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_root_0 = new THREE.Mesh(
    mesh_root_0Geometry,
    materialMap["white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_root_0.name = "root";
  if (endpoint_root_0) {
    mesh_root_0.position.copy(endpoint_root_0.midpoint);
    mesh_root_0.quaternion.copy(endpoint_root_0.quaternion);
  }
  mesh_root_0.castShadow = options.castShadow ?? true;
  mesh_root_0.receiveShadow = options.receiveShadow ?? true;
  mesh_root_0.userData.sculptComponent = {"id": "root", "name": "root", "level": "macro", "role": "body", "importance": 0.9, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Discrete cylindrical, extruded or tubular mechanical element.", "geometryDescriptor": {"topologyIntent": "closed profiled mechanical solid", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "invisibleRoot": true}, "parent": null, "attachment": null, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "boom-1", "name": "boom-1", "localPosition": [0.48, 1.19, 0.83], "localRotation": [0, 0, 0], "direction": [1, 0, 1], "radius": 0.055}, {"id": "boom-2", "name": "boom-2", "localPosition": [0.62, 1.19, 0], "localRotation": [0, 0, 0], "direction": [1, 0, 0], "radius": 0.055}, {"id": "boom-3", "name": "boom-3", "localPosition": [0.48, 1.19, -0.83], "localRotation": [0, 0, 0], "direction": [1, 0, -1], "radius": 0.055}, {"id": "boom-4", "name": "boom-4", "localPosition": [-0.48, 1.19, -0.83], "localRotation": [0, 0, 0], "direction": [-1, 0, -1], "radius": 0.055}, {"id": "boom-5", "name": "boom-5", "localPosition": [-0.62, 1.19, 0], "localRotation": [0, 0, 0], "direction": [-1, 0, 0], "radius": 0.055}, {"id": "boom-6", "name": "boom-6", "localPosition": [-0.48, 1.19, 0.83], "localRotation": [0, 0, 0], "direction": [-1, 0, 1], "radius": 0.055}, {"id": "fuselage-socket", "name": "fuselage-socket", "localPosition": [0, 1.01, 0], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.7}, {"id": "antenna-socket", "name": "antenna-socket", "localPosition": [0, 1.665, -0.65], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.365}, {"id": "landing-gear-socket", "name": "landing-gear-socket", "localPosition": [0, -0.475, 0], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.6}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "white", "materialLayers": ["white"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object", "structural-plan"], "details": ["root observed in reference"], "fidelityTier": "reference-proportional", "colorMaterialRecipe": {"dominantAlbedo": "rgba(237,241,245,1)", "secondaryAlbedo": "rgba(237,241,245,1)", "materialClass": "plastic", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "roughness": 0.28, "metalness": 0}};
  node_root_0.add(mesh_root_0);
  meshes["root"] = mesh_root_0;
  colliders["root"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_root_0);
  const socket_root_boom_1_0 = new THREE.Object3D();
  socket_root_boom_1_0.name = "boom-1";
  socket_root_boom_1_0.position.set(0.48, 1.19, 0.83);
  socket_root_boom_1_0.rotation.set(0.0, 0.0, 0.0);
  socket_root_boom_1_0.userData.socket = {"id": "boom-1", "name": "boom-1", "localPosition": [0.48, 1.19, 0.83], "localRotation": [0, 0, 0], "direction": [1, 0, 1], "radius": 0.055};
  node_root_0.add(socket_root_boom_1_0);
  sockets["root:boom-1"] = socket_root_boom_1_0;
  const socket_root_boom_2_1 = new THREE.Object3D();
  socket_root_boom_2_1.name = "boom-2";
  socket_root_boom_2_1.position.set(0.62, 1.19, 0.0);
  socket_root_boom_2_1.rotation.set(0.0, 0.0, 0.0);
  socket_root_boom_2_1.userData.socket = {"id": "boom-2", "name": "boom-2", "localPosition": [0.62, 1.19, 0], "localRotation": [0, 0, 0], "direction": [1, 0, 0], "radius": 0.055};
  node_root_0.add(socket_root_boom_2_1);
  sockets["root:boom-2"] = socket_root_boom_2_1;
  const socket_root_boom_3_2 = new THREE.Object3D();
  socket_root_boom_3_2.name = "boom-3";
  socket_root_boom_3_2.position.set(0.48, 1.19, -0.83);
  socket_root_boom_3_2.rotation.set(0.0, 0.0, 0.0);
  socket_root_boom_3_2.userData.socket = {"id": "boom-3", "name": "boom-3", "localPosition": [0.48, 1.19, -0.83], "localRotation": [0, 0, 0], "direction": [1, 0, -1], "radius": 0.055};
  node_root_0.add(socket_root_boom_3_2);
  sockets["root:boom-3"] = socket_root_boom_3_2;
  const socket_root_boom_4_3 = new THREE.Object3D();
  socket_root_boom_4_3.name = "boom-4";
  socket_root_boom_4_3.position.set(-0.48, 1.19, -0.83);
  socket_root_boom_4_3.rotation.set(0.0, 0.0, 0.0);
  socket_root_boom_4_3.userData.socket = {"id": "boom-4", "name": "boom-4", "localPosition": [-0.48, 1.19, -0.83], "localRotation": [0, 0, 0], "direction": [-1, 0, -1], "radius": 0.055};
  node_root_0.add(socket_root_boom_4_3);
  sockets["root:boom-4"] = socket_root_boom_4_3;
  const socket_root_boom_5_4 = new THREE.Object3D();
  socket_root_boom_5_4.name = "boom-5";
  socket_root_boom_5_4.position.set(-0.62, 1.19, 0.0);
  socket_root_boom_5_4.rotation.set(0.0, 0.0, 0.0);
  socket_root_boom_5_4.userData.socket = {"id": "boom-5", "name": "boom-5", "localPosition": [-0.62, 1.19, 0], "localRotation": [0, 0, 0], "direction": [-1, 0, 0], "radius": 0.055};
  node_root_0.add(socket_root_boom_5_4);
  sockets["root:boom-5"] = socket_root_boom_5_4;
  const socket_root_boom_6_5 = new THREE.Object3D();
  socket_root_boom_6_5.name = "boom-6";
  socket_root_boom_6_5.position.set(-0.48, 1.19, 0.83);
  socket_root_boom_6_5.rotation.set(0.0, 0.0, 0.0);
  socket_root_boom_6_5.userData.socket = {"id": "boom-6", "name": "boom-6", "localPosition": [-0.48, 1.19, 0.83], "localRotation": [0, 0, 0], "direction": [-1, 0, 1], "radius": 0.055};
  node_root_0.add(socket_root_boom_6_5);
  sockets["root:boom-6"] = socket_root_boom_6_5;
  const socket_root_fuselage_socket_6 = new THREE.Object3D();
  socket_root_fuselage_socket_6.name = "fuselage-socket";
  socket_root_fuselage_socket_6.position.set(0.0, 1.01, 0.0);
  socket_root_fuselage_socket_6.rotation.set(0.0, 0.0, 0.0);
  socket_root_fuselage_socket_6.userData.socket = {"id": "fuselage-socket", "name": "fuselage-socket", "localPosition": [0, 1.01, 0], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.7};
  node_root_0.add(socket_root_fuselage_socket_6);
  sockets["root:fuselage-socket"] = socket_root_fuselage_socket_6;
  const socket_root_antenna_socket_7 = new THREE.Object3D();
  socket_root_antenna_socket_7.name = "antenna-socket";
  socket_root_antenna_socket_7.position.set(0.0, 1.665, -0.65);
  socket_root_antenna_socket_7.rotation.set(0.0, 0.0, 0.0);
  socket_root_antenna_socket_7.userData.socket = {"id": "antenna-socket", "name": "antenna-socket", "localPosition": [0, 1.665, -0.65], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.365};
  node_root_0.add(socket_root_antenna_socket_7);
  sockets["root:antenna-socket"] = socket_root_antenna_socket_7;
  const socket_root_landing_gear_socket_8 = new THREE.Object3D();
  socket_root_landing_gear_socket_8.name = "landing-gear-socket";
  socket_root_landing_gear_socket_8.position.set(0.0, -0.475, 0.0);
  socket_root_landing_gear_socket_8.rotation.set(0.0, 0.0, 0.0);
  socket_root_landing_gear_socket_8.userData.socket = {"id": "landing-gear-socket", "name": "landing-gear-socket", "localPosition": [0, -0.475, 0], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.6};
  node_root_0.add(socket_root_landing_gear_socket_8);
  sockets["root:landing-gear-socket"] = socket_root_landing_gear_socket_8;

  const endpoint_fuselage_1 = makeAttachmentEndpoint(null);
  const node_fuselage_1 = new THREE.Group();
  node_fuselage_1.name = "fuselage__pivot";
  node_fuselage_1.scale.set(1, 1, 1);
  if (endpoint_fuselage_1) {
    node_fuselage_1.position.copy(endpoint_fuselage_1.start);
    node_fuselage_1.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_fuselage_1.position.set(0.0, 1.32, 0.0);
    node_fuselage_1.rotation.set(0.0, 0.0, 0.0);
  }
  node_fuselage_1.userData.sculptComponent = {"id": "fuselage", "name": "fuselage", "level": "macro", "role": "body", "importance": 0.9, "confidence": 0.9, "primitive": "lathe", "topologyClass": "continuous-sculpt", "topologyRationale": "Continuous lofted cross-sections give a variable-width convex surface.", "geometryDescriptor": {"topologyIntent": "closed anisotropic loft", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "loft": {"axis": "Y", "rings": [[-0.32, 0.8], [-0.26, 0.95], [-0.15, 1], [0, 1], [0.12, 0.97], [0.23, 0.83], [0.31, 0.12]], "crossSection": "superellipse exponent 2.8", "halfWidth": 0.7, "halfLength": 1.2}}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "fuselage-socket", "localStart": [0, 1.01, 0], "localEnd": [0, 1.6300000000000001, 0], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "baseRadius": 0.7, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.4, "height": 0.62, "depth": 2.4, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 1.32, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "blue-inset-left-socket", "name": "blue-inset-left-socket", "localPosition": [-0.57, 1.465, -0.06], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.025}, {"id": "blue-inset-right-socket", "name": "blue-inset-right-socket", "localPosition": [0.57, 1.465, -0.06], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.025}, {"id": "lower-tray-socket", "name": "lower-tray-socket", "localPosition": [0, 0.9400000000000001, 0], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.65}, {"id": "nose-opening-socket", "name": "nose-opening-socket", "localPosition": [0, 1.1524999999999999, 1.18], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.3}, {"id": "panel-bolt-group-socket", "name": "panel-bolt-group-socket", "localPosition": [0, -0.004, 0], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.005}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "fuselage", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "white", "materialLayers": ["white"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "shell-seam", "type": "seam", "name": "shell-seam", "description": "Circumferential dark joint between upper and lower white shell", "placement": {"position": [0, 0, 0], "size": [0.02, 0.02, 0.02]}, "geometryEffect": "Circumferential dark joint between upper and lower white shell", "materialEffect": "unchanged", "confidence": 0.88, "evidenceRefs": ["full-object"]}, {"id": "shoulder-inset", "type": "linework", "name": "shoulder-inset", "description": "Two dark-blue elongated shoulder insets bounded by continuous curved geometry", "placement": {"position": [0, 0, 0], "size": [0.02, 0.02, 0.02]}, "geometryEffect": "Two dark-blue elongated shoulder insets bounded by continuous curved geometry", "materialEffect": "local albedo boundary", "confidence": 0.88, "evidenceRefs": ["full-object"]}, {"id": "brand-print", "type": "decal", "name": "brand-print", "description": "Side lettering 翔云智航; bird symbol approximate", "placement": {"position": [0, 0, 0], "size": [0.02, 0.02, 0.02]}, "geometryEffect": "Side lettering 翔云智航; bird symbol approximate", "materialEffect": "unchanged", "confidence": 0.88, "evidenceRefs": ["full-object"]}, {"id": "panel-slot", "type": "groove", "name": "panel-slot", "description": "Short gray horizontal side access slot", "placement": {"position": [0, 0, 0], "size": [0.02, 0.02, 0.02]}, "geometryEffect": "Short gray horizontal side access slot", "materialEffect": "unchanged", "confidence": 0.88, "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object", "structural-plan"], "details": ["fuselage observed in reference"], "fidelityTier": "reference-proportional", "colorMaterialRecipe": {"dominantAlbedo": "rgba(237,241,245,1)", "secondaryAlbedo": "rgba(237,241,245,1)", "materialClass": "plastic", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "roughness": 0.28, "metalness": 0}};
  node_fuselage_1.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "blue-inset-left-socket", "name": "blue-inset-left-socket", "localPosition": [-0.57, 1.465, -0.06], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.025}, {"id": "blue-inset-right-socket", "name": "blue-inset-right-socket", "localPosition": [0.57, 1.465, -0.06], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.025}, {"id": "lower-tray-socket", "name": "lower-tray-socket", "localPosition": [0, 0.9400000000000001, 0], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.65}, {"id": "nose-opening-socket", "name": "nose-opening-socket", "localPosition": [0, 1.1524999999999999, 1.18], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.3}, {"id": "panel-bolt-group-socket", "name": "panel-bolt-group-socket", "localPosition": [0, -0.004, 0], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.005}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "fuselage", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_fuselage_1);
  nodes["fuselage"] = node_fuselage_1;
  const mesh_fuselage_1Geometry = endpoint_fuselage_1
    ? new THREE.CylinderGeometry(endpoint_fuselage_1.endRadius, endpoint_fuselage_1.baseRadius, endpoint_fuselage_1.length, 32, 12)
    : buildLatheGeometry({"points": [[0.3, -0.5], [0.15, 0.0], [0.3, 0.5]], "segments": 24});
  if (!endpoint_fuselage_1) {
    mesh_fuselage_1Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_fuselage_1 = new THREE.Mesh(
    mesh_fuselage_1Geometry,
    materialMap["white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_fuselage_1.name = "fuselage";
  if (endpoint_fuselage_1) {
    mesh_fuselage_1.position.copy(endpoint_fuselage_1.midpoint);
    mesh_fuselage_1.quaternion.copy(endpoint_fuselage_1.quaternion);
  }
  mesh_fuselage_1.castShadow = options.castShadow ?? true;
  mesh_fuselage_1.receiveShadow = options.receiveShadow ?? true;
  mesh_fuselage_1.userData.sculptComponent = {"id": "fuselage", "name": "fuselage", "level": "macro", "role": "body", "importance": 0.9, "confidence": 0.9, "primitive": "lathe", "topologyClass": "continuous-sculpt", "topologyRationale": "Continuous lofted cross-sections give a variable-width convex surface.", "geometryDescriptor": {"topologyIntent": "closed anisotropic loft", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "loft": {"axis": "Y", "rings": [[-0.32, 0.8], [-0.26, 0.95], [-0.15, 1], [0, 1], [0.12, 0.97], [0.23, 0.83], [0.31, 0.12]], "crossSection": "superellipse exponent 2.8", "halfWidth": 0.7, "halfLength": 1.2}}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "fuselage-socket", "localStart": [0, 1.01, 0], "localEnd": [0, 1.6300000000000001, 0], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "baseRadius": 0.7, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.4, "height": 0.62, "depth": 2.4, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 1.32, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "blue-inset-left-socket", "name": "blue-inset-left-socket", "localPosition": [-0.57, 1.465, -0.06], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.025}, {"id": "blue-inset-right-socket", "name": "blue-inset-right-socket", "localPosition": [0.57, 1.465, -0.06], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.025}, {"id": "lower-tray-socket", "name": "lower-tray-socket", "localPosition": [0, 0.9400000000000001, 0], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.65}, {"id": "nose-opening-socket", "name": "nose-opening-socket", "localPosition": [0, 1.1524999999999999, 1.18], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.3}, {"id": "panel-bolt-group-socket", "name": "panel-bolt-group-socket", "localPosition": [0, -0.004, 0], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.005}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "fuselage", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "white", "materialLayers": ["white"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "shell-seam", "type": "seam", "name": "shell-seam", "description": "Circumferential dark joint between upper and lower white shell", "placement": {"position": [0, 0, 0], "size": [0.02, 0.02, 0.02]}, "geometryEffect": "Circumferential dark joint between upper and lower white shell", "materialEffect": "unchanged", "confidence": 0.88, "evidenceRefs": ["full-object"]}, {"id": "shoulder-inset", "type": "linework", "name": "shoulder-inset", "description": "Two dark-blue elongated shoulder insets bounded by continuous curved geometry", "placement": {"position": [0, 0, 0], "size": [0.02, 0.02, 0.02]}, "geometryEffect": "Two dark-blue elongated shoulder insets bounded by continuous curved geometry", "materialEffect": "local albedo boundary", "confidence": 0.88, "evidenceRefs": ["full-object"]}, {"id": "brand-print", "type": "decal", "name": "brand-print", "description": "Side lettering 翔云智航; bird symbol approximate", "placement": {"position": [0, 0, 0], "size": [0.02, 0.02, 0.02]}, "geometryEffect": "Side lettering 翔云智航; bird symbol approximate", "materialEffect": "unchanged", "confidence": 0.88, "evidenceRefs": ["full-object"]}, {"id": "panel-slot", "type": "groove", "name": "panel-slot", "description": "Short gray horizontal side access slot", "placement": {"position": [0, 0, 0], "size": [0.02, 0.02, 0.02]}, "geometryEffect": "Short gray horizontal side access slot", "materialEffect": "unchanged", "confidence": 0.88, "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object", "structural-plan"], "details": ["fuselage observed in reference"], "fidelityTier": "reference-proportional", "colorMaterialRecipe": {"dominantAlbedo": "rgba(237,241,245,1)", "secondaryAlbedo": "rgba(237,241,245,1)", "materialClass": "plastic", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "roughness": 0.28, "metalness": 0}};
  node_fuselage_1.add(mesh_fuselage_1);
  meshes["fuselage"] = mesh_fuselage_1;
  colliders["fuselage"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["fuselage"] ??= [];
  destructionGroups["fuselage"].push(node_fuselage_1);
  const socket_fuselage_blue_inset_left_socket_0 = new THREE.Object3D();
  socket_fuselage_blue_inset_left_socket_0.name = "blue-inset-left-socket";
  socket_fuselage_blue_inset_left_socket_0.position.set(-0.57, 1.465, -0.06);
  socket_fuselage_blue_inset_left_socket_0.rotation.set(0.0, 0.0, 0.0);
  socket_fuselage_blue_inset_left_socket_0.userData.socket = {"id": "blue-inset-left-socket", "name": "blue-inset-left-socket", "localPosition": [-0.57, 1.465, -0.06], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.025};
  node_fuselage_1.add(socket_fuselage_blue_inset_left_socket_0);
  sockets["fuselage:blue-inset-left-socket"] = socket_fuselage_blue_inset_left_socket_0;
  const socket_fuselage_blue_inset_right_socket_1 = new THREE.Object3D();
  socket_fuselage_blue_inset_right_socket_1.name = "blue-inset-right-socket";
  socket_fuselage_blue_inset_right_socket_1.position.set(0.57, 1.465, -0.06);
  socket_fuselage_blue_inset_right_socket_1.rotation.set(0.0, 0.0, 0.0);
  socket_fuselage_blue_inset_right_socket_1.userData.socket = {"id": "blue-inset-right-socket", "name": "blue-inset-right-socket", "localPosition": [0.57, 1.465, -0.06], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.025};
  node_fuselage_1.add(socket_fuselage_blue_inset_right_socket_1);
  sockets["fuselage:blue-inset-right-socket"] = socket_fuselage_blue_inset_right_socket_1;
  const socket_fuselage_lower_tray_socket_2 = new THREE.Object3D();
  socket_fuselage_lower_tray_socket_2.name = "lower-tray-socket";
  socket_fuselage_lower_tray_socket_2.position.set(0.0, 0.9400000000000001, 0.0);
  socket_fuselage_lower_tray_socket_2.rotation.set(0.0, 0.0, 0.0);
  socket_fuselage_lower_tray_socket_2.userData.socket = {"id": "lower-tray-socket", "name": "lower-tray-socket", "localPosition": [0, 0.9400000000000001, 0], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.65};
  node_fuselage_1.add(socket_fuselage_lower_tray_socket_2);
  sockets["fuselage:lower-tray-socket"] = socket_fuselage_lower_tray_socket_2;
  const socket_fuselage_nose_opening_socket_3 = new THREE.Object3D();
  socket_fuselage_nose_opening_socket_3.name = "nose-opening-socket";
  socket_fuselage_nose_opening_socket_3.position.set(0.0, 1.1524999999999999, 1.18);
  socket_fuselage_nose_opening_socket_3.rotation.set(0.0, 0.0, 0.0);
  socket_fuselage_nose_opening_socket_3.userData.socket = {"id": "nose-opening-socket", "name": "nose-opening-socket", "localPosition": [0, 1.1524999999999999, 1.18], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.3};
  node_fuselage_1.add(socket_fuselage_nose_opening_socket_3);
  sockets["fuselage:nose-opening-socket"] = socket_fuselage_nose_opening_socket_3;
  const socket_fuselage_panel_bolt_group_socket_4 = new THREE.Object3D();
  socket_fuselage_panel_bolt_group_socket_4.name = "panel-bolt-group-socket";
  socket_fuselage_panel_bolt_group_socket_4.position.set(0.0, -0.004, 0.0);
  socket_fuselage_panel_bolt_group_socket_4.rotation.set(0.0, 0.0, 0.0);
  socket_fuselage_panel_bolt_group_socket_4.userData.socket = {"id": "panel-bolt-group-socket", "name": "panel-bolt-group-socket", "localPosition": [0, -0.004, 0], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.005};
  node_fuselage_1.add(socket_fuselage_panel_bolt_group_socket_4);
  sockets["fuselage:panel-bolt-group-socket"] = socket_fuselage_panel_bolt_group_socket_4;

  const attachment_antenna_2 = {"parentId": "root", "parentSocket": "antenna-socket", "localStart": [0, 1.665, -0.65], "localEnd": [0, 1.795, -0.65], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "baseRadius": 0.365, "evidenceRefs": ["full-object"]};
  const endpoint_antenna_2 = makeAttachmentEndpoint(attachment_antenna_2);
  const node_antenna_2 = new THREE.Group();
  node_antenna_2.name = "antenna__pivot";
  node_antenna_2.scale.set(1, 1, 1);
  if (endpoint_antenna_2) {
    node_antenna_2.position.copy(endpoint_antenna_2.start);
    node_antenna_2.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_antenna_2.position.set(0.0, 1.73, -0.65);
    node_antenna_2.rotation.set(0.0, 0.0, 0.0);
  }
  node_antenna_2.userData.sculptComponent = {"id": "antenna", "name": "antenna", "level": "macro", "role": "body", "importance": 0.9, "confidence": 0.9, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Discrete cylindrical, extruded or tubular mechanical element.", "geometryDescriptor": {"topologyIntent": "closed profiled mechanical solid", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "antenna-socket", "localStart": [0, 1.665, -0.65], "localEnd": [0, 1.795, -0.65], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "baseRadius": 0.365, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.73, "height": 0.13, "depth": 0.73, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 1.73, -0.65], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "antenna-rim-socket", "name": "antenna-rim-socket", "localPosition": [0, 1.7475, -0.65], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.385}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "antenna", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "white", "materialLayers": ["white"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object", "structural-plan"], "details": ["antenna observed in reference"], "fidelityTier": "reference-proportional", "colorMaterialRecipe": {"dominantAlbedo": "rgba(237,241,245,1)", "secondaryAlbedo": "rgba(237,241,245,1)", "materialClass": "plastic", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "roughness": 0.28, "metalness": 0}};
  node_antenna_2.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "antenna-rim-socket", "name": "antenna-rim-socket", "localPosition": [0, 1.7475, -0.65], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.385}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "antenna", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_antenna_2);
  nodes["antenna"] = node_antenna_2;
  const mesh_antenna_2Geometry = endpoint_antenna_2
    ? new THREE.CylinderGeometry(endpoint_antenna_2.endRadius, endpoint_antenna_2.baseRadius, endpoint_antenna_2.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_antenna_2) {
    mesh_antenna_2Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_antenna_2 = new THREE.Mesh(
    mesh_antenna_2Geometry,
    materialMap["white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_antenna_2.name = "antenna";
  if (endpoint_antenna_2) {
    mesh_antenna_2.position.copy(endpoint_antenna_2.midpoint);
    mesh_antenna_2.quaternion.copy(endpoint_antenna_2.quaternion);
  }
  mesh_antenna_2.castShadow = options.castShadow ?? true;
  mesh_antenna_2.receiveShadow = options.receiveShadow ?? true;
  mesh_antenna_2.userData.sculptComponent = {"id": "antenna", "name": "antenna", "level": "macro", "role": "body", "importance": 0.9, "confidence": 0.9, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Discrete cylindrical, extruded or tubular mechanical element.", "geometryDescriptor": {"topologyIntent": "closed profiled mechanical solid", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "antenna-socket", "localStart": [0, 1.665, -0.65], "localEnd": [0, 1.795, -0.65], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "baseRadius": 0.365, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.73, "height": 0.13, "depth": 0.73, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 1.73, -0.65], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "antenna-rim-socket", "name": "antenna-rim-socket", "localPosition": [0, 1.7475, -0.65], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.385}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "antenna", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "white", "materialLayers": ["white"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object", "structural-plan"], "details": ["antenna observed in reference"], "fidelityTier": "reference-proportional", "colorMaterialRecipe": {"dominantAlbedo": "rgba(237,241,245,1)", "secondaryAlbedo": "rgba(237,241,245,1)", "materialClass": "plastic", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "roughness": 0.28, "metalness": 0}};
  node_antenna_2.add(mesh_antenna_2);
  meshes["antenna"] = mesh_antenna_2;
  colliders["antenna"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["antenna"] ??= [];
  destructionGroups["antenna"].push(node_antenna_2);
  const socket_antenna_antenna_rim_socket_0 = new THREE.Object3D();
  socket_antenna_antenna_rim_socket_0.name = "antenna-rim-socket";
  socket_antenna_antenna_rim_socket_0.position.set(0.0, 1.7475, -0.65);
  socket_antenna_antenna_rim_socket_0.rotation.set(0.0, 0.0, 0.0);
  socket_antenna_antenna_rim_socket_0.userData.socket = {"id": "antenna-rim-socket", "name": "antenna-rim-socket", "localPosition": [0, 1.7475, -0.65], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.385};
  node_antenna_2.add(socket_antenna_antenna_rim_socket_0);
  sockets["antenna:antenna-rim-socket"] = socket_antenna_antenna_rim_socket_0;

  const attachment_landing_gear_3 = {"parentId": "root", "parentSocket": "landing-gear-socket", "localStart": [0, -0.475, 0], "localEnd": [0, 0.475, 0], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "baseRadius": 0.6, "evidenceRefs": ["full-object"]};
  const endpoint_landing_gear_3 = makeAttachmentEndpoint(attachment_landing_gear_3);
  const node_landing_gear_3 = new THREE.Group();
  node_landing_gear_3.name = "landing-gear__pivot";
  node_landing_gear_3.scale.set(1, 1, 1);
  if (endpoint_landing_gear_3) {
    node_landing_gear_3.position.copy(endpoint_landing_gear_3.start);
    node_landing_gear_3.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_landing_gear_3.position.set(0.0, 0.0, 0.0);
    node_landing_gear_3.rotation.set(0.0, 0.0, 0.0);
  }
  node_landing_gear_3.userData.sculptComponent = {"id": "landing-gear", "name": "landing-gear", "level": "macro", "role": "body", "importance": 0.9, "confidence": 0.9, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Discrete cylindrical, extruded or tubular mechanical element.", "geometryDescriptor": {"topologyIntent": "closed profiled mechanical solid", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "paths": [[-0.53, 0.12, -1], [-0.53, 0.12, 1], [0.53, 0.12, -1], [0.53, 0.12, 1]]}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "landing-gear-socket", "localStart": [0, -0.475, 0], "localEnd": [0, 0.475, 0], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "baseRadius": 0.6, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.2, "height": 0.95, "depth": 2.1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "strut-left-rear-socket", "name": "strut-left-rear-socket", "localPosition": [-0.42, 0.99, -0.63], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.03}, {"id": "strut-left-front-socket", "name": "strut-left-front-socket", "localPosition": [-0.42, 0.99, 0.63], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.03}, {"id": "strut-right-rear-socket", "name": "strut-right-rear-socket", "localPosition": [0.42, 0.99, -0.63], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.03}, {"id": "strut-right-front-socket", "name": "strut-right-front-socket", "localPosition": [0.42, 0.99, 0.63], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.03}, {"id": "foot-cap-group-socket", "name": "foot-cap-group-socket", "localPosition": [0, -0.004, 0], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.005}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "landing-gear", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "graphite", "materialLayers": ["graphite"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "rubber-foot", "type": "bevel", "name": "rubber-foot", "description": "Four black landing contact foot caps", "placement": {"position": [0, 0, 0], "size": [0.02, 0.02, 0.02]}, "geometryEffect": "Four black landing contact foot caps", "materialEffect": "unchanged", "confidence": 0.88, "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object", "structural-plan"], "details": ["landing-gear observed in reference"], "fidelityTier": "reference-proportional", "colorMaterialRecipe": {"dominantAlbedo": "rgba(48,54,64,1)", "secondaryAlbedo": "rgba(48,54,64,1)", "materialClass": "plastic", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "roughness": 0.38, "metalness": 0.2}};
  node_landing_gear_3.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "strut-left-rear-socket", "name": "strut-left-rear-socket", "localPosition": [-0.42, 0.99, -0.63], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.03}, {"id": "strut-left-front-socket", "name": "strut-left-front-socket", "localPosition": [-0.42, 0.99, 0.63], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.03}, {"id": "strut-right-rear-socket", "name": "strut-right-rear-socket", "localPosition": [0.42, 0.99, -0.63], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.03}, {"id": "strut-right-front-socket", "name": "strut-right-front-socket", "localPosition": [0.42, 0.99, 0.63], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.03}, {"id": "foot-cap-group-socket", "name": "foot-cap-group-socket", "localPosition": [0, -0.004, 0], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.005}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "landing-gear", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_landing_gear_3);
  nodes["landing-gear"] = node_landing_gear_3;
  const mesh_landing_gear_3Geometry = endpoint_landing_gear_3
    ? new THREE.CylinderGeometry(endpoint_landing_gear_3.endRadius, endpoint_landing_gear_3.baseRadius, endpoint_landing_gear_3.length, 32, 12)
    : buildTubeGeometry({"points": [[0.0, -0.5, 0.0], [0.0, 0.5, 0.0]], "radius": 0.05, "closed": false});
  if (!endpoint_landing_gear_3) {
    mesh_landing_gear_3Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_landing_gear_3 = new THREE.Mesh(
    mesh_landing_gear_3Geometry,
    materialMap["graphite"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_landing_gear_3.name = "landing-gear";
  if (endpoint_landing_gear_3) {
    mesh_landing_gear_3.position.copy(endpoint_landing_gear_3.midpoint);
    mesh_landing_gear_3.quaternion.copy(endpoint_landing_gear_3.quaternion);
  }
  mesh_landing_gear_3.castShadow = options.castShadow ?? true;
  mesh_landing_gear_3.receiveShadow = options.receiveShadow ?? true;
  mesh_landing_gear_3.userData.sculptComponent = {"id": "landing-gear", "name": "landing-gear", "level": "macro", "role": "body", "importance": 0.9, "confidence": 0.9, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Discrete cylindrical, extruded or tubular mechanical element.", "geometryDescriptor": {"topologyIntent": "closed profiled mechanical solid", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "paths": [[-0.53, 0.12, -1], [-0.53, 0.12, 1], [0.53, 0.12, -1], [0.53, 0.12, 1]]}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "landing-gear-socket", "localStart": [0, -0.475, 0], "localEnd": [0, 0.475, 0], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "baseRadius": 0.6, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.2, "height": 0.95, "depth": 2.1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "strut-left-rear-socket", "name": "strut-left-rear-socket", "localPosition": [-0.42, 0.99, -0.63], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.03}, {"id": "strut-left-front-socket", "name": "strut-left-front-socket", "localPosition": [-0.42, 0.99, 0.63], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.03}, {"id": "strut-right-rear-socket", "name": "strut-right-rear-socket", "localPosition": [0.42, 0.99, -0.63], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.03}, {"id": "strut-right-front-socket", "name": "strut-right-front-socket", "localPosition": [0.42, 0.99, 0.63], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.03}, {"id": "foot-cap-group-socket", "name": "foot-cap-group-socket", "localPosition": [0, -0.004, 0], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.005}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "landing-gear", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "graphite", "materialLayers": ["graphite"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "rubber-foot", "type": "bevel", "name": "rubber-foot", "description": "Four black landing contact foot caps", "placement": {"position": [0, 0, 0], "size": [0.02, 0.02, 0.02]}, "geometryEffect": "Four black landing contact foot caps", "materialEffect": "unchanged", "confidence": 0.88, "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object", "structural-plan"], "details": ["landing-gear observed in reference"], "fidelityTier": "reference-proportional", "colorMaterialRecipe": {"dominantAlbedo": "rgba(48,54,64,1)", "secondaryAlbedo": "rgba(48,54,64,1)", "materialClass": "plastic", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "roughness": 0.38, "metalness": 0.2}};
  node_landing_gear_3.add(mesh_landing_gear_3);
  meshes["landing-gear"] = mesh_landing_gear_3;
  colliders["landing-gear"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["landing-gear"] ??= [];
  destructionGroups["landing-gear"].push(node_landing_gear_3);
  const socket_landing_gear_strut_left_rear_socket_0 = new THREE.Object3D();
  socket_landing_gear_strut_left_rear_socket_0.name = "strut-left-rear-socket";
  socket_landing_gear_strut_left_rear_socket_0.position.set(-0.42, 0.99, -0.63);
  socket_landing_gear_strut_left_rear_socket_0.rotation.set(0.0, 0.0, 0.0);
  socket_landing_gear_strut_left_rear_socket_0.userData.socket = {"id": "strut-left-rear-socket", "name": "strut-left-rear-socket", "localPosition": [-0.42, 0.99, -0.63], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.03};
  node_landing_gear_3.add(socket_landing_gear_strut_left_rear_socket_0);
  sockets["landing-gear:strut-left-rear-socket"] = socket_landing_gear_strut_left_rear_socket_0;
  const socket_landing_gear_strut_left_front_socket_1 = new THREE.Object3D();
  socket_landing_gear_strut_left_front_socket_1.name = "strut-left-front-socket";
  socket_landing_gear_strut_left_front_socket_1.position.set(-0.42, 0.99, 0.63);
  socket_landing_gear_strut_left_front_socket_1.rotation.set(0.0, 0.0, 0.0);
  socket_landing_gear_strut_left_front_socket_1.userData.socket = {"id": "strut-left-front-socket", "name": "strut-left-front-socket", "localPosition": [-0.42, 0.99, 0.63], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.03};
  node_landing_gear_3.add(socket_landing_gear_strut_left_front_socket_1);
  sockets["landing-gear:strut-left-front-socket"] = socket_landing_gear_strut_left_front_socket_1;
  const socket_landing_gear_strut_right_rear_socket_2 = new THREE.Object3D();
  socket_landing_gear_strut_right_rear_socket_2.name = "strut-right-rear-socket";
  socket_landing_gear_strut_right_rear_socket_2.position.set(0.42, 0.99, -0.63);
  socket_landing_gear_strut_right_rear_socket_2.rotation.set(0.0, 0.0, 0.0);
  socket_landing_gear_strut_right_rear_socket_2.userData.socket = {"id": "strut-right-rear-socket", "name": "strut-right-rear-socket", "localPosition": [0.42, 0.99, -0.63], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.03};
  node_landing_gear_3.add(socket_landing_gear_strut_right_rear_socket_2);
  sockets["landing-gear:strut-right-rear-socket"] = socket_landing_gear_strut_right_rear_socket_2;
  const socket_landing_gear_strut_right_front_socket_3 = new THREE.Object3D();
  socket_landing_gear_strut_right_front_socket_3.name = "strut-right-front-socket";
  socket_landing_gear_strut_right_front_socket_3.position.set(0.42, 0.99, 0.63);
  socket_landing_gear_strut_right_front_socket_3.rotation.set(0.0, 0.0, 0.0);
  socket_landing_gear_strut_right_front_socket_3.userData.socket = {"id": "strut-right-front-socket", "name": "strut-right-front-socket", "localPosition": [0.42, 0.99, 0.63], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.03};
  node_landing_gear_3.add(socket_landing_gear_strut_right_front_socket_3);
  sockets["landing-gear:strut-right-front-socket"] = socket_landing_gear_strut_right_front_socket_3;
  const socket_landing_gear_foot_cap_group_socket_4 = new THREE.Object3D();
  socket_landing_gear_foot_cap_group_socket_4.name = "foot-cap-group-socket";
  socket_landing_gear_foot_cap_group_socket_4.position.set(0.0, -0.004, 0.0);
  socket_landing_gear_foot_cap_group_socket_4.rotation.set(0.0, 0.0, 0.0);
  socket_landing_gear_foot_cap_group_socket_4.userData.socket = {"id": "foot-cap-group-socket", "name": "foot-cap-group-socket", "localPosition": [0, -0.004, 0], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.005};
  node_landing_gear_3.add(socket_landing_gear_foot_cap_group_socket_4);
  sockets["landing-gear:foot-cap-group-socket"] = socket_landing_gear_foot_cap_group_socket_4;

  const attachment_arm_1_4 = {"parentSocket": "boom-1", "localStart": [0.48, 1.19, 0.83], "localEnd": [1.04, 1.19, 1.84], "contactType": "socket", "embedDepth": 0.06, "overlap": 0.04, "gapTolerance": 0.01, "baseRadius": 0.0525};
  const endpoint_arm_1_4 = makeAttachmentEndpoint(attachment_arm_1_4);
  const node_arm_1_4 = new THREE.Group();
  node_arm_1_4.name = "arm-1__pivot";
  node_arm_1_4.scale.set(1, 1, 1);
  if (endpoint_arm_1_4) {
    node_arm_1_4.position.copy(endpoint_arm_1_4.start);
    node_arm_1_4.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_arm_1_4.position.set(0.0, 0.0, 0.0);
    node_arm_1_4.rotation.set(0.0, 0.0, 0.0);
  }
  node_arm_1_4.userData.sculptComponent = {"id": "arm-1", "name": "arm-1", "level": "macro", "role": "boom", "importance": 0.9, "confidence": 0.9, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Discrete cylindrical, extruded or tubular mechanical element.", "geometryDescriptor": {"topologyIntent": "closed profiled mechanical solid", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "endpoints": {"start": [0.48, 1.19, 0.83], "end": [1.04, 1.19, 1.84]}}, "parent": "root", "attachment": {"parentSocket": "boom-1", "localStart": [0.48, 1.19, 0.83], "localEnd": [1.04, 1.19, 1.84], "contactType": "socket", "embedDepth": 0.06, "overlap": 0.04, "gapTolerance": 0.01, "baseRadius": 0.0525}, "dimensions": {"width": 0.105, "height": 1.154859298789251, "depth": 0.105, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "motor-mount-1-socket", "name": "motor-mount-1-socket", "localPosition": [1.04, 1.0999999999999999, 1.84], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.13}, {"id": "motor-1-socket", "name": "motor-1-socket", "localPosition": [1.04, 1.2799999999999998, 1.84], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.1175}, {"id": "rotor-1-socket", "name": "rotor-1-socket", "localPosition": [1.04, 1.5190000000000001, 1.84], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.9}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "arm-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "silver", "materialLayers": ["silver"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "arm-collar", "type": "ridge", "name": "arm-collar", "description": "Blue root socket ring and exposed silver tube", "placement": {"position": [0, 0, 0], "size": [0.02, 0.02, 0.02]}, "geometryEffect": "Blue root socket ring and exposed silver tube", "materialEffect": "unchanged", "confidence": 0.88, "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object", "structural-plan"], "details": ["arm-1 observed in reference"], "fidelityTier": "reference-proportional", "colorMaterialRecipe": {"dominantAlbedo": "rgba(198,206,216,1)", "secondaryAlbedo": "rgba(198,206,216,1)", "materialClass": "metal", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "roughness": 0.26, "metalness": 0.92}};
  node_arm_1_4.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "motor-mount-1-socket", "name": "motor-mount-1-socket", "localPosition": [1.04, 1.0999999999999999, 1.84], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.13}, {"id": "motor-1-socket", "name": "motor-1-socket", "localPosition": [1.04, 1.2799999999999998, 1.84], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.1175}, {"id": "rotor-1-socket", "name": "rotor-1-socket", "localPosition": [1.04, 1.5190000000000001, 1.84], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.9}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "arm-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_arm_1_4);
  nodes["arm-1"] = node_arm_1_4;
  const mesh_arm_1_4Geometry = endpoint_arm_1_4
    ? new THREE.CylinderGeometry(endpoint_arm_1_4.endRadius, endpoint_arm_1_4.baseRadius, endpoint_arm_1_4.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_arm_1_4) {
    mesh_arm_1_4Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_arm_1_4 = new THREE.Mesh(
    mesh_arm_1_4Geometry,
    materialMap["silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_arm_1_4.name = "arm-1";
  if (endpoint_arm_1_4) {
    mesh_arm_1_4.position.copy(endpoint_arm_1_4.midpoint);
    mesh_arm_1_4.quaternion.copy(endpoint_arm_1_4.quaternion);
  }
  mesh_arm_1_4.castShadow = options.castShadow ?? true;
  mesh_arm_1_4.receiveShadow = options.receiveShadow ?? true;
  mesh_arm_1_4.userData.sculptComponent = {"id": "arm-1", "name": "arm-1", "level": "macro", "role": "boom", "importance": 0.9, "confidence": 0.9, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Discrete cylindrical, extruded or tubular mechanical element.", "geometryDescriptor": {"topologyIntent": "closed profiled mechanical solid", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "endpoints": {"start": [0.48, 1.19, 0.83], "end": [1.04, 1.19, 1.84]}}, "parent": "root", "attachment": {"parentSocket": "boom-1", "localStart": [0.48, 1.19, 0.83], "localEnd": [1.04, 1.19, 1.84], "contactType": "socket", "embedDepth": 0.06, "overlap": 0.04, "gapTolerance": 0.01, "baseRadius": 0.0525}, "dimensions": {"width": 0.105, "height": 1.154859298789251, "depth": 0.105, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "motor-mount-1-socket", "name": "motor-mount-1-socket", "localPosition": [1.04, 1.0999999999999999, 1.84], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.13}, {"id": "motor-1-socket", "name": "motor-1-socket", "localPosition": [1.04, 1.2799999999999998, 1.84], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.1175}, {"id": "rotor-1-socket", "name": "rotor-1-socket", "localPosition": [1.04, 1.5190000000000001, 1.84], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.9}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "arm-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "silver", "materialLayers": ["silver"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "arm-collar", "type": "ridge", "name": "arm-collar", "description": "Blue root socket ring and exposed silver tube", "placement": {"position": [0, 0, 0], "size": [0.02, 0.02, 0.02]}, "geometryEffect": "Blue root socket ring and exposed silver tube", "materialEffect": "unchanged", "confidence": 0.88, "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object", "structural-plan"], "details": ["arm-1 observed in reference"], "fidelityTier": "reference-proportional", "colorMaterialRecipe": {"dominantAlbedo": "rgba(198,206,216,1)", "secondaryAlbedo": "rgba(198,206,216,1)", "materialClass": "metal", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "roughness": 0.26, "metalness": 0.92}};
  node_arm_1_4.add(mesh_arm_1_4);
  meshes["arm-1"] = mesh_arm_1_4;
  colliders["arm-1"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["arm-1"] ??= [];
  destructionGroups["arm-1"].push(node_arm_1_4);
  const socket_arm_1_motor_mount_1_socket_0 = new THREE.Object3D();
  socket_arm_1_motor_mount_1_socket_0.name = "motor-mount-1-socket";
  socket_arm_1_motor_mount_1_socket_0.position.set(1.04, 1.0999999999999999, 1.84);
  socket_arm_1_motor_mount_1_socket_0.rotation.set(0.0, 0.0, 0.0);
  socket_arm_1_motor_mount_1_socket_0.userData.socket = {"id": "motor-mount-1-socket", "name": "motor-mount-1-socket", "localPosition": [1.04, 1.0999999999999999, 1.84], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.13};
  node_arm_1_4.add(socket_arm_1_motor_mount_1_socket_0);
  sockets["arm-1:motor-mount-1-socket"] = socket_arm_1_motor_mount_1_socket_0;
  const socket_arm_1_motor_1_socket_1 = new THREE.Object3D();
  socket_arm_1_motor_1_socket_1.name = "motor-1-socket";
  socket_arm_1_motor_1_socket_1.position.set(1.04, 1.2799999999999998, 1.84);
  socket_arm_1_motor_1_socket_1.rotation.set(0.0, 0.0, 0.0);
  socket_arm_1_motor_1_socket_1.userData.socket = {"id": "motor-1-socket", "name": "motor-1-socket", "localPosition": [1.04, 1.2799999999999998, 1.84], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.1175};
  node_arm_1_4.add(socket_arm_1_motor_1_socket_1);
  sockets["arm-1:motor-1-socket"] = socket_arm_1_motor_1_socket_1;
  const socket_arm_1_rotor_1_socket_2 = new THREE.Object3D();
  socket_arm_1_rotor_1_socket_2.name = "rotor-1-socket";
  socket_arm_1_rotor_1_socket_2.position.set(1.04, 1.5190000000000001, 1.84);
  socket_arm_1_rotor_1_socket_2.rotation.set(0.0, 0.0, 0.0);
  socket_arm_1_rotor_1_socket_2.userData.socket = {"id": "rotor-1-socket", "name": "rotor-1-socket", "localPosition": [1.04, 1.5190000000000001, 1.84], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.9};
  node_arm_1_4.add(socket_arm_1_rotor_1_socket_2);
  sockets["arm-1:rotor-1-socket"] = socket_arm_1_rotor_1_socket_2;

  const endpoint_rotor_1_5 = makeAttachmentEndpoint(null);
  const node_rotor_1_5 = new THREE.Group();
  node_rotor_1_5.name = "rotor-1__pivot";
  node_rotor_1_5.scale.set(1, 1, 1);
  if (endpoint_rotor_1_5) {
    node_rotor_1_5.position.copy(endpoint_rotor_1_5.start);
    node_rotor_1_5.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_rotor_1_5.position.set(1.04, 1.53, 1.84);
    node_rotor_1_5.rotation.set(0.0, 0.0, 0.0);
  }
  node_rotor_1_5.userData.sculptComponent = {"id": "rotor-1", "name": "rotor-1", "level": "macro", "role": "body", "importance": 0.9, "confidence": 0.9, "primitive": "extrude", "topologyClass": "continuous-sculpt", "topologyRationale": "Continuous lofted cross-sections give a variable-width convex surface.", "geometryDescriptor": {"topologyIntent": "closed anisotropic loft", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "bladeProfile": [[0.08, 0], [0.2, 0.02], [0.35, 0.095], [0.8, 0.075], [0.9, 0.045], [0.88, -0.025], [0.36, -0.04], [0.22, -0.02]], "pitchDegrees": 9, "bladeCount": 2}, "parent": "arm-1", "attachment": {"parentId": "arm-1", "parentSocket": "rotor-1-socket", "localStart": [1.04, 1.5190000000000001, 1.84], "localEnd": [1.04, 1.541, 1.84], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "baseRadius": 0.9, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.8, "height": 0.022, "depth": 0.18, "units": "relative", "confidence": 0.85}, "transform": {"position": [1.04, 1.53, 1.84], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "rotor", "pivot": {"mode": "center", "localPosition": [1.04, 1.53, 1.84], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rotor-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "graphite", "materialLayers": ["graphite"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "blade-tip", "type": "linework", "name": "blade-tip", "description": "White distal blade tips on twelve blades", "placement": {"position": [0, 0, 0], "size": [0.02, 0.02, 0.02]}, "geometryEffect": "White distal blade tips on twelve blades", "materialEffect": "local albedo boundary", "confidence": 0.88, "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object", "structural-plan"], "details": ["rotor-1 observed in reference"], "fidelityTier": "reference-proportional", "colorMaterialRecipe": {"dominantAlbedo": "rgba(48,54,64,1)", "secondaryAlbedo": "rgba(48,54,64,1)", "materialClass": "plastic", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "roughness": 0.38, "metalness": 0.2}};
  node_rotor_1_5.userData.actionProfile = {"animationRole": "rotor", "pivot": {"mode": "center", "localPosition": [1.04, 1.53, 1.84], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rotor-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["arm-1"] ?? root).add(node_rotor_1_5);
  nodes["rotor-1"] = node_rotor_1_5;
  const mesh_rotor_1_5Geometry = endpoint_rotor_1_5
    ? new THREE.CylinderGeometry(endpoint_rotor_1_5.endRadius, endpoint_rotor_1_5.baseRadius, endpoint_rotor_1_5.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]], "depth": 0.1});
  if (!endpoint_rotor_1_5) {
    mesh_rotor_1_5Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_rotor_1_5 = new THREE.Mesh(
    mesh_rotor_1_5Geometry,
    materialMap["graphite"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rotor_1_5.name = "rotor-1";
  if (endpoint_rotor_1_5) {
    mesh_rotor_1_5.position.copy(endpoint_rotor_1_5.midpoint);
    mesh_rotor_1_5.quaternion.copy(endpoint_rotor_1_5.quaternion);
  }
  mesh_rotor_1_5.castShadow = options.castShadow ?? true;
  mesh_rotor_1_5.receiveShadow = options.receiveShadow ?? true;
  mesh_rotor_1_5.userData.sculptComponent = {"id": "rotor-1", "name": "rotor-1", "level": "macro", "role": "body", "importance": 0.9, "confidence": 0.9, "primitive": "extrude", "topologyClass": "continuous-sculpt", "topologyRationale": "Continuous lofted cross-sections give a variable-width convex surface.", "geometryDescriptor": {"topologyIntent": "closed anisotropic loft", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "bladeProfile": [[0.08, 0], [0.2, 0.02], [0.35, 0.095], [0.8, 0.075], [0.9, 0.045], [0.88, -0.025], [0.36, -0.04], [0.22, -0.02]], "pitchDegrees": 9, "bladeCount": 2}, "parent": "arm-1", "attachment": {"parentId": "arm-1", "parentSocket": "rotor-1-socket", "localStart": [1.04, 1.5190000000000001, 1.84], "localEnd": [1.04, 1.541, 1.84], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "baseRadius": 0.9, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.8, "height": 0.022, "depth": 0.18, "units": "relative", "confidence": 0.85}, "transform": {"position": [1.04, 1.53, 1.84], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "rotor", "pivot": {"mode": "center", "localPosition": [1.04, 1.53, 1.84], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rotor-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "graphite", "materialLayers": ["graphite"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "blade-tip", "type": "linework", "name": "blade-tip", "description": "White distal blade tips on twelve blades", "placement": {"position": [0, 0, 0], "size": [0.02, 0.02, 0.02]}, "geometryEffect": "White distal blade tips on twelve blades", "materialEffect": "local albedo boundary", "confidence": 0.88, "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object", "structural-plan"], "details": ["rotor-1 observed in reference"], "fidelityTier": "reference-proportional", "colorMaterialRecipe": {"dominantAlbedo": "rgba(48,54,64,1)", "secondaryAlbedo": "rgba(48,54,64,1)", "materialClass": "plastic", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "roughness": 0.38, "metalness": 0.2}};
  node_rotor_1_5.add(mesh_rotor_1_5);
  meshes["rotor-1"] = mesh_rotor_1_5;
  colliders["rotor-1"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["rotor-1"] ??= [];
  destructionGroups["rotor-1"].push(node_rotor_1_5);

  const attachment_arm_2_6 = {"parentSocket": "boom-2", "localStart": [0.62, 1.19, 0], "localEnd": [2.11, 1.19, 0], "contactType": "socket", "embedDepth": 0.06, "overlap": 0.04, "gapTolerance": 0.01, "baseRadius": 0.0525};
  const endpoint_arm_2_6 = makeAttachmentEndpoint(attachment_arm_2_6);
  const node_arm_2_6 = new THREE.Group();
  node_arm_2_6.name = "arm-2__pivot";
  node_arm_2_6.scale.set(1, 1, 1);
  if (endpoint_arm_2_6) {
    node_arm_2_6.position.copy(endpoint_arm_2_6.start);
    node_arm_2_6.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_arm_2_6.position.set(0.0, 0.0, 0.0);
    node_arm_2_6.rotation.set(0.0, 0.0, 0.0);
  }
  node_arm_2_6.userData.sculptComponent = {"id": "arm-2", "name": "arm-2", "level": "macro", "role": "boom", "importance": 0.9, "confidence": 0.9, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Discrete cylindrical, extruded or tubular mechanical element.", "geometryDescriptor": {"topologyIntent": "closed profiled mechanical solid", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "endpoints": {"start": [0.62, 1.19, 0], "end": [2.11, 1.19, 0]}}, "parent": "root", "attachment": {"parentSocket": "boom-2", "localStart": [0.62, 1.19, 0], "localEnd": [2.11, 1.19, 0], "contactType": "socket", "embedDepth": 0.06, "overlap": 0.04, "gapTolerance": 0.01, "baseRadius": 0.0525}, "dimensions": {"width": 0.105, "height": 1.4899999999999998, "depth": 0.105, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "motor-mount-2-socket", "name": "motor-mount-2-socket", "localPosition": [2.11, 1.0999999999999999, 0], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.13}, {"id": "motor-2-socket", "name": "motor-2-socket", "localPosition": [2.11, 1.2799999999999998, 0], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.1175}, {"id": "rotor-2-socket", "name": "rotor-2-socket", "localPosition": [2.11, 1.5190000000000001, 0], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.9}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "arm-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "silver", "materialLayers": ["silver"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object", "structural-plan"], "details": ["arm-2 observed in reference"], "fidelityTier": "reference-proportional", "colorMaterialRecipe": {"dominantAlbedo": "rgba(198,206,216,1)", "secondaryAlbedo": "rgba(198,206,216,1)", "materialClass": "metal", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "roughness": 0.26, "metalness": 0.92}};
  node_arm_2_6.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "motor-mount-2-socket", "name": "motor-mount-2-socket", "localPosition": [2.11, 1.0999999999999999, 0], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.13}, {"id": "motor-2-socket", "name": "motor-2-socket", "localPosition": [2.11, 1.2799999999999998, 0], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.1175}, {"id": "rotor-2-socket", "name": "rotor-2-socket", "localPosition": [2.11, 1.5190000000000001, 0], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.9}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "arm-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_arm_2_6);
  nodes["arm-2"] = node_arm_2_6;
  const mesh_arm_2_6Geometry = endpoint_arm_2_6
    ? new THREE.CylinderGeometry(endpoint_arm_2_6.endRadius, endpoint_arm_2_6.baseRadius, endpoint_arm_2_6.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_arm_2_6) {
    mesh_arm_2_6Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_arm_2_6 = new THREE.Mesh(
    mesh_arm_2_6Geometry,
    materialMap["silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_arm_2_6.name = "arm-2";
  if (endpoint_arm_2_6) {
    mesh_arm_2_6.position.copy(endpoint_arm_2_6.midpoint);
    mesh_arm_2_6.quaternion.copy(endpoint_arm_2_6.quaternion);
  }
  mesh_arm_2_6.castShadow = options.castShadow ?? true;
  mesh_arm_2_6.receiveShadow = options.receiveShadow ?? true;
  mesh_arm_2_6.userData.sculptComponent = {"id": "arm-2", "name": "arm-2", "level": "macro", "role": "boom", "importance": 0.9, "confidence": 0.9, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Discrete cylindrical, extruded or tubular mechanical element.", "geometryDescriptor": {"topologyIntent": "closed profiled mechanical solid", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "endpoints": {"start": [0.62, 1.19, 0], "end": [2.11, 1.19, 0]}}, "parent": "root", "attachment": {"parentSocket": "boom-2", "localStart": [0.62, 1.19, 0], "localEnd": [2.11, 1.19, 0], "contactType": "socket", "embedDepth": 0.06, "overlap": 0.04, "gapTolerance": 0.01, "baseRadius": 0.0525}, "dimensions": {"width": 0.105, "height": 1.4899999999999998, "depth": 0.105, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "motor-mount-2-socket", "name": "motor-mount-2-socket", "localPosition": [2.11, 1.0999999999999999, 0], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.13}, {"id": "motor-2-socket", "name": "motor-2-socket", "localPosition": [2.11, 1.2799999999999998, 0], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.1175}, {"id": "rotor-2-socket", "name": "rotor-2-socket", "localPosition": [2.11, 1.5190000000000001, 0], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.9}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "arm-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "silver", "materialLayers": ["silver"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object", "structural-plan"], "details": ["arm-2 observed in reference"], "fidelityTier": "reference-proportional", "colorMaterialRecipe": {"dominantAlbedo": "rgba(198,206,216,1)", "secondaryAlbedo": "rgba(198,206,216,1)", "materialClass": "metal", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "roughness": 0.26, "metalness": 0.92}};
  node_arm_2_6.add(mesh_arm_2_6);
  meshes["arm-2"] = mesh_arm_2_6;
  colliders["arm-2"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["arm-2"] ??= [];
  destructionGroups["arm-2"].push(node_arm_2_6);
  const socket_arm_2_motor_mount_2_socket_0 = new THREE.Object3D();
  socket_arm_2_motor_mount_2_socket_0.name = "motor-mount-2-socket";
  socket_arm_2_motor_mount_2_socket_0.position.set(2.11, 1.0999999999999999, 0.0);
  socket_arm_2_motor_mount_2_socket_0.rotation.set(0.0, 0.0, 0.0);
  socket_arm_2_motor_mount_2_socket_0.userData.socket = {"id": "motor-mount-2-socket", "name": "motor-mount-2-socket", "localPosition": [2.11, 1.0999999999999999, 0], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.13};
  node_arm_2_6.add(socket_arm_2_motor_mount_2_socket_0);
  sockets["arm-2:motor-mount-2-socket"] = socket_arm_2_motor_mount_2_socket_0;
  const socket_arm_2_motor_2_socket_1 = new THREE.Object3D();
  socket_arm_2_motor_2_socket_1.name = "motor-2-socket";
  socket_arm_2_motor_2_socket_1.position.set(2.11, 1.2799999999999998, 0.0);
  socket_arm_2_motor_2_socket_1.rotation.set(0.0, 0.0, 0.0);
  socket_arm_2_motor_2_socket_1.userData.socket = {"id": "motor-2-socket", "name": "motor-2-socket", "localPosition": [2.11, 1.2799999999999998, 0], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.1175};
  node_arm_2_6.add(socket_arm_2_motor_2_socket_1);
  sockets["arm-2:motor-2-socket"] = socket_arm_2_motor_2_socket_1;
  const socket_arm_2_rotor_2_socket_2 = new THREE.Object3D();
  socket_arm_2_rotor_2_socket_2.name = "rotor-2-socket";
  socket_arm_2_rotor_2_socket_2.position.set(2.11, 1.5190000000000001, 0.0);
  socket_arm_2_rotor_2_socket_2.rotation.set(0.0, 0.0, 0.0);
  socket_arm_2_rotor_2_socket_2.userData.socket = {"id": "rotor-2-socket", "name": "rotor-2-socket", "localPosition": [2.11, 1.5190000000000001, 0], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.9};
  node_arm_2_6.add(socket_arm_2_rotor_2_socket_2);
  sockets["arm-2:rotor-2-socket"] = socket_arm_2_rotor_2_socket_2;

  const endpoint_rotor_2_7 = makeAttachmentEndpoint(null);
  const node_rotor_2_7 = new THREE.Group();
  node_rotor_2_7.name = "rotor-2__pivot";
  node_rotor_2_7.scale.set(1, 1, 1);
  if (endpoint_rotor_2_7) {
    node_rotor_2_7.position.copy(endpoint_rotor_2_7.start);
    node_rotor_2_7.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_rotor_2_7.position.set(2.11, 1.53, 0.0);
    node_rotor_2_7.rotation.set(0.0, 0.0, 0.0);
  }
  node_rotor_2_7.userData.sculptComponent = {"id": "rotor-2", "name": "rotor-2", "level": "macro", "role": "body", "importance": 0.9, "confidence": 0.9, "primitive": "extrude", "topologyClass": "continuous-sculpt", "topologyRationale": "Continuous lofted cross-sections give a variable-width convex surface.", "geometryDescriptor": {"topologyIntent": "closed anisotropic loft", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "bladeProfile": [[0.08, 0], [0.2, 0.02], [0.35, 0.095], [0.8, 0.075], [0.9, 0.045], [0.88, -0.025], [0.36, -0.04], [0.22, -0.02]], "pitchDegrees": 9, "bladeCount": 2}, "parent": "arm-2", "attachment": {"parentId": "arm-2", "parentSocket": "rotor-2-socket", "localStart": [2.11, 1.5190000000000001, 0], "localEnd": [2.11, 1.541, 0], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "baseRadius": 0.9, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.8, "height": 0.022, "depth": 0.18, "units": "relative", "confidence": 0.85}, "transform": {"position": [2.11, 1.53, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "rotor", "pivot": {"mode": "center", "localPosition": [2.11, 1.53, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rotor-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "graphite", "materialLayers": ["graphite"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object", "structural-plan"], "details": ["rotor-2 observed in reference"], "fidelityTier": "reference-proportional", "colorMaterialRecipe": {"dominantAlbedo": "rgba(48,54,64,1)", "secondaryAlbedo": "rgba(48,54,64,1)", "materialClass": "plastic", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "roughness": 0.38, "metalness": 0.2}};
  node_rotor_2_7.userData.actionProfile = {"animationRole": "rotor", "pivot": {"mode": "center", "localPosition": [2.11, 1.53, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rotor-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["arm-2"] ?? root).add(node_rotor_2_7);
  nodes["rotor-2"] = node_rotor_2_7;
  const mesh_rotor_2_7Geometry = endpoint_rotor_2_7
    ? new THREE.CylinderGeometry(endpoint_rotor_2_7.endRadius, endpoint_rotor_2_7.baseRadius, endpoint_rotor_2_7.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]], "depth": 0.1});
  if (!endpoint_rotor_2_7) {
    mesh_rotor_2_7Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_rotor_2_7 = new THREE.Mesh(
    mesh_rotor_2_7Geometry,
    materialMap["graphite"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rotor_2_7.name = "rotor-2";
  if (endpoint_rotor_2_7) {
    mesh_rotor_2_7.position.copy(endpoint_rotor_2_7.midpoint);
    mesh_rotor_2_7.quaternion.copy(endpoint_rotor_2_7.quaternion);
  }
  mesh_rotor_2_7.castShadow = options.castShadow ?? true;
  mesh_rotor_2_7.receiveShadow = options.receiveShadow ?? true;
  mesh_rotor_2_7.userData.sculptComponent = {"id": "rotor-2", "name": "rotor-2", "level": "macro", "role": "body", "importance": 0.9, "confidence": 0.9, "primitive": "extrude", "topologyClass": "continuous-sculpt", "topologyRationale": "Continuous lofted cross-sections give a variable-width convex surface.", "geometryDescriptor": {"topologyIntent": "closed anisotropic loft", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "bladeProfile": [[0.08, 0], [0.2, 0.02], [0.35, 0.095], [0.8, 0.075], [0.9, 0.045], [0.88, -0.025], [0.36, -0.04], [0.22, -0.02]], "pitchDegrees": 9, "bladeCount": 2}, "parent": "arm-2", "attachment": {"parentId": "arm-2", "parentSocket": "rotor-2-socket", "localStart": [2.11, 1.5190000000000001, 0], "localEnd": [2.11, 1.541, 0], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "baseRadius": 0.9, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.8, "height": 0.022, "depth": 0.18, "units": "relative", "confidence": 0.85}, "transform": {"position": [2.11, 1.53, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "rotor", "pivot": {"mode": "center", "localPosition": [2.11, 1.53, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rotor-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "graphite", "materialLayers": ["graphite"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object", "structural-plan"], "details": ["rotor-2 observed in reference"], "fidelityTier": "reference-proportional", "colorMaterialRecipe": {"dominantAlbedo": "rgba(48,54,64,1)", "secondaryAlbedo": "rgba(48,54,64,1)", "materialClass": "plastic", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "roughness": 0.38, "metalness": 0.2}};
  node_rotor_2_7.add(mesh_rotor_2_7);
  meshes["rotor-2"] = mesh_rotor_2_7;
  colliders["rotor-2"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["rotor-2"] ??= [];
  destructionGroups["rotor-2"].push(node_rotor_2_7);

  const attachment_arm_3_8 = {"parentSocket": "boom-3", "localStart": [0.48, 1.19, -0.83], "localEnd": [1.04, 1.19, -1.84], "contactType": "socket", "embedDepth": 0.06, "overlap": 0.04, "gapTolerance": 0.01, "baseRadius": 0.0525};
  const endpoint_arm_3_8 = makeAttachmentEndpoint(attachment_arm_3_8);
  const node_arm_3_8 = new THREE.Group();
  node_arm_3_8.name = "arm-3__pivot";
  node_arm_3_8.scale.set(1, 1, 1);
  if (endpoint_arm_3_8) {
    node_arm_3_8.position.copy(endpoint_arm_3_8.start);
    node_arm_3_8.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_arm_3_8.position.set(0.0, 0.0, 0.0);
    node_arm_3_8.rotation.set(0.0, 0.0, 0.0);
  }
  node_arm_3_8.userData.sculptComponent = {"id": "arm-3", "name": "arm-3", "level": "macro", "role": "boom", "importance": 0.9, "confidence": 0.9, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Discrete cylindrical, extruded or tubular mechanical element.", "geometryDescriptor": {"topologyIntent": "closed profiled mechanical solid", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "endpoints": {"start": [0.48, 1.19, -0.83], "end": [1.04, 1.19, -1.84]}}, "parent": "root", "attachment": {"parentSocket": "boom-3", "localStart": [0.48, 1.19, -0.83], "localEnd": [1.04, 1.19, -1.84], "contactType": "socket", "embedDepth": 0.06, "overlap": 0.04, "gapTolerance": 0.01, "baseRadius": 0.0525}, "dimensions": {"width": 0.105, "height": 1.154859298789251, "depth": 0.105, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "motor-mount-3-socket", "name": "motor-mount-3-socket", "localPosition": [1.04, 1.0999999999999999, -1.84], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.13}, {"id": "motor-3-socket", "name": "motor-3-socket", "localPosition": [1.04, 1.2799999999999998, -1.84], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.1175}, {"id": "rotor-3-socket", "name": "rotor-3-socket", "localPosition": [1.04, 1.5190000000000001, -1.84], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.9}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "arm-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "silver", "materialLayers": ["silver"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object", "structural-plan"], "details": ["arm-3 observed in reference"], "fidelityTier": "reference-proportional", "colorMaterialRecipe": {"dominantAlbedo": "rgba(198,206,216,1)", "secondaryAlbedo": "rgba(198,206,216,1)", "materialClass": "metal", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "roughness": 0.26, "metalness": 0.92}};
  node_arm_3_8.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "motor-mount-3-socket", "name": "motor-mount-3-socket", "localPosition": [1.04, 1.0999999999999999, -1.84], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.13}, {"id": "motor-3-socket", "name": "motor-3-socket", "localPosition": [1.04, 1.2799999999999998, -1.84], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.1175}, {"id": "rotor-3-socket", "name": "rotor-3-socket", "localPosition": [1.04, 1.5190000000000001, -1.84], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.9}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "arm-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_arm_3_8);
  nodes["arm-3"] = node_arm_3_8;
  const mesh_arm_3_8Geometry = endpoint_arm_3_8
    ? new THREE.CylinderGeometry(endpoint_arm_3_8.endRadius, endpoint_arm_3_8.baseRadius, endpoint_arm_3_8.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_arm_3_8) {
    mesh_arm_3_8Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_arm_3_8 = new THREE.Mesh(
    mesh_arm_3_8Geometry,
    materialMap["silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_arm_3_8.name = "arm-3";
  if (endpoint_arm_3_8) {
    mesh_arm_3_8.position.copy(endpoint_arm_3_8.midpoint);
    mesh_arm_3_8.quaternion.copy(endpoint_arm_3_8.quaternion);
  }
  mesh_arm_3_8.castShadow = options.castShadow ?? true;
  mesh_arm_3_8.receiveShadow = options.receiveShadow ?? true;
  mesh_arm_3_8.userData.sculptComponent = {"id": "arm-3", "name": "arm-3", "level": "macro", "role": "boom", "importance": 0.9, "confidence": 0.9, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Discrete cylindrical, extruded or tubular mechanical element.", "geometryDescriptor": {"topologyIntent": "closed profiled mechanical solid", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "endpoints": {"start": [0.48, 1.19, -0.83], "end": [1.04, 1.19, -1.84]}}, "parent": "root", "attachment": {"parentSocket": "boom-3", "localStart": [0.48, 1.19, -0.83], "localEnd": [1.04, 1.19, -1.84], "contactType": "socket", "embedDepth": 0.06, "overlap": 0.04, "gapTolerance": 0.01, "baseRadius": 0.0525}, "dimensions": {"width": 0.105, "height": 1.154859298789251, "depth": 0.105, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "motor-mount-3-socket", "name": "motor-mount-3-socket", "localPosition": [1.04, 1.0999999999999999, -1.84], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.13}, {"id": "motor-3-socket", "name": "motor-3-socket", "localPosition": [1.04, 1.2799999999999998, -1.84], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.1175}, {"id": "rotor-3-socket", "name": "rotor-3-socket", "localPosition": [1.04, 1.5190000000000001, -1.84], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.9}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "arm-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "silver", "materialLayers": ["silver"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object", "structural-plan"], "details": ["arm-3 observed in reference"], "fidelityTier": "reference-proportional", "colorMaterialRecipe": {"dominantAlbedo": "rgba(198,206,216,1)", "secondaryAlbedo": "rgba(198,206,216,1)", "materialClass": "metal", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "roughness": 0.26, "metalness": 0.92}};
  node_arm_3_8.add(mesh_arm_3_8);
  meshes["arm-3"] = mesh_arm_3_8;
  colliders["arm-3"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["arm-3"] ??= [];
  destructionGroups["arm-3"].push(node_arm_3_8);
  const socket_arm_3_motor_mount_3_socket_0 = new THREE.Object3D();
  socket_arm_3_motor_mount_3_socket_0.name = "motor-mount-3-socket";
  socket_arm_3_motor_mount_3_socket_0.position.set(1.04, 1.0999999999999999, -1.84);
  socket_arm_3_motor_mount_3_socket_0.rotation.set(0.0, 0.0, 0.0);
  socket_arm_3_motor_mount_3_socket_0.userData.socket = {"id": "motor-mount-3-socket", "name": "motor-mount-3-socket", "localPosition": [1.04, 1.0999999999999999, -1.84], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.13};
  node_arm_3_8.add(socket_arm_3_motor_mount_3_socket_0);
  sockets["arm-3:motor-mount-3-socket"] = socket_arm_3_motor_mount_3_socket_0;
  const socket_arm_3_motor_3_socket_1 = new THREE.Object3D();
  socket_arm_3_motor_3_socket_1.name = "motor-3-socket";
  socket_arm_3_motor_3_socket_1.position.set(1.04, 1.2799999999999998, -1.84);
  socket_arm_3_motor_3_socket_1.rotation.set(0.0, 0.0, 0.0);
  socket_arm_3_motor_3_socket_1.userData.socket = {"id": "motor-3-socket", "name": "motor-3-socket", "localPosition": [1.04, 1.2799999999999998, -1.84], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.1175};
  node_arm_3_8.add(socket_arm_3_motor_3_socket_1);
  sockets["arm-3:motor-3-socket"] = socket_arm_3_motor_3_socket_1;
  const socket_arm_3_rotor_3_socket_2 = new THREE.Object3D();
  socket_arm_3_rotor_3_socket_2.name = "rotor-3-socket";
  socket_arm_3_rotor_3_socket_2.position.set(1.04, 1.5190000000000001, -1.84);
  socket_arm_3_rotor_3_socket_2.rotation.set(0.0, 0.0, 0.0);
  socket_arm_3_rotor_3_socket_2.userData.socket = {"id": "rotor-3-socket", "name": "rotor-3-socket", "localPosition": [1.04, 1.5190000000000001, -1.84], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.9};
  node_arm_3_8.add(socket_arm_3_rotor_3_socket_2);
  sockets["arm-3:rotor-3-socket"] = socket_arm_3_rotor_3_socket_2;

  const endpoint_rotor_3_9 = makeAttachmentEndpoint(null);
  const node_rotor_3_9 = new THREE.Group();
  node_rotor_3_9.name = "rotor-3__pivot";
  node_rotor_3_9.scale.set(1, 1, 1);
  if (endpoint_rotor_3_9) {
    node_rotor_3_9.position.copy(endpoint_rotor_3_9.start);
    node_rotor_3_9.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_rotor_3_9.position.set(1.04, 1.53, -1.84);
    node_rotor_3_9.rotation.set(0.0, 0.0, 0.0);
  }
  node_rotor_3_9.userData.sculptComponent = {"id": "rotor-3", "name": "rotor-3", "level": "macro", "role": "body", "importance": 0.9, "confidence": 0.9, "primitive": "extrude", "topologyClass": "continuous-sculpt", "topologyRationale": "Continuous lofted cross-sections give a variable-width convex surface.", "geometryDescriptor": {"topologyIntent": "closed anisotropic loft", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "bladeProfile": [[0.08, 0], [0.2, 0.02], [0.35, 0.095], [0.8, 0.075], [0.9, 0.045], [0.88, -0.025], [0.36, -0.04], [0.22, -0.02]], "pitchDegrees": 9, "bladeCount": 2}, "parent": "arm-3", "attachment": {"parentId": "arm-3", "parentSocket": "rotor-3-socket", "localStart": [1.04, 1.5190000000000001, -1.84], "localEnd": [1.04, 1.541, -1.84], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "baseRadius": 0.9, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.8, "height": 0.022, "depth": 0.18, "units": "relative", "confidence": 0.85}, "transform": {"position": [1.04, 1.53, -1.84], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "rotor", "pivot": {"mode": "center", "localPosition": [1.04, 1.53, -1.84], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rotor-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "graphite", "materialLayers": ["graphite"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object", "structural-plan"], "details": ["rotor-3 observed in reference"], "fidelityTier": "reference-proportional", "colorMaterialRecipe": {"dominantAlbedo": "rgba(48,54,64,1)", "secondaryAlbedo": "rgba(48,54,64,1)", "materialClass": "plastic", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "roughness": 0.38, "metalness": 0.2}};
  node_rotor_3_9.userData.actionProfile = {"animationRole": "rotor", "pivot": {"mode": "center", "localPosition": [1.04, 1.53, -1.84], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rotor-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["arm-3"] ?? root).add(node_rotor_3_9);
  nodes["rotor-3"] = node_rotor_3_9;
  const mesh_rotor_3_9Geometry = endpoint_rotor_3_9
    ? new THREE.CylinderGeometry(endpoint_rotor_3_9.endRadius, endpoint_rotor_3_9.baseRadius, endpoint_rotor_3_9.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]], "depth": 0.1});
  if (!endpoint_rotor_3_9) {
    mesh_rotor_3_9Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_rotor_3_9 = new THREE.Mesh(
    mesh_rotor_3_9Geometry,
    materialMap["graphite"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rotor_3_9.name = "rotor-3";
  if (endpoint_rotor_3_9) {
    mesh_rotor_3_9.position.copy(endpoint_rotor_3_9.midpoint);
    mesh_rotor_3_9.quaternion.copy(endpoint_rotor_3_9.quaternion);
  }
  mesh_rotor_3_9.castShadow = options.castShadow ?? true;
  mesh_rotor_3_9.receiveShadow = options.receiveShadow ?? true;
  mesh_rotor_3_9.userData.sculptComponent = {"id": "rotor-3", "name": "rotor-3", "level": "macro", "role": "body", "importance": 0.9, "confidence": 0.9, "primitive": "extrude", "topologyClass": "continuous-sculpt", "topologyRationale": "Continuous lofted cross-sections give a variable-width convex surface.", "geometryDescriptor": {"topologyIntent": "closed anisotropic loft", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "bladeProfile": [[0.08, 0], [0.2, 0.02], [0.35, 0.095], [0.8, 0.075], [0.9, 0.045], [0.88, -0.025], [0.36, -0.04], [0.22, -0.02]], "pitchDegrees": 9, "bladeCount": 2}, "parent": "arm-3", "attachment": {"parentId": "arm-3", "parentSocket": "rotor-3-socket", "localStart": [1.04, 1.5190000000000001, -1.84], "localEnd": [1.04, 1.541, -1.84], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "baseRadius": 0.9, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.8, "height": 0.022, "depth": 0.18, "units": "relative", "confidence": 0.85}, "transform": {"position": [1.04, 1.53, -1.84], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "rotor", "pivot": {"mode": "center", "localPosition": [1.04, 1.53, -1.84], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rotor-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "graphite", "materialLayers": ["graphite"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object", "structural-plan"], "details": ["rotor-3 observed in reference"], "fidelityTier": "reference-proportional", "colorMaterialRecipe": {"dominantAlbedo": "rgba(48,54,64,1)", "secondaryAlbedo": "rgba(48,54,64,1)", "materialClass": "plastic", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "roughness": 0.38, "metalness": 0.2}};
  node_rotor_3_9.add(mesh_rotor_3_9);
  meshes["rotor-3"] = mesh_rotor_3_9;
  colliders["rotor-3"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["rotor-3"] ??= [];
  destructionGroups["rotor-3"].push(node_rotor_3_9);

  const attachment_arm_4_10 = {"parentSocket": "boom-4", "localStart": [-0.48, 1.19, -0.83], "localEnd": [-1.04, 1.19, -1.84], "contactType": "socket", "embedDepth": 0.06, "overlap": 0.04, "gapTolerance": 0.01, "baseRadius": 0.0525};
  const endpoint_arm_4_10 = makeAttachmentEndpoint(attachment_arm_4_10);
  const node_arm_4_10 = new THREE.Group();
  node_arm_4_10.name = "arm-4__pivot";
  node_arm_4_10.scale.set(1, 1, 1);
  if (endpoint_arm_4_10) {
    node_arm_4_10.position.copy(endpoint_arm_4_10.start);
    node_arm_4_10.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_arm_4_10.position.set(0.0, 0.0, 0.0);
    node_arm_4_10.rotation.set(0.0, 0.0, 0.0);
  }
  node_arm_4_10.userData.sculptComponent = {"id": "arm-4", "name": "arm-4", "level": "macro", "role": "boom", "importance": 0.9, "confidence": 0.9, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Discrete cylindrical, extruded or tubular mechanical element.", "geometryDescriptor": {"topologyIntent": "closed profiled mechanical solid", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "endpoints": {"start": [-0.48, 1.19, -0.83], "end": [-1.04, 1.19, -1.84]}}, "parent": "root", "attachment": {"parentSocket": "boom-4", "localStart": [-0.48, 1.19, -0.83], "localEnd": [-1.04, 1.19, -1.84], "contactType": "socket", "embedDepth": 0.06, "overlap": 0.04, "gapTolerance": 0.01, "baseRadius": 0.0525}, "dimensions": {"width": 0.105, "height": 1.154859298789251, "depth": 0.105, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "motor-mount-4-socket", "name": "motor-mount-4-socket", "localPosition": [-1.04, 1.0999999999999999, -1.84], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.13}, {"id": "motor-4-socket", "name": "motor-4-socket", "localPosition": [-1.04, 1.2799999999999998, -1.84], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.1175}, {"id": "rotor-4-socket", "name": "rotor-4-socket", "localPosition": [-1.04, 1.5190000000000001, -1.84], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.9}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "arm-4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "silver", "materialLayers": ["silver"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object", "structural-plan"], "details": ["arm-4 observed in reference"], "fidelityTier": "reference-proportional", "colorMaterialRecipe": {"dominantAlbedo": "rgba(198,206,216,1)", "secondaryAlbedo": "rgba(198,206,216,1)", "materialClass": "metal", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "roughness": 0.26, "metalness": 0.92}};
  node_arm_4_10.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "motor-mount-4-socket", "name": "motor-mount-4-socket", "localPosition": [-1.04, 1.0999999999999999, -1.84], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.13}, {"id": "motor-4-socket", "name": "motor-4-socket", "localPosition": [-1.04, 1.2799999999999998, -1.84], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.1175}, {"id": "rotor-4-socket", "name": "rotor-4-socket", "localPosition": [-1.04, 1.5190000000000001, -1.84], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.9}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "arm-4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_arm_4_10);
  nodes["arm-4"] = node_arm_4_10;
  const mesh_arm_4_10Geometry = endpoint_arm_4_10
    ? new THREE.CylinderGeometry(endpoint_arm_4_10.endRadius, endpoint_arm_4_10.baseRadius, endpoint_arm_4_10.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_arm_4_10) {
    mesh_arm_4_10Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_arm_4_10 = new THREE.Mesh(
    mesh_arm_4_10Geometry,
    materialMap["silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_arm_4_10.name = "arm-4";
  if (endpoint_arm_4_10) {
    mesh_arm_4_10.position.copy(endpoint_arm_4_10.midpoint);
    mesh_arm_4_10.quaternion.copy(endpoint_arm_4_10.quaternion);
  }
  mesh_arm_4_10.castShadow = options.castShadow ?? true;
  mesh_arm_4_10.receiveShadow = options.receiveShadow ?? true;
  mesh_arm_4_10.userData.sculptComponent = {"id": "arm-4", "name": "arm-4", "level": "macro", "role": "boom", "importance": 0.9, "confidence": 0.9, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Discrete cylindrical, extruded or tubular mechanical element.", "geometryDescriptor": {"topologyIntent": "closed profiled mechanical solid", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "endpoints": {"start": [-0.48, 1.19, -0.83], "end": [-1.04, 1.19, -1.84]}}, "parent": "root", "attachment": {"parentSocket": "boom-4", "localStart": [-0.48, 1.19, -0.83], "localEnd": [-1.04, 1.19, -1.84], "contactType": "socket", "embedDepth": 0.06, "overlap": 0.04, "gapTolerance": 0.01, "baseRadius": 0.0525}, "dimensions": {"width": 0.105, "height": 1.154859298789251, "depth": 0.105, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "motor-mount-4-socket", "name": "motor-mount-4-socket", "localPosition": [-1.04, 1.0999999999999999, -1.84], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.13}, {"id": "motor-4-socket", "name": "motor-4-socket", "localPosition": [-1.04, 1.2799999999999998, -1.84], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.1175}, {"id": "rotor-4-socket", "name": "rotor-4-socket", "localPosition": [-1.04, 1.5190000000000001, -1.84], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.9}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "arm-4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "silver", "materialLayers": ["silver"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object", "structural-plan"], "details": ["arm-4 observed in reference"], "fidelityTier": "reference-proportional", "colorMaterialRecipe": {"dominantAlbedo": "rgba(198,206,216,1)", "secondaryAlbedo": "rgba(198,206,216,1)", "materialClass": "metal", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "roughness": 0.26, "metalness": 0.92}};
  node_arm_4_10.add(mesh_arm_4_10);
  meshes["arm-4"] = mesh_arm_4_10;
  colliders["arm-4"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["arm-4"] ??= [];
  destructionGroups["arm-4"].push(node_arm_4_10);
  const socket_arm_4_motor_mount_4_socket_0 = new THREE.Object3D();
  socket_arm_4_motor_mount_4_socket_0.name = "motor-mount-4-socket";
  socket_arm_4_motor_mount_4_socket_0.position.set(-1.04, 1.0999999999999999, -1.84);
  socket_arm_4_motor_mount_4_socket_0.rotation.set(0.0, 0.0, 0.0);
  socket_arm_4_motor_mount_4_socket_0.userData.socket = {"id": "motor-mount-4-socket", "name": "motor-mount-4-socket", "localPosition": [-1.04, 1.0999999999999999, -1.84], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.13};
  node_arm_4_10.add(socket_arm_4_motor_mount_4_socket_0);
  sockets["arm-4:motor-mount-4-socket"] = socket_arm_4_motor_mount_4_socket_0;
  const socket_arm_4_motor_4_socket_1 = new THREE.Object3D();
  socket_arm_4_motor_4_socket_1.name = "motor-4-socket";
  socket_arm_4_motor_4_socket_1.position.set(-1.04, 1.2799999999999998, -1.84);
  socket_arm_4_motor_4_socket_1.rotation.set(0.0, 0.0, 0.0);
  socket_arm_4_motor_4_socket_1.userData.socket = {"id": "motor-4-socket", "name": "motor-4-socket", "localPosition": [-1.04, 1.2799999999999998, -1.84], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.1175};
  node_arm_4_10.add(socket_arm_4_motor_4_socket_1);
  sockets["arm-4:motor-4-socket"] = socket_arm_4_motor_4_socket_1;
  const socket_arm_4_rotor_4_socket_2 = new THREE.Object3D();
  socket_arm_4_rotor_4_socket_2.name = "rotor-4-socket";
  socket_arm_4_rotor_4_socket_2.position.set(-1.04, 1.5190000000000001, -1.84);
  socket_arm_4_rotor_4_socket_2.rotation.set(0.0, 0.0, 0.0);
  socket_arm_4_rotor_4_socket_2.userData.socket = {"id": "rotor-4-socket", "name": "rotor-4-socket", "localPosition": [-1.04, 1.5190000000000001, -1.84], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.9};
  node_arm_4_10.add(socket_arm_4_rotor_4_socket_2);
  sockets["arm-4:rotor-4-socket"] = socket_arm_4_rotor_4_socket_2;

  const endpoint_rotor_4_11 = makeAttachmentEndpoint(null);
  const node_rotor_4_11 = new THREE.Group();
  node_rotor_4_11.name = "rotor-4__pivot";
  node_rotor_4_11.scale.set(1, 1, 1);
  if (endpoint_rotor_4_11) {
    node_rotor_4_11.position.copy(endpoint_rotor_4_11.start);
    node_rotor_4_11.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_rotor_4_11.position.set(-1.04, 1.53, -1.84);
    node_rotor_4_11.rotation.set(0.0, 0.0, 0.0);
  }
  node_rotor_4_11.userData.sculptComponent = {"id": "rotor-4", "name": "rotor-4", "level": "macro", "role": "body", "importance": 0.9, "confidence": 0.9, "primitive": "extrude", "topologyClass": "continuous-sculpt", "topologyRationale": "Continuous lofted cross-sections give a variable-width convex surface.", "geometryDescriptor": {"topologyIntent": "closed anisotropic loft", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "bladeProfile": [[0.08, 0], [0.2, 0.02], [0.35, 0.095], [0.8, 0.075], [0.9, 0.045], [0.88, -0.025], [0.36, -0.04], [0.22, -0.02]], "pitchDegrees": 9, "bladeCount": 2}, "parent": "arm-4", "attachment": {"parentId": "arm-4", "parentSocket": "rotor-4-socket", "localStart": [-1.04, 1.5190000000000001, -1.84], "localEnd": [-1.04, 1.541, -1.84], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "baseRadius": 0.9, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.8, "height": 0.022, "depth": 0.18, "units": "relative", "confidence": 0.85}, "transform": {"position": [-1.04, 1.53, -1.84], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "rotor", "pivot": {"mode": "center", "localPosition": [-1.04, 1.53, -1.84], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rotor-4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "graphite", "materialLayers": ["graphite"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object", "structural-plan"], "details": ["rotor-4 observed in reference"], "fidelityTier": "reference-proportional", "colorMaterialRecipe": {"dominantAlbedo": "rgba(48,54,64,1)", "secondaryAlbedo": "rgba(48,54,64,1)", "materialClass": "plastic", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "roughness": 0.38, "metalness": 0.2}};
  node_rotor_4_11.userData.actionProfile = {"animationRole": "rotor", "pivot": {"mode": "center", "localPosition": [-1.04, 1.53, -1.84], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rotor-4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["arm-4"] ?? root).add(node_rotor_4_11);
  nodes["rotor-4"] = node_rotor_4_11;
  const mesh_rotor_4_11Geometry = endpoint_rotor_4_11
    ? new THREE.CylinderGeometry(endpoint_rotor_4_11.endRadius, endpoint_rotor_4_11.baseRadius, endpoint_rotor_4_11.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]], "depth": 0.1});
  if (!endpoint_rotor_4_11) {
    mesh_rotor_4_11Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_rotor_4_11 = new THREE.Mesh(
    mesh_rotor_4_11Geometry,
    materialMap["graphite"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rotor_4_11.name = "rotor-4";
  if (endpoint_rotor_4_11) {
    mesh_rotor_4_11.position.copy(endpoint_rotor_4_11.midpoint);
    mesh_rotor_4_11.quaternion.copy(endpoint_rotor_4_11.quaternion);
  }
  mesh_rotor_4_11.castShadow = options.castShadow ?? true;
  mesh_rotor_4_11.receiveShadow = options.receiveShadow ?? true;
  mesh_rotor_4_11.userData.sculptComponent = {"id": "rotor-4", "name": "rotor-4", "level": "macro", "role": "body", "importance": 0.9, "confidence": 0.9, "primitive": "extrude", "topologyClass": "continuous-sculpt", "topologyRationale": "Continuous lofted cross-sections give a variable-width convex surface.", "geometryDescriptor": {"topologyIntent": "closed anisotropic loft", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "bladeProfile": [[0.08, 0], [0.2, 0.02], [0.35, 0.095], [0.8, 0.075], [0.9, 0.045], [0.88, -0.025], [0.36, -0.04], [0.22, -0.02]], "pitchDegrees": 9, "bladeCount": 2}, "parent": "arm-4", "attachment": {"parentId": "arm-4", "parentSocket": "rotor-4-socket", "localStart": [-1.04, 1.5190000000000001, -1.84], "localEnd": [-1.04, 1.541, -1.84], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "baseRadius": 0.9, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.8, "height": 0.022, "depth": 0.18, "units": "relative", "confidence": 0.85}, "transform": {"position": [-1.04, 1.53, -1.84], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "rotor", "pivot": {"mode": "center", "localPosition": [-1.04, 1.53, -1.84], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rotor-4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "graphite", "materialLayers": ["graphite"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object", "structural-plan"], "details": ["rotor-4 observed in reference"], "fidelityTier": "reference-proportional", "colorMaterialRecipe": {"dominantAlbedo": "rgba(48,54,64,1)", "secondaryAlbedo": "rgba(48,54,64,1)", "materialClass": "plastic", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "roughness": 0.38, "metalness": 0.2}};
  node_rotor_4_11.add(mesh_rotor_4_11);
  meshes["rotor-4"] = mesh_rotor_4_11;
  colliders["rotor-4"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["rotor-4"] ??= [];
  destructionGroups["rotor-4"].push(node_rotor_4_11);

  const attachment_arm_5_12 = {"parentSocket": "boom-5", "localStart": [-0.62, 1.19, 0], "localEnd": [-2.11, 1.19, 0], "contactType": "socket", "embedDepth": 0.06, "overlap": 0.04, "gapTolerance": 0.01, "baseRadius": 0.0525};
  const endpoint_arm_5_12 = makeAttachmentEndpoint(attachment_arm_5_12);
  const node_arm_5_12 = new THREE.Group();
  node_arm_5_12.name = "arm-5__pivot";
  node_arm_5_12.scale.set(1, 1, 1);
  if (endpoint_arm_5_12) {
    node_arm_5_12.position.copy(endpoint_arm_5_12.start);
    node_arm_5_12.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_arm_5_12.position.set(0.0, 0.0, 0.0);
    node_arm_5_12.rotation.set(0.0, 0.0, 0.0);
  }
  node_arm_5_12.userData.sculptComponent = {"id": "arm-5", "name": "arm-5", "level": "macro", "role": "boom", "importance": 0.9, "confidence": 0.9, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Discrete cylindrical, extruded or tubular mechanical element.", "geometryDescriptor": {"topologyIntent": "closed profiled mechanical solid", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "endpoints": {"start": [-0.62, 1.19, 0], "end": [-2.11, 1.19, 0]}}, "parent": "root", "attachment": {"parentSocket": "boom-5", "localStart": [-0.62, 1.19, 0], "localEnd": [-2.11, 1.19, 0], "contactType": "socket", "embedDepth": 0.06, "overlap": 0.04, "gapTolerance": 0.01, "baseRadius": 0.0525}, "dimensions": {"width": 0.105, "height": 1.4899999999999998, "depth": 0.105, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "motor-mount-5-socket", "name": "motor-mount-5-socket", "localPosition": [-2.11, 1.0999999999999999, 0], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.13}, {"id": "motor-5-socket", "name": "motor-5-socket", "localPosition": [-2.11, 1.2799999999999998, 0], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.1175}, {"id": "rotor-5-socket", "name": "rotor-5-socket", "localPosition": [-2.11, 1.5190000000000001, 0], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.9}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "arm-5", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "silver", "materialLayers": ["silver"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object", "structural-plan"], "details": ["arm-5 observed in reference"], "fidelityTier": "reference-proportional", "colorMaterialRecipe": {"dominantAlbedo": "rgba(198,206,216,1)", "secondaryAlbedo": "rgba(198,206,216,1)", "materialClass": "metal", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "roughness": 0.26, "metalness": 0.92}};
  node_arm_5_12.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "motor-mount-5-socket", "name": "motor-mount-5-socket", "localPosition": [-2.11, 1.0999999999999999, 0], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.13}, {"id": "motor-5-socket", "name": "motor-5-socket", "localPosition": [-2.11, 1.2799999999999998, 0], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.1175}, {"id": "rotor-5-socket", "name": "rotor-5-socket", "localPosition": [-2.11, 1.5190000000000001, 0], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.9}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "arm-5", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_arm_5_12);
  nodes["arm-5"] = node_arm_5_12;
  const mesh_arm_5_12Geometry = endpoint_arm_5_12
    ? new THREE.CylinderGeometry(endpoint_arm_5_12.endRadius, endpoint_arm_5_12.baseRadius, endpoint_arm_5_12.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_arm_5_12) {
    mesh_arm_5_12Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_arm_5_12 = new THREE.Mesh(
    mesh_arm_5_12Geometry,
    materialMap["silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_arm_5_12.name = "arm-5";
  if (endpoint_arm_5_12) {
    mesh_arm_5_12.position.copy(endpoint_arm_5_12.midpoint);
    mesh_arm_5_12.quaternion.copy(endpoint_arm_5_12.quaternion);
  }
  mesh_arm_5_12.castShadow = options.castShadow ?? true;
  mesh_arm_5_12.receiveShadow = options.receiveShadow ?? true;
  mesh_arm_5_12.userData.sculptComponent = {"id": "arm-5", "name": "arm-5", "level": "macro", "role": "boom", "importance": 0.9, "confidence": 0.9, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Discrete cylindrical, extruded or tubular mechanical element.", "geometryDescriptor": {"topologyIntent": "closed profiled mechanical solid", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "endpoints": {"start": [-0.62, 1.19, 0], "end": [-2.11, 1.19, 0]}}, "parent": "root", "attachment": {"parentSocket": "boom-5", "localStart": [-0.62, 1.19, 0], "localEnd": [-2.11, 1.19, 0], "contactType": "socket", "embedDepth": 0.06, "overlap": 0.04, "gapTolerance": 0.01, "baseRadius": 0.0525}, "dimensions": {"width": 0.105, "height": 1.4899999999999998, "depth": 0.105, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "motor-mount-5-socket", "name": "motor-mount-5-socket", "localPosition": [-2.11, 1.0999999999999999, 0], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.13}, {"id": "motor-5-socket", "name": "motor-5-socket", "localPosition": [-2.11, 1.2799999999999998, 0], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.1175}, {"id": "rotor-5-socket", "name": "rotor-5-socket", "localPosition": [-2.11, 1.5190000000000001, 0], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.9}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "arm-5", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "silver", "materialLayers": ["silver"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object", "structural-plan"], "details": ["arm-5 observed in reference"], "fidelityTier": "reference-proportional", "colorMaterialRecipe": {"dominantAlbedo": "rgba(198,206,216,1)", "secondaryAlbedo": "rgba(198,206,216,1)", "materialClass": "metal", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "roughness": 0.26, "metalness": 0.92}};
  node_arm_5_12.add(mesh_arm_5_12);
  meshes["arm-5"] = mesh_arm_5_12;
  colliders["arm-5"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["arm-5"] ??= [];
  destructionGroups["arm-5"].push(node_arm_5_12);
  const socket_arm_5_motor_mount_5_socket_0 = new THREE.Object3D();
  socket_arm_5_motor_mount_5_socket_0.name = "motor-mount-5-socket";
  socket_arm_5_motor_mount_5_socket_0.position.set(-2.11, 1.0999999999999999, 0.0);
  socket_arm_5_motor_mount_5_socket_0.rotation.set(0.0, 0.0, 0.0);
  socket_arm_5_motor_mount_5_socket_0.userData.socket = {"id": "motor-mount-5-socket", "name": "motor-mount-5-socket", "localPosition": [-2.11, 1.0999999999999999, 0], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.13};
  node_arm_5_12.add(socket_arm_5_motor_mount_5_socket_0);
  sockets["arm-5:motor-mount-5-socket"] = socket_arm_5_motor_mount_5_socket_0;
  const socket_arm_5_motor_5_socket_1 = new THREE.Object3D();
  socket_arm_5_motor_5_socket_1.name = "motor-5-socket";
  socket_arm_5_motor_5_socket_1.position.set(-2.11, 1.2799999999999998, 0.0);
  socket_arm_5_motor_5_socket_1.rotation.set(0.0, 0.0, 0.0);
  socket_arm_5_motor_5_socket_1.userData.socket = {"id": "motor-5-socket", "name": "motor-5-socket", "localPosition": [-2.11, 1.2799999999999998, 0], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.1175};
  node_arm_5_12.add(socket_arm_5_motor_5_socket_1);
  sockets["arm-5:motor-5-socket"] = socket_arm_5_motor_5_socket_1;
  const socket_arm_5_rotor_5_socket_2 = new THREE.Object3D();
  socket_arm_5_rotor_5_socket_2.name = "rotor-5-socket";
  socket_arm_5_rotor_5_socket_2.position.set(-2.11, 1.5190000000000001, 0.0);
  socket_arm_5_rotor_5_socket_2.rotation.set(0.0, 0.0, 0.0);
  socket_arm_5_rotor_5_socket_2.userData.socket = {"id": "rotor-5-socket", "name": "rotor-5-socket", "localPosition": [-2.11, 1.5190000000000001, 0], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.9};
  node_arm_5_12.add(socket_arm_5_rotor_5_socket_2);
  sockets["arm-5:rotor-5-socket"] = socket_arm_5_rotor_5_socket_2;

  const endpoint_rotor_5_13 = makeAttachmentEndpoint(null);
  const node_rotor_5_13 = new THREE.Group();
  node_rotor_5_13.name = "rotor-5__pivot";
  node_rotor_5_13.scale.set(1, 1, 1);
  if (endpoint_rotor_5_13) {
    node_rotor_5_13.position.copy(endpoint_rotor_5_13.start);
    node_rotor_5_13.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_rotor_5_13.position.set(-2.11, 1.53, 0.0);
    node_rotor_5_13.rotation.set(0.0, 0.0, 0.0);
  }
  node_rotor_5_13.userData.sculptComponent = {"id": "rotor-5", "name": "rotor-5", "level": "macro", "role": "body", "importance": 0.9, "confidence": 0.9, "primitive": "extrude", "topologyClass": "continuous-sculpt", "topologyRationale": "Continuous lofted cross-sections give a variable-width convex surface.", "geometryDescriptor": {"topologyIntent": "closed anisotropic loft", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "bladeProfile": [[0.08, 0], [0.2, 0.02], [0.35, 0.095], [0.8, 0.075], [0.9, 0.045], [0.88, -0.025], [0.36, -0.04], [0.22, -0.02]], "pitchDegrees": 9, "bladeCount": 2}, "parent": "arm-5", "attachment": {"parentId": "arm-5", "parentSocket": "rotor-5-socket", "localStart": [-2.11, 1.5190000000000001, 0], "localEnd": [-2.11, 1.541, 0], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "baseRadius": 0.9, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.8, "height": 0.022, "depth": 0.18, "units": "relative", "confidence": 0.85}, "transform": {"position": [-2.11, 1.53, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "rotor", "pivot": {"mode": "center", "localPosition": [-2.11, 1.53, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rotor-5", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "graphite", "materialLayers": ["graphite"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object", "structural-plan"], "details": ["rotor-5 observed in reference"], "fidelityTier": "reference-proportional", "colorMaterialRecipe": {"dominantAlbedo": "rgba(48,54,64,1)", "secondaryAlbedo": "rgba(48,54,64,1)", "materialClass": "plastic", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "roughness": 0.38, "metalness": 0.2}};
  node_rotor_5_13.userData.actionProfile = {"animationRole": "rotor", "pivot": {"mode": "center", "localPosition": [-2.11, 1.53, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rotor-5", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["arm-5"] ?? root).add(node_rotor_5_13);
  nodes["rotor-5"] = node_rotor_5_13;
  const mesh_rotor_5_13Geometry = endpoint_rotor_5_13
    ? new THREE.CylinderGeometry(endpoint_rotor_5_13.endRadius, endpoint_rotor_5_13.baseRadius, endpoint_rotor_5_13.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]], "depth": 0.1});
  if (!endpoint_rotor_5_13) {
    mesh_rotor_5_13Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_rotor_5_13 = new THREE.Mesh(
    mesh_rotor_5_13Geometry,
    materialMap["graphite"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rotor_5_13.name = "rotor-5";
  if (endpoint_rotor_5_13) {
    mesh_rotor_5_13.position.copy(endpoint_rotor_5_13.midpoint);
    mesh_rotor_5_13.quaternion.copy(endpoint_rotor_5_13.quaternion);
  }
  mesh_rotor_5_13.castShadow = options.castShadow ?? true;
  mesh_rotor_5_13.receiveShadow = options.receiveShadow ?? true;
  mesh_rotor_5_13.userData.sculptComponent = {"id": "rotor-5", "name": "rotor-5", "level": "macro", "role": "body", "importance": 0.9, "confidence": 0.9, "primitive": "extrude", "topologyClass": "continuous-sculpt", "topologyRationale": "Continuous lofted cross-sections give a variable-width convex surface.", "geometryDescriptor": {"topologyIntent": "closed anisotropic loft", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "bladeProfile": [[0.08, 0], [0.2, 0.02], [0.35, 0.095], [0.8, 0.075], [0.9, 0.045], [0.88, -0.025], [0.36, -0.04], [0.22, -0.02]], "pitchDegrees": 9, "bladeCount": 2}, "parent": "arm-5", "attachment": {"parentId": "arm-5", "parentSocket": "rotor-5-socket", "localStart": [-2.11, 1.5190000000000001, 0], "localEnd": [-2.11, 1.541, 0], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "baseRadius": 0.9, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.8, "height": 0.022, "depth": 0.18, "units": "relative", "confidence": 0.85}, "transform": {"position": [-2.11, 1.53, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "rotor", "pivot": {"mode": "center", "localPosition": [-2.11, 1.53, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rotor-5", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "graphite", "materialLayers": ["graphite"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object", "structural-plan"], "details": ["rotor-5 observed in reference"], "fidelityTier": "reference-proportional", "colorMaterialRecipe": {"dominantAlbedo": "rgba(48,54,64,1)", "secondaryAlbedo": "rgba(48,54,64,1)", "materialClass": "plastic", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "roughness": 0.38, "metalness": 0.2}};
  node_rotor_5_13.add(mesh_rotor_5_13);
  meshes["rotor-5"] = mesh_rotor_5_13;
  colliders["rotor-5"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["rotor-5"] ??= [];
  destructionGroups["rotor-5"].push(node_rotor_5_13);

  const attachment_arm_6_14 = {"parentSocket": "boom-6", "localStart": [-0.48, 1.19, 0.83], "localEnd": [-1.04, 1.19, 1.84], "contactType": "socket", "embedDepth": 0.06, "overlap": 0.04, "gapTolerance": 0.01, "baseRadius": 0.0525};
  const endpoint_arm_6_14 = makeAttachmentEndpoint(attachment_arm_6_14);
  const node_arm_6_14 = new THREE.Group();
  node_arm_6_14.name = "arm-6__pivot";
  node_arm_6_14.scale.set(1, 1, 1);
  if (endpoint_arm_6_14) {
    node_arm_6_14.position.copy(endpoint_arm_6_14.start);
    node_arm_6_14.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_arm_6_14.position.set(0.0, 0.0, 0.0);
    node_arm_6_14.rotation.set(0.0, 0.0, 0.0);
  }
  node_arm_6_14.userData.sculptComponent = {"id": "arm-6", "name": "arm-6", "level": "macro", "role": "boom", "importance": 0.9, "confidence": 0.9, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Discrete cylindrical, extruded or tubular mechanical element.", "geometryDescriptor": {"topologyIntent": "closed profiled mechanical solid", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "endpoints": {"start": [-0.48, 1.19, 0.83], "end": [-1.04, 1.19, 1.84]}}, "parent": "root", "attachment": {"parentSocket": "boom-6", "localStart": [-0.48, 1.19, 0.83], "localEnd": [-1.04, 1.19, 1.84], "contactType": "socket", "embedDepth": 0.06, "overlap": 0.04, "gapTolerance": 0.01, "baseRadius": 0.0525}, "dimensions": {"width": 0.105, "height": 1.154859298789251, "depth": 0.105, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "motor-mount-6-socket", "name": "motor-mount-6-socket", "localPosition": [-1.04, 1.0999999999999999, 1.84], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.13}, {"id": "motor-6-socket", "name": "motor-6-socket", "localPosition": [-1.04, 1.2799999999999998, 1.84], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.1175}, {"id": "rotor-6-socket", "name": "rotor-6-socket", "localPosition": [-1.04, 1.5190000000000001, 1.84], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.9}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "arm-6", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "silver", "materialLayers": ["silver"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object", "structural-plan"], "details": ["arm-6 observed in reference"], "fidelityTier": "reference-proportional", "colorMaterialRecipe": {"dominantAlbedo": "rgba(198,206,216,1)", "secondaryAlbedo": "rgba(198,206,216,1)", "materialClass": "metal", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "roughness": 0.26, "metalness": 0.92}};
  node_arm_6_14.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "motor-mount-6-socket", "name": "motor-mount-6-socket", "localPosition": [-1.04, 1.0999999999999999, 1.84], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.13}, {"id": "motor-6-socket", "name": "motor-6-socket", "localPosition": [-1.04, 1.2799999999999998, 1.84], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.1175}, {"id": "rotor-6-socket", "name": "rotor-6-socket", "localPosition": [-1.04, 1.5190000000000001, 1.84], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.9}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "arm-6", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_arm_6_14);
  nodes["arm-6"] = node_arm_6_14;
  const mesh_arm_6_14Geometry = endpoint_arm_6_14
    ? new THREE.CylinderGeometry(endpoint_arm_6_14.endRadius, endpoint_arm_6_14.baseRadius, endpoint_arm_6_14.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_arm_6_14) {
    mesh_arm_6_14Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_arm_6_14 = new THREE.Mesh(
    mesh_arm_6_14Geometry,
    materialMap["silver"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_arm_6_14.name = "arm-6";
  if (endpoint_arm_6_14) {
    mesh_arm_6_14.position.copy(endpoint_arm_6_14.midpoint);
    mesh_arm_6_14.quaternion.copy(endpoint_arm_6_14.quaternion);
  }
  mesh_arm_6_14.castShadow = options.castShadow ?? true;
  mesh_arm_6_14.receiveShadow = options.receiveShadow ?? true;
  mesh_arm_6_14.userData.sculptComponent = {"id": "arm-6", "name": "arm-6", "level": "macro", "role": "boom", "importance": 0.9, "confidence": 0.9, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Discrete cylindrical, extruded or tubular mechanical element.", "geometryDescriptor": {"topologyIntent": "closed profiled mechanical solid", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "endpoints": {"start": [-0.48, 1.19, 0.83], "end": [-1.04, 1.19, 1.84]}}, "parent": "root", "attachment": {"parentSocket": "boom-6", "localStart": [-0.48, 1.19, 0.83], "localEnd": [-1.04, 1.19, 1.84], "contactType": "socket", "embedDepth": 0.06, "overlap": 0.04, "gapTolerance": 0.01, "baseRadius": 0.0525}, "dimensions": {"width": 0.105, "height": 1.154859298789251, "depth": 0.105, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "motor-mount-6-socket", "name": "motor-mount-6-socket", "localPosition": [-1.04, 1.0999999999999999, 1.84], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.13}, {"id": "motor-6-socket", "name": "motor-6-socket", "localPosition": [-1.04, 1.2799999999999998, 1.84], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.1175}, {"id": "rotor-6-socket", "name": "rotor-6-socket", "localPosition": [-1.04, 1.5190000000000001, 1.84], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.9}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "arm-6", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "silver", "materialLayers": ["silver"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object", "structural-plan"], "details": ["arm-6 observed in reference"], "fidelityTier": "reference-proportional", "colorMaterialRecipe": {"dominantAlbedo": "rgba(198,206,216,1)", "secondaryAlbedo": "rgba(198,206,216,1)", "materialClass": "metal", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "roughness": 0.26, "metalness": 0.92}};
  node_arm_6_14.add(mesh_arm_6_14);
  meshes["arm-6"] = mesh_arm_6_14;
  colliders["arm-6"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["arm-6"] ??= [];
  destructionGroups["arm-6"].push(node_arm_6_14);
  const socket_arm_6_motor_mount_6_socket_0 = new THREE.Object3D();
  socket_arm_6_motor_mount_6_socket_0.name = "motor-mount-6-socket";
  socket_arm_6_motor_mount_6_socket_0.position.set(-1.04, 1.0999999999999999, 1.84);
  socket_arm_6_motor_mount_6_socket_0.rotation.set(0.0, 0.0, 0.0);
  socket_arm_6_motor_mount_6_socket_0.userData.socket = {"id": "motor-mount-6-socket", "name": "motor-mount-6-socket", "localPosition": [-1.04, 1.0999999999999999, 1.84], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.13};
  node_arm_6_14.add(socket_arm_6_motor_mount_6_socket_0);
  sockets["arm-6:motor-mount-6-socket"] = socket_arm_6_motor_mount_6_socket_0;
  const socket_arm_6_motor_6_socket_1 = new THREE.Object3D();
  socket_arm_6_motor_6_socket_1.name = "motor-6-socket";
  socket_arm_6_motor_6_socket_1.position.set(-1.04, 1.2799999999999998, 1.84);
  socket_arm_6_motor_6_socket_1.rotation.set(0.0, 0.0, 0.0);
  socket_arm_6_motor_6_socket_1.userData.socket = {"id": "motor-6-socket", "name": "motor-6-socket", "localPosition": [-1.04, 1.2799999999999998, 1.84], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.1175};
  node_arm_6_14.add(socket_arm_6_motor_6_socket_1);
  sockets["arm-6:motor-6-socket"] = socket_arm_6_motor_6_socket_1;
  const socket_arm_6_rotor_6_socket_2 = new THREE.Object3D();
  socket_arm_6_rotor_6_socket_2.name = "rotor-6-socket";
  socket_arm_6_rotor_6_socket_2.position.set(-1.04, 1.5190000000000001, 1.84);
  socket_arm_6_rotor_6_socket_2.rotation.set(0.0, 0.0, 0.0);
  socket_arm_6_rotor_6_socket_2.userData.socket = {"id": "rotor-6-socket", "name": "rotor-6-socket", "localPosition": [-1.04, 1.5190000000000001, 1.84], "localRotation": [0, 0, 0], "direction": [0, 1, 0], "radius": 0.9};
  node_arm_6_14.add(socket_arm_6_rotor_6_socket_2);
  sockets["arm-6:rotor-6-socket"] = socket_arm_6_rotor_6_socket_2;

  const endpoint_rotor_6_15 = makeAttachmentEndpoint(null);
  const node_rotor_6_15 = new THREE.Group();
  node_rotor_6_15.name = "rotor-6__pivot";
  node_rotor_6_15.scale.set(1, 1, 1);
  if (endpoint_rotor_6_15) {
    node_rotor_6_15.position.copy(endpoint_rotor_6_15.start);
    node_rotor_6_15.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_rotor_6_15.position.set(-1.04, 1.53, 1.84);
    node_rotor_6_15.rotation.set(0.0, 0.0, 0.0);
  }
  node_rotor_6_15.userData.sculptComponent = {"id": "rotor-6", "name": "rotor-6", "level": "macro", "role": "body", "importance": 0.9, "confidence": 0.9, "primitive": "extrude", "topologyClass": "continuous-sculpt", "topologyRationale": "Continuous lofted cross-sections give a variable-width convex surface.", "geometryDescriptor": {"topologyIntent": "closed anisotropic loft", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "bladeProfile": [[0.08, 0], [0.2, 0.02], [0.35, 0.095], [0.8, 0.075], [0.9, 0.045], [0.88, -0.025], [0.36, -0.04], [0.22, -0.02]], "pitchDegrees": 9, "bladeCount": 2}, "parent": "arm-6", "attachment": {"parentId": "arm-6", "parentSocket": "rotor-6-socket", "localStart": [-1.04, 1.5190000000000001, 1.84], "localEnd": [-1.04, 1.541, 1.84], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "baseRadius": 0.9, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.8, "height": 0.022, "depth": 0.18, "units": "relative", "confidence": 0.85}, "transform": {"position": [-1.04, 1.53, 1.84], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "rotor", "pivot": {"mode": "center", "localPosition": [-1.04, 1.53, 1.84], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rotor-6", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "graphite", "materialLayers": ["graphite"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object", "structural-plan"], "details": ["rotor-6 observed in reference"], "fidelityTier": "reference-proportional", "colorMaterialRecipe": {"dominantAlbedo": "rgba(48,54,64,1)", "secondaryAlbedo": "rgba(48,54,64,1)", "materialClass": "plastic", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "roughness": 0.38, "metalness": 0.2}};
  node_rotor_6_15.userData.actionProfile = {"animationRole": "rotor", "pivot": {"mode": "center", "localPosition": [-1.04, 1.53, 1.84], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rotor-6", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}};
  (nodes["arm-6"] ?? root).add(node_rotor_6_15);
  nodes["rotor-6"] = node_rotor_6_15;
  const mesh_rotor_6_15Geometry = endpoint_rotor_6_15
    ? new THREE.CylinderGeometry(endpoint_rotor_6_15.endRadius, endpoint_rotor_6_15.baseRadius, endpoint_rotor_6_15.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]], "depth": 0.1});
  if (!endpoint_rotor_6_15) {
    mesh_rotor_6_15Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_rotor_6_15 = new THREE.Mesh(
    mesh_rotor_6_15Geometry,
    materialMap["graphite"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rotor_6_15.name = "rotor-6";
  if (endpoint_rotor_6_15) {
    mesh_rotor_6_15.position.copy(endpoint_rotor_6_15.midpoint);
    mesh_rotor_6_15.quaternion.copy(endpoint_rotor_6_15.quaternion);
  }
  mesh_rotor_6_15.castShadow = options.castShadow ?? true;
  mesh_rotor_6_15.receiveShadow = options.receiveShadow ?? true;
  mesh_rotor_6_15.userData.sculptComponent = {"id": "rotor-6", "name": "rotor-6", "level": "macro", "role": "body", "importance": 0.9, "confidence": 0.9, "primitive": "extrude", "topologyClass": "continuous-sculpt", "topologyRationale": "Continuous lofted cross-sections give a variable-width convex surface.", "geometryDescriptor": {"topologyIntent": "closed anisotropic loft", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "bladeProfile": [[0.08, 0], [0.2, 0.02], [0.35, 0.095], [0.8, 0.075], [0.9, 0.045], [0.88, -0.025], [0.36, -0.04], [0.22, -0.02]], "pitchDegrees": 9, "bladeCount": 2}, "parent": "arm-6", "attachment": {"parentId": "arm-6", "parentSocket": "rotor-6-socket", "localStart": [-1.04, 1.5190000000000001, 1.84], "localEnd": [-1.04, 1.541, 1.84], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "baseRadius": 0.9, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.8, "height": 0.022, "depth": 0.18, "units": "relative", "confidence": 0.85}, "transform": {"position": [-1.04, 1.53, 1.84], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "rotor", "pivot": {"mode": "center", "localPosition": [-1.04, 1.53, 1.84], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rotor-6", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, "material": "graphite", "materialLayers": ["graphite"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object", "structural-plan"], "details": ["rotor-6 observed in reference"], "fidelityTier": "reference-proportional", "colorMaterialRecipe": {"dominantAlbedo": "rgba(48,54,64,1)", "secondaryAlbedo": "rgba(48,54,64,1)", "materialClass": "plastic", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"], "roughness": 0.38, "metalness": 0.2}};
  node_rotor_6_15.add(mesh_rotor_6_15);
  meshes["rotor-6"] = mesh_rotor_6_15;
  colliders["rotor-6"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["rotor-6"] ??= [];
  destructionGroups["rotor-6"].push(node_rotor_6_15);

  root.userData.sculptRuntime = { nodes, meshes, sockets, colliders, destructionGroups } satisfies ProceduralModelRuntime;
  root.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  root.userData.actionReadiness = {
    note: 'Use root.userData.sculptRuntime.nodes for transforms, sockets for attachments, colliders for physics proxies, and destructionGroups for breakable sets.',
  };
  return root;
}

export function createSixAxisHexacopterLookDevLights(
  mode: 'neutral' | 'grazing' | 'reference' = 'neutral',
): THREE.Group {
  const lights = new THREE.Group();
  lights.name = "Six-axis Hexacopter look-dev lights";
  const hemi = new THREE.HemisphereLight(
    mode === 'reference' ? 0xfff0d6 : 0xf2f4ff,
    0x363b42,
    mode === 'grazing' ? 0.28 : mode === 'reference' ? 0.72 : 0.85,
  );
  lights.add(hemi);
  const key = new THREE.DirectionalLight(
    mode === 'reference' ? 0xffcf8a : 0xfff4e8,
    mode === 'grazing' ? 4.2 : mode === 'reference' ? 2.6 : 2.15,
  );
  if (mode === 'grazing') key.position.set(7.5, 1.1, 4.0);
  else if (mode === 'reference') key.position.set(-4.5, 7.5, 5.0);
  else key.position.set(-4.0, 6.0, 5.5);
  key.castShadow = true;
  key.shadow.mapSize.set(4096, 4096);
  key.shadow.bias = -0.00025;
  key.shadow.normalBias = 0.018;
  key.shadow.radius = 7;
  key.shadow.blurSamples = 24;
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 30;
  key.shadow.camera.left = -2.6;
  key.shadow.camera.right = 2.6;
  key.shadow.camera.top = 2.6;
  key.shadow.camera.bottom = -2.6;
  key.shadow.camera.updateProjectionMatrix();
  lights.add(key);
  const fill = new THREE.DirectionalLight(0xa8c4ff, mode === 'grazing' ? 0.12 : 0.42);
  fill.position.set(4.0, 3.0, 3.5);
  lights.add(fill);
  const rim = new THREE.DirectionalLight(0xfff1c4, mode === 'grazing' ? 0.28 : 0.85);
  rim.position.set(0.5, 4.5, -6.0);
  lights.add(rim);
  lights.userData.reviewMode = mode;
  lights.userData.lightingFromPhoto = [{"type": "key", "position": [-3, 6, 4], "color": "#fff6ed", "intensity": 4, "shadowSoftness": 0.4}, {"type": "fill", "position": [4, 3, -2], "color": "#dbe7ff", "intensity": 2}, {"type": "environment", "source": "procedural studio area panels", "exposure": 1.1, "toneMapping": "ACESFilmic", "background": "#e7edf2", "contactShadow": true, "shadowBehavior": "soft ground shadow and local contact shadow"}];
  lights.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  return lights;
}

// PBR materials (clearcoat/iridescence/transmission/anisotropy) need an environment
// map to visually behave as intended — call this once per renderer and assign the
// result to scene.environment before rendering. No external HDR asset required.
export function createSixAxisHexacopterEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const texture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  return texture;
}

// Plan 1.3 §3.2 — auto-framing by bounding box. The Divine Eye can only compare a
// render to the reference if the object is FRAMED consistently (an object framed
// differently scores as wrong even when its shape is right). This positions the camera
// deterministically from the object's bounding box so it fills the frame at a stable
// margin, and sets near/far to the object scale. Call after adding the model to the
// scene, and again on resize (after updating camera.aspect).
export function frameSixAxisHexacopterCamera(
  camera: THREE.PerspectiveCamera,
  object: THREE.Object3D,
  options: { margin?: number; azimuthDeg?: number; elevationDeg?: number } = {},
): void {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const margin = options.margin ?? 1.15;
  const maxDim = Math.max(size.x, size.y, size.z) * margin;
  const fov = (camera.fov * Math.PI) / 180;
  // distance so the largest object dimension fits vertically in the frame
  const distance = (maxDim / 2) / Math.tan(fov / 2);
  const az = ((options.azimuthDeg ?? 0) * Math.PI) / 180;
  const el = ((options.elevationDeg ?? 0) * Math.PI) / 180;
  const dir = new THREE.Vector3(
    Math.sin(az) * Math.cos(el),
    Math.sin(el),
    Math.cos(az) * Math.cos(el),
  );
  camera.position.copy(center).addScaledVector(dir, distance);
  camera.near = Math.max(0.01, distance - maxDim);
  camera.far = distance + maxDim * 2;
  camera.lookAt(center);
  camera.updateProjectionMatrix();
}

// Plan 1.3 §3.2c — PRESENTATION composer (DOF + bloom). CRITICAL (R-POSTFX): this is
// for the showcase/hero render ONLY. The Divine Eye's EVALUATION render MUST use a
// plain renderer with NO composer — bloom blows highlights and DOF blurs edges, which
// would corrupt the deterministic IoU/DCD/edge/blowout signals. Enable dof/bloom ONLY
// when the reference photo actually exhibits them (detect_reference_effects.py authorizes).
export function createSixAxisHexacopterPresentationComposer(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  options: { dof?: boolean; bloom?: boolean; bloomStrength?: number; dofFocus?: number; dofAperture?: number } = {},
): EffectComposer {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  if (options.dof) {
    composer.addPass(new BokehPass(scene, camera, {
      focus: options.dofFocus ?? 10.0,
      aperture: options.dofAperture ?? 0.0002,
      maxblur: 0.01,
    }));
  }
  if (options.bloom) {
    const size = new THREE.Vector2();
    renderer.getSize(size);
    composer.addPass(new UnrealBloomPass(size, options.bloomStrength ?? 0.4, 0.4, 0.85));
  }
  return composer;
}

export function configureSixAxisHexacopterRenderer(renderer: THREE.WebGLRenderer): void {
  // Load-bearing for view-dependent finishes (anodized / Doppler): without ACES + sRGB
  // the environment reflection reads flat/washed instead of a believable metal response.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
}

export function createSixAxisHexacopterInspectControls(
  camera: THREE.Camera,
  domElement: HTMLElement,
): OrbitControls {
  // View-dependent finishes only read correctly once the user orbits — their color
  // comes from the environment reflection, not albedo, so free rotation matters here.
  const controls = new OrbitControls(camera, domElement);
  controls.enableDamping = true;
  controls.minDistance = 1.0;
  controls.maxDistance = 8.0;
  controls.autoRotate = false;
  return controls;
}
