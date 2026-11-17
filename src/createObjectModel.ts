import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import spec from '../object-sculpt-spec.json';

export type PayloadId = 'none' | 'ring' | 'speaker' | 'camera';
export type ModelPart = { id: string; title: string; description: string; group: THREE.Group; anchor: THREE.Vector3; explode: THREE.Vector3 };
export type PayloadRig = { ringAssembly: THREE.Group; ringFloat: THREE.Group; cameraHead: THREE.Group; speakerHead: THREE.Group; releaseLever: THREE.Group; speakerDirection: THREE.Vector3 };
export type DroneModel = { root: THREE.Group; parts: ModelPart[]; rotors: THREE.Group[]; materials: THREE.MeshPhysicalMaterial[]; payloadRig: PayloadRig; setExplode: (amount: number) => void; setWireframe: (enabled: boolean) => void; setCabinOpen: (enabled: boolean) => void; setInteriorVisible: (visible: boolean) => void; setPayload: (id: PayloadId) => void; getPayload: () => PayloadId };
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

export function createSixAxisHexacopterModel(): DroneModel {
  const root = new THREE.Group();
  root.name = 'root';
  const parts: ModelPart[] = [];
  const rotors: THREE.Group[] = [];
  const materials: THREE.MeshPhysicalMaterial[] = [];
  const material = (parameters: THREE.MeshPhysicalMaterialParameters) => {
    const result = new THREE.MeshPhysicalMaterial(parameters);
    materials.push(result); return result;
  };
  const white = material({ color: '#e8edf2', roughness: .29, metalness: .02, clearcoat: .38, clearcoatRoughness: .24 });
  const blue = material({ color: '#163956', roughness: .3, metalness: .42, clearcoat: .3 });
  const silver = material({ color: '#c2cbd6', roughness: .25, metalness: .94 });
  const graphite = material({ color: '#282d38', roughness: .37, metalness: .32, clearcoat: .25 });
  const black = material({ color: '#09111c', roughness: .32, metalness: .45 });
  const rubber = material({ color: '#151b24', roughness: .78, metalness: 0 });
  const seam = material({ color: '#6f7984', roughness: .5, metalness: .35 });
  const glass = material({ color: '#07131f', roughness: .13, metalness: .2, clearcoat: 1 });
  const carbon = material({ color: '#1b222b', roughness: .74, metalness: .16 });
  const pcb = material({ color: '#123b4d', roughness: .62, metalness: .2, clearcoat: .18 });
  const chip = material({ color: '#0b1017', roughness: .55, metalness: .3 });
  const gold = material({ color: '#c7a35c', roughness: .3, metalness: .9 });
  const cell = material({ color: '#2b323d', roughness: .68, metalness: .12 });
  const power = material({ color: '#8f332c', roughness: .5, metalness: .05 });
  const neutral = material({ color: '#1d232b', roughness: .78, metalness: .04 });
  const led = material({ color: '#5fd0ef', emissive: '#46c8ee', emissiveIntensity: 2.2, roughness: .3, metalness: .1 });
  const liner = material({ color: '#1a2028', roughness: .82, metalness: .08, side: THREE.DoubleSide });
  const trimWhite = material({ color: '#dfe6ec', roughness: .5, metalness: .05 });
  const harnessRed = material({ color: '#a3322b', roughness: .58, metalness: .05 });
  const harnessYellow = material({ color: '#c99b37', roughness: .58, metalness: .05 });
  const blueMatte = material({ color: '#1c4763', roughness: .6, metalness: .16, clearcoat: .12 });
  const machined = material({ color: '#6a7582', roughness: .52, metalness: .6 });
  const mesh = (group: THREE.Group, name: string, geometry: THREE.BufferGeometry, position = V(0, 0, 0), material: THREE.MeshPhysicalMaterial | THREE.MeshPhysicalMaterial[] = white) => {
    const item = new THREE.Mesh(geometry, material);
    item.name = name;
    item.position.copy(position);
    item.castShadow = item.receiveShadow = true;
    item.userData.explodeWithParent = true;
    group.add(item);
    return item;
  };
  const part = (id: string, title: string, description: string, anchor: THREE.Vector3, explode: THREE.Vector3) => {
    const group = new THREE.Group(); group.name = id; group.userData.partId = id;
    root.add(group); parts.push({ id, title, description, group, anchor, explode }); return group;
  };
  const cylinder = (group: THREE.Group, name: string, a: THREE.Vector3, b: THREE.Vector3, radius: number, finish = silver, topRadius = radius, segments = 32) => {
    const item = mesh(group, name, new THREE.CylinderGeometry(topRadius, radius, a.distanceTo(b), segments), a.clone().add(b).multiplyScalar(.5), finish);
    item.quaternion.setFromUnitVectors(V(0, 1, 0), b.clone().sub(a).normalize()); return item;
  };
  const tube = (group: THREE.Group, name: string, points: THREE.Vector3[], radius: number, finish: THREE.MeshPhysicalMaterial, closed = false, tubularSegments = Math.max(20, points.length * 3), radialSegments = 8) =>
    mesh(group, name, new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points, closed, 'centripetal'), tubularSegments, radius, radialSegments, closed), V(0, 0, 0), finish);
  const bolt = (group: THREE.Group, position: THREE.Vector3, normal = V(0, 1, 0), radius = .016) => {
    cylinder(group, 'socket-fastener', position, position.clone().addScaledVector(normal, .008), radius, silver, radius, 12);
    cylinder(group, 'hex-socket', position.clone().addScaledVector(normal, .008), position.clone().addScaledVector(normal, .0086), radius * .44, black, radius * .44, 6);
  };
  const signedPower = (n: number, p: number) => Math.sign(n) * Math.pow(Math.abs(n), p);
  const profile = new THREE.SplineCurve([
    [0, .96], [.64, .972], [.84, .995], [.958, 1.045], [1, 1.11], [1, 1.30],
    [.997, 1.36], [.976, 1.41], [.925, 1.47], [.83, 1.53], [.60, 1.6], [.25, 1.638], [0, 1.644],
  ].map(([r, y]) => new THREE.Vector2(r, y))).getPoints(90);
  const radiusAt = (y: number) => {
    for (let i = 1; i < profile.length; i++) {
      if (profile[i].y >= y) {
        const a = profile[i - 1], b = profile[i];
        return THREE.MathUtils.lerp(a.x, b.x, (y - a.y) / (b.y - a.y));
      }
    }
    return 0;
  };
  const hullPoint = (angle: number, y: number, offset = 0) => {
    const r = radiusAt(y) + offset;
    return V(signedPower(Math.sin(angle), .79) * .7 * r, y, signedPower(Math.cos(angle), .79) * 1.2 * r);
  };
  const body = part('fuselage', '中央机身', '白色连续曲面上壳、蓝色底托与双侧肩部嵌片。上舱盖可移除查看航电舱；机头黑色开口内为双镜头传感模块，内部布局按同类六轴无人机常见方案重建。', V(0, 1.62, 0), V(0, .4, 0));
  const cowling = new THREE.Group(); cowling.name = 'upper-cowling'; cowling.userData.standalone = true; body.add(cowling);
  const interior = new THREE.Group(); interior.name = 'avionics-bay'; interior.userData.standalone = true; interior.visible = false; body.add(interior);
  const hullGeo = new THREE.LatheGeometry(profile, 112);
  const hp = hullGeo.attributes.position;
  for (let i = 0; i < hp.count; i++) {
    const x = hp.getX(i), z = hp.getZ(i), r = Math.hypot(x, z);
    if (r > 0) hp.setXYZ(i, signedPower(x / r, .79) * .7 * r, hp.getY(i), signedPower(z / r, .79) * 1.2 * r);
  }
  hullGeo.computeVertexNormals();
  const hi = hullGeo.index!, split: Record<'lower' | 'white' | 'upper', number[]> = { lower: [], white: [], upper: [] };
  for (let i = 0; i < hi.count; i += 3) {
    const y = (hp.getY(hi.getX(i)) + hp.getY(hi.getX(i + 1)) + hp.getY(hi.getX(i + 2))) / 3;
    split[y < 1.107 ? 'lower' : y < 1.30 ? 'white' : 'upper'].push(hi.getX(i), hi.getX(i + 1), hi.getX(i + 2));
  }
  const partGeo = (indices: number[]) => {
    const geo = new THREE.BufferGeometry();
    for (const name of Object.keys(hullGeo.attributes)) geo.setAttribute(name, hullGeo.attributes[name]);
    geo.setIndex(indices); geo.computeBoundingSphere(); return geo;
  };
  const lowerGeo = partGeo([...split.white, ...split.lower]);
  lowerGeo.clearGroups();
  lowerGeo.addGroup(0, split.white.length, 0);
  lowerGeo.addGroup(split.white.length, split.lower.length, 1);
  mesh(body, 'fuselage-lower-shell', lowerGeo, V(0, 0, 0), [white, blue]);
  mesh(cowling, 'fuselage-upper-cowling', partGeo(split.upper), V(0, 0, 0), white);
  tube(cowling, 'shell-separation', Array.from({ length: 112 }, (_, i) => hullPoint(i / 112 * Math.PI * 2, 1.335, .001)), .0023, seam, true);
  tube(body, 'cabin-opening-rim', Array.from({ length: 112 }, (_, i) => hullPoint(i / 112 * Math.PI * 2, 1.297, -.006)), .006, seam, true);
  const surfacePatch = (parent: THREE.Group, name: string, point: (u: number, v: number) => THREE.Vector3, finish: THREE.MeshPhysicalMaterial, columns = 48, rows = 10) => {
    const vertices: number[] = [], uv: number[] = [], indices: number[] = [];
    for (let row = 0; row <= rows; row++) for (let col = 0; col <= columns; col++) {
      vertices.push(...point(col / columns, row / rows).toArray()); uv.push(col / columns, row / rows);
    }
    for (let row = 0; row < rows; row++) for (let col = 0; col < columns; col++) {
      const a = row * (columns + 1) + col, b = a + columns + 1;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); geo.setIndex(indices); geo.computeVertexNormals();
    const patch = mesh(parent, name, geo, V(0, 0, 0), finish);
    patch.castShadow = false;
    return patch;
  };
  const inset = material({ color: '#214968', metalness: .36, roughness: .32, clearcoat: .5, side: THREE.DoubleSide });
  for (const side of [-1, 1]) {
    const shoulderPoint = (u: number, v: number, offset = .006) => {
      const angle = side * THREE.MathUtils.lerp(.63, 2.59, u);
      const thickness = .135 * Math.pow(Math.sin(Math.PI * u), .45);
      return hullPoint(angle, 1.47 + (v - .5) * thickness, offset);
    };
    surfacePatch(cowling, `shoulder-inlay-${side}`, shoulderPoint, inset);
    const border = Array.from({ length: 49 }, (_, i) => shoulderPoint(i / 48, 0, .005));
    border.push(...Array.from({ length: 47 }, (_, i) => shoulderPoint(1 - (i + 1) / 48, 1, .005)));
    tube(cowling, `shoulder-rim-${side}`, border, .003, silver, true);
    for (const z of [-.72, .65]) {
      const angle = side * Math.acos(signedPower(z / 1.2, 1 / .79));
      bolt(body, hullPoint(angle, 1.235, .005), V(side, 0, 0), .012);
    }
  }
  const noseMaterial = material({ color: '#060e18', roughness: .22, metalness: .2, side: THREE.DoubleSide });
  surfacePatch(body, 'nose-sensor-opening', (u, v) => hullPoint(THREE.MathUtils.lerp(-.36, .36, u), 1.21 + (v - .5) * .115 * Math.pow(Math.sin(Math.PI * u), .25), .005), noseMaterial, 36, 6);
  for (const theta of [-.19, .19]) {
    const lens = mesh(body, 'recessed-sensor-glass', new THREE.SphereGeometry(.038, 20, 12), hullPoint(theta, 1.205, .007), glass);
    lens.scale.set(1, .8, .11); lens.rotation.y = theta;
  }
  const wordmark = document.createElement('canvas'); wordmark.width = 1024; wordmark.height = 192;
  const ink = wordmark.getContext('2d')!;
  ink.fillStyle = '#162b48'; ink.font = '600 115px "Microsoft YaHei", sans-serif'; ink.textBaseline = 'middle';
  ink.fillText('翔云智航', 240, 101);
  ink.strokeStyle = '#162b48'; ink.lineWidth = 5; ink.lineCap = 'round';
  for (let line = 0; line < 3; line++) {
    ink.beginPath(); ink.moveTo(119, 117 + line * 8); ink.bezierCurveTo(70, 40 + line * 17, 48, 100 + line * 5, 10, 33 + line * 22); ink.stroke();
    ink.beginPath(); ink.moveTo(115, 128 + line * 8); ink.bezierCurveTo(146, 64 + line * 14, 185, 99 + line * 5, 218, 54 + line * 18); ink.stroke();
  }
  const logoTexture = new THREE.CanvasTexture(wordmark); logoTexture.colorSpace = THREE.SRGBColorSpace; logoTexture.anisotropy = 4;
  const logoMaterial = material({ map: logoTexture, transparent: true, depthWrite: false, roughness: .45, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 });
  for (const side of [-1, 1]) surfacePatch(cowling, `side-wordmark-${side}`, (u, v) => {
    const theta = side * THREE.MathUtils.lerp(side < 0 ? 1.95 : 1.18, side < 0 ? 1.18 : 1.95, u);
    return hullPoint(theta, 1.335 + (v - .5) * .15, .007);
  }, logoMaterial, 36, 4);
  mesh(body, 'underside-service-panel', new RoundedBoxGeometry(.66, .025, .85, 2, .035), V(0, .965, 0), graphite).userData.inferred = true;
  for (const x of [-.27, .27]) for (const z of [-.34, .34]) bolt(body, V(x, .949, z), V(0, -1, 0), .018);
  const antenna = part('antenna', '顶部圆盘天线', '后置圆盘、白色顶盖、分层底座与环形密封缝。开启舱内结构时随上舱盖一并移除；具体天线制式无法仅从图片确认。', V(0, 1.86, -.65), V(0, 1.05, -.3));
  cylinder(antenna, 'antenna-foot', V(0, 1.50, -.65), V(0, 1.66, -.65), .28, white, .305);
  cylinder(antenna, 'antenna-seal', V(0, 1.662, -.65), V(0, 1.673, -.65), .342, seam);
  const diskProfile = [[0, 1.665], [.32, 1.665], [.364, 1.68], [.376, 1.704], [.373, 1.753], [.352, 1.772], [.27, 1.785], [0, 1.79]].map(([r, y]) => new THREE.Vector2(r, y));
  mesh(antenna, 'antenna-radome', new THREE.LatheGeometry(diskProfile, 80), V(0, 0, -.65), white);
  const bladeGeometry = (handedness: number) => {
    const vertices: number[] = [], uv: number[] = [], indices: number[] = [];
    const lengths = [.068, .12, .21, .29, .38, .54, .72, .845, .875, .9];
    const chords = [.047, .054, .049, .105, .15, .125, .10, .079, .069, .018];
    const ringSegments = 16;
    lengths.forEach((length, i) => {
      const center = .018 * Math.sin(i / 9 * Math.PI), twist = handedness * THREE.MathUtils.lerp(.26, .045, length / .9);
      for (let j = 0; j <= ringSegments; j++) {
        const a = j / ringSegments * Math.PI * 2, chord = Math.cos(a) * chords[i] / 2 + center, thickness = Math.sin(a) * (.004 + chords[i] * .035);
        vertices.push(length, thickness * Math.cos(twist) - chord * Math.sin(twist), thickness * Math.sin(twist) + chord * Math.cos(twist));
        uv.push(length / .9, j / ringSegments);
      }
    });
    for (let i = 0; i < lengths.length - 1; i++) for (let j = 0; j < ringSegments; j++) {
      const a = i * (ringSegments + 1) + j, b = a + ringSegments + 1;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
    const bodyIndexCount = indices.length;
    for (const end of [0, lengths.length - 1]) {
      const centerIndex = vertices.length / 3;
      const center = V(0, 0, 0);
      for (let j = 0; j < ringSegments; j++) center.add(new THREE.Vector3().fromArray(vertices, (end * (ringSegments + 1) + j) * 3));
      vertices.push(...center.divideScalar(ringSegments).toArray()); uv.push(end === 0 ? 0 : 1, .5);
      for (let j = 0; j < ringSegments; j++) {
        const a = end * (ringSegments + 1) + j;
        indices.push(...(end === 0 ? [centerIndex, a, a + 1] : [centerIndex, a + 1, a]));
      }
    }
    const tipStart = 8 * ringSegments * 6;
    const rootCap = indices.splice(bodyIndexCount, ringSegments * 3);
    indices.splice(tipStart, 0, ...rootCap);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); geo.setIndex(indices); geo.computeVertexNormals();
    const darkCount = tipStart + rootCap.length;
    geo.addGroup(0, darkCount, 0); geo.addGroup(darkCount, indices.length - darkCount, 1);
    return geo;
  };
  const blades = [bladeGeometry(-1), bladeGeometry(1)];
  const positions = spec.reconstructionParameters.motorCentersXZ;
  positions.forEach(([x, z], i) => {
    const sign = Math.sign(x), number = i + 1;
    const a = V(sign * (z === 0 ? .62 : .48), 1.19, z === 0 ? 0 : Math.sign(z) * .83);
    const end = V(x, 1.19, z), direction = end.clone().sub(a).normalize();
    const arm = part(`arm-${number}`, `${['一', '二', '三', '四', '五', '六'][i]}号机臂 · 双叶旋翼`, '银色管状机臂、蓝色夹座、金属电机外壳、环形散热槽与双叶桨。相邻旋翼按相反方向演示；并非真实飞控。', V(x, 1.65, z), V(x * .43, .18, z * .43));
    cylinder(arm, `boom-${number}`, a, end, .0525, silver, .0525, 40);
    cylinder(arm, 'root-fairing', a.clone().addScaledVector(direction, -.04), a.clone().addScaledVector(direction, .08), .087, white, .072);
    cylinder(arm, 'root-collar', a.clone().addScaledVector(direction, .04), a.clone().addScaledVector(direction, .16), .069, blue);
    cylinder(arm, 'root-retaining-ring', a.clone().addScaledVector(direction, .14), a.clone().addScaledVector(direction, .157), .07, silver);
    cylinder(arm, 'motor-tube-clamp', end.clone().addScaledVector(direction, -.24), end.clone().addScaledVector(direction, -.015), .077, blue);
    cylinder(arm, 'clamp-retaining-ring', end.clone().addScaledVector(direction, -.242), end.clone().addScaledVector(direction, -.225), .079, black);
    cylinder(arm, `motor-mount-${number}`, V(x, 1.10, z), V(x, 1.25, z), .129, blue, .14);
    cylinder(arm, 'mount-lower-bevel', V(x, 1.08, z), V(x, 1.115, z), .09, blue, .13);
    cylinder(arm, 'motor-isolator', V(x, 1.252, z), V(x, 1.274, z), .124, black);
    cylinder(arm, `motor-${number}`, V(x, 1.274, z), V(x, 1.431, z), .116, silver);
    cylinder(arm, 'motor-lower-rim', V(x, 1.275, z), V(x, 1.29, z), .121, silver);
    cylinder(arm, 'motor-top-rim', V(x, 1.417, z), V(x, 1.437, z), .12, silver);
    cylinder(arm, 'vented-top-plate', V(x, 1.438, z), V(x, 1.465, z), .108, black, .094);
    for (let slot = 0; slot < 16; slot++) {
      const angle = slot / 16 * Math.PI * 2;
      const rib = mesh(arm, 'radial-vent-rib', new THREE.BoxGeometry(.006, .009, .033), V(x + Math.sin(angle) * .085, 1.466, z + Math.cos(angle) * .085), silver);
      rib.rotation.y = angle;
    }
    for (const sign of [-1, 1]) {
      const perpendicular = V(-direction.z, 0, direction.x).multiplyScalar(sign * .057);
      bolt(arm, end.clone().addScaledVector(direction, -.18).add(perpendicular).add(V(0, .067, 0)));
    }
    for (let j = 0; j < 4; j++) {
      const angle = j / 4 * Math.PI * 2 + .4;
      bolt(arm, V(x + Math.sin(angle) * .128, 1.205, z + Math.cos(angle) * .128), V(Math.sin(angle), 0, Math.cos(angle)), .01);
    }
    const rotor = new THREE.Group(); rotor.name = `rotor-${number}`; rotor.position.set(x, 1.51, z);
    rotor.rotation.y = z === 0 ? Math.PI / 2 : .08;
    rotor.userData.initialAngle = rotor.rotation.y; rotor.userData.axis = number;
    arm.add(rotor); rotors.push(rotor);
    cylinder(rotor, 'rotor-shaft', V(0, -.05, 0), V(0, .009, 0), .04, black);
    cylinder(rotor, `rotor-hub-${number}`, V(0, -.013, 0), V(0, .022, 0), .075, black, .069);
    cylinder(rotor, 'hub-polished-rim', V(0, .019, 0), V(0, .024, 0), .065, silver);
    for (const sign of [-1, 1]) bolt(rotor, V(sign * .047, .025, 0), V(0, 1, 0), .012);
    for (let j = 0; j < 2; j++) {
      const blade = mesh(rotor, `blade-${number}-${j + 1}`, blades[i % 2], V(0, 0, 0), [graphite, white]);
      blade.rotation.y = j * Math.PI;
    }
  });
  const gear = part('landing-gear', '双侧滑橇起落架', '两条纵向滑橇、四根弯曲支柱、顶部连接轴和橡胶脚垫。可隐藏以对照无起落架的概念版本。', V(.58, .28, .85), V(0, 0, .35));
  for (const side of [-1, 1]) {
    const x = side * .58;
    tube(gear, `skid-${side}`, [V(x, .18, -1.02), V(x, .13, -.89), V(x, .13, .84), V(x, .18, 1.04)], .028, graphite);
    for (const fore of [-1, 1]) {
      const top = V(side * .42, 1.015, fore * .63), foot = V(x, .15, fore * .85);
      tube(gear, `strut-${side}-${fore}`, [top, V(side * .49, .92, fore * .67), V(side * .54, .52, fore * .79), V(x, .25, fore * .85), foot], .031, graphite);
      cylinder(gear, 'top-pivot-sleeve', top.clone().add(V(-.075, 0, 0)), top.clone().add(V(.075, 0, 0)), .065, black);
      bolt(gear, top.clone().add(V(side * .078, 0, 0)), V(side, 0, 0), .026);
      cylinder(gear, 'leg-foot-collar', foot.clone().add(V(0, -.025, 0)), foot.clone().add(V(0, .09, 0)), .049, black, .037);
      cylinder(gear, 'rubber-foot', V(x, .088, fore * .85), V(x, .112, fore * .85), .06, rubber, .05);
      cylinder(gear, 'skid-joiner', V(x, .13, fore * .85 - .045), V(x, .13, fore * .85 + .045), .037, black);
      const bracket = mesh(gear, 'belly-attachment-bracket', new RoundedBoxGeometry(.16, .16, .19, 2, .022), top.clone().add(V(-side * .03, .03, 0)), blue);
      bolt(gear, bracket.position.clone().add(V(side * .083, .035, .05)), V(side, 0, 0), .014);
    }
  }
  const payload = part('payload', '机腹下挂载荷', '机腹快拆挂架与可替换任务载荷。救生圈、喊话器与三轴云台相机按市面常见方案重建，仅作结构演示，非认证任务设备。', V(0, .76, .02), V(0, -.46, 0));
  const safetyOrange = material({ color: '#d9581f', roughness: .5, metalness: .04, clearcoat: .34, clearcoatRoughness: .38 });
  const reflective = material({ color: '#eef4f7', roughness: .34, metalness: .24, clearcoat: .5 });
  const payloadMount = new THREE.Group(); payloadMount.name = 'payload-mount'; payloadMount.userData.standalone = true; payload.add(payloadMount);
  const payloadStash = new THREE.Group(); payloadStash.name = 'payload-stash'; payloadStash.userData.standalone = true;
  const payloadPods = {} as Record<Exclude<PayloadId, 'none'>, THREE.Group>;
  const payloadPod = (id: Exclude<PayloadId, 'none'>) => {
    const pod = new THREE.Group(); pod.name = `payload-${id}`; pod.userData.payloadPod = true; pod.userData.standalone = true;
    payloadStash.add(pod); payloadPods[id] = pod; return pod;
  };
  mesh(payloadMount, 'payload-belly-adapter', new RoundedBoxGeometry(.5, .03, .58, 2, .018), V(0, .936, .02), carbon);
  mesh(payloadMount, 'payload-quick-plate', new RoundedBoxGeometry(.34, .02, .42, 2, .012), V(0, .912, .02), blueMatte);
  for (const x of [-.2, .2]) for (const z of [-.22, .26]) bolt(payloadMount, V(x, .922, z), V(0, -1, 0), .013);
  for (const x of [-.13, .13]) mesh(payloadMount, 'payload-dovetail-rail', new RoundedBoxGeometry(.055, .05, .36, 1, .01), V(x, .887, .02), carbon);
  mesh(payloadMount, 'payload-release-body', new RoundedBoxGeometry(.26, .064, .2, 2, .012), V(0, .868, .02), carbon);
  const releaseLever = new THREE.Group(); releaseLever.name = 'payload-release-handle'; releaseLever.position.set(0, .842, .13); payloadMount.add(releaseLever);
  const payloadLever = mesh(releaseLever, 'payload-release-lever', new RoundedBoxGeometry(.15, .016, .05, 1, .006), V(0, 0, 0), silver);
  payloadLever.rotation.x = .16;
  mesh(payloadMount, 'payload-interface-pad', new RoundedBoxGeometry(.3, .012, .22, 1, .006), V(0, .838, .02), black);
  cylinder(payloadMount, 'release-safety-pin', V(.11, .874, .105), V(.24, .874, .105), .0075, power, .0075, 14);
  const pullRing = mesh(payloadMount, 'release-pull-ring', new THREE.TorusGeometry(.03, .005, 6, 18), V(.255, .874, .105), power);
  pullRing.rotation.y = Math.PI / 2;
  const ringPod = payloadPod('ring');
  mesh(ringPod, 'ring-quick-plate', new RoundedBoxGeometry(.24, .022, .2, 2, .008), V(0, .826, .02), blueMatte);
  for (const side of [-1, 1]) {
    cylinder(ringPod, 'ring-cradle-post', V(side * .21, .816, .02), V(side * .21, .672, .02), .017, carbon, .017, 14);
    mesh(ringPod, 'ring-cradle-clamp', new RoundedBoxGeometry(.062, .05, .09, 1, .008), V(side * .21, .672, .02), blueMatte);
  }
  const ringAssembly = new THREE.Group(); ringAssembly.name = 'life-ring-assembly'; ringPod.add(ringAssembly);
  const ringFloat = new THREE.Group(); ringFloat.name = 'life-ring-float'; ringFloat.position.set(0, .615, .02); ringAssembly.add(ringFloat);
  const lifeRingGeo = new THREE.TorusGeometry(.245, .057, 12, 48); lifeRingGeo.rotateX(Math.PI / 2);
  mesh(ringFloat, 'life-ring', lifeRingGeo, V(0, 0, 0), safetyOrange);
  for (let i = 0; i < 4; i++) {
    const angle = i / 4 * Math.PI * 2 + Math.PI * .08;
    const bandGeo = new THREE.TorusGeometry(.246, .059, 8, 10, Math.PI * .17);
    bandGeo.rotateZ(angle); bandGeo.rotateX(Math.PI / 2);
    mesh(ringFloat, 'life-ring-reflective-band', bandGeo, V(0, 0, 0), reflective);
    const tie = mesh(ringFloat, 'life-ring-tie', new THREE.TorusGeometry(.062, .005, 6, 14), V(Math.sin(angle) * .245, 0, Math.cos(angle) * .245), black);
    tie.quaternion.setFromUnitVectors(V(0, 0, 1), V(Math.cos(angle), 0, -Math.sin(angle)));
  }
  cylinder(ringPod, 'ring-release-canister', V(-.29, .68, .02), V(-.29, .8, .02), .028, silver, .028, 18);
  cylinder(ringPod, 'ring-canister-cap', V(-.29, .8, .02), V(-.29, .812, .02), .02, black, .02, 16);
  mesh(ringPod, 'ring-canister-bracket', new RoundedBoxGeometry(.1, .028, .06, 1, .005), V(-.255, .77, .02), blueMatte);
  cylinder(ringPod, 'ring-canister-hose', V(-.29, .8, .02), V(-.24, .8, .02), .006, black, .006, 10);
  const speakerPod = payloadPod('speaker');
  mesh(speakerPod, 'speaker-quick-plate', new RoundedBoxGeometry(.2, .022, .18, 2, .008), V(0, .826, .02), blueMatte);
  for (const side of [-1, 1]) mesh(speakerPod, 'speaker-yoke', new RoundedBoxGeometry(.026, .09, .06, 2, .006), V(side * .085, .776, .02), carbon);
  mesh(speakerPod, 'speaker-yoke-bridge', new RoundedBoxGeometry(.19, .024, .06, 1, .006), V(0, .744, .02), carbon);
  mesh(speakerPod, 'speaker-clamp', new RoundedBoxGeometry(.16, .05, .09, 1, .01), V(0, .733, -.005), blueMatte);
  const speakerDirection = V(0, -.32, .95).normalize();
  const speakerRear = V(0, .712, -.005);
  const speakerHead = new THREE.Group(); speakerHead.name = 'speaker-head'; speakerHead.position.copy(speakerRear); speakerPod.add(speakerHead);
  cylinder(speakerHead, 'speaker-driver', speakerDirection.clone().multiplyScalar(-.075), speakerDirection.clone().multiplyScalar(.015), .074, black, .074, 28);
  cylinder(speakerHead, 'speaker-horn', speakerDirection.clone().multiplyScalar(.01), speakerDirection.clone().multiplyScalar(.32), .052, black, .158, 40);
  const speakerRim = mesh(speakerHead, 'speaker-horn-rim', new THREE.TorusGeometry(.158, .0095, 8, 40), speakerDirection.clone().multiplyScalar(.322), machined);
  speakerRim.quaternion.setFromUnitVectors(V(0, 0, 1), speakerDirection);
  for (const [radius, thickness] of [[.045, .004], [.09, .0035], [.132, .003]] as const) {
    const grille = mesh(speakerHead, 'speaker-grille-ring', new THREE.TorusGeometry(radius, thickness, 6, 28), speakerDirection.clone().multiplyScalar(.329), machined);
    grille.quaternion.setFromUnitVectors(V(0, 0, 1), speakerDirection);
  }
  mesh(speakerHead, 'speaker-grille-cap', new THREE.CircleGeometry(.042, 20), speakerDirection.clone().multiplyScalar(.33), black).quaternion.setFromUnitVectors(V(0, 0, 1), speakerDirection);
  tube(speakerPod, 'speaker-cable', [V(0, .828, -.035), V(.025, .79, -.075), V(.015, .748, -.055), V(.03, .726, -.03)], .004, black, false, 12, 5);
  cylinder(speakerPod, 'speaker-status-led', V(.052, .782, .012), V(.052, .79, .012), .007, led, .007, 12);
  const cameraPod = payloadPod('camera');
  mesh(cameraPod, 'camera-quick-plate', new RoundedBoxGeometry(.22, .022, .2, 2, .008), V(0, .826, .02), blueMatte);
  cylinder(cameraPod, 'gimbal-yaw-motor', V(0, .814, .02), V(0, .752, .02), .052, black, .052, 28);
  cylinder(cameraPod, 'gimbal-yaw-ring', V(0, .81, .02), V(0, .796, .02), .057, silver, .057, 28);
  mesh(cameraPod, 'gimbal-yaw-bracket', new RoundedBoxGeometry(.13, .022, .08, 1, .006), V(.052, .748, .02), carbon);
  for (const side of [-1, 1]) mesh(cameraPod, 'gimbal-side-arm', new RoundedBoxGeometry(.028, .13, .08, 2, .008), V(side * .112, .69, .02), carbon);
  cylinder(cameraPod, 'gimbal-roll-motor', V(.098, .655, .02), V(.142, .655, .02), .038, black, .038, 24);
  cylinder(cameraPod, 'gimbal-roll-ring', V(.136, .655, .02), V(.144, .655, .02), .041, silver, .041, 24);
  cylinder(cameraPod, 'gimbal-pitch-motor', V(-.142, .655, .02), V(-.098, .655, .02), .038, black, .038, 24);
  cylinder(cameraPod, 'gimbal-pitch-ring', V(-.144, .655, .02), V(-.136, .655, .02), .041, silver, .041, 24);
  const cameraHead = new THREE.Group(); cameraHead.name = 'gimbal-head'; cameraHead.position.set(0, .655, .02); cameraPod.add(cameraHead);
  mesh(cameraHead, 'camera-housing', new RoundedBoxGeometry(.18, .13, .16, 3, .018), V(0, 0, .025), graphite);
  mesh(cameraHead, 'camera-top-plate', new RoundedBoxGeometry(.14, .012, .11, 1, .004), V(0, .069, .02), silver);
  cylinder(cameraHead, 'camera-lens-barrel', V(0, .003, .1), V(0, .003, .148), .048, black, .044, 28);
  cylinder(cameraHead, 'camera-lens-bezel', V(0, .003, .146), V(0, .003, .156), .052, silver, .052, 28);
  cylinder(cameraHead, 'camera-lens-glass', V(0, .003, .155), V(0, .003, .158), .042, glass, .042, 28);
  cylinder(cameraHead, 'camera-side-sensor', V(.058, -.037, .1), V(.058, -.037, .125), .017, black, .017, 16);
  cylinder(cameraHead, 'camera-side-glass', V(.058, -.037, .124), V(.058, -.037, .127), .013, glass, .013, 16);
  const cameraLed = mesh(cameraHead, 'camera-status-led', new THREE.CylinderGeometry(.006, .006, .003, 10), V(-.06, .066, .104), led);
  cameraLed.rotation.x = Math.PI / 2;
  tube(cameraPod, 'gimbal-cable', [V(.03, .79, .065), V(.1, .74, .065), V(.128, .7, .055), V(.118, .68, .055)], .004, black, false, 12, 5);
  const cameraBadge = document.createElement('canvas'); cameraBadge.width = 384; cameraBadge.height = 192;
  const badgeInk = cameraBadge.getContext('2d')!;
  badgeInk.fillStyle = '#101820'; badgeInk.fillRect(0, 0, 384, 192);
  badgeInk.strokeStyle = '#4f6b7d'; badgeInk.lineWidth = 4; badgeInk.strokeRect(8, 8, 368, 176);
  badgeInk.fillStyle = '#eaf2f6'; badgeInk.font = '700 92px "Segoe UI", sans-serif'; badgeInk.fillText('4K', 30, 112);
  badgeInk.fillStyle = '#7fb9d8'; badgeInk.font = '600 30px "Segoe UI", sans-serif'; badgeInk.fillText('3-AXIS', 32, 158);
  badgeInk.strokeStyle = '#46c8ee'; badgeInk.lineWidth = 6; badgeInk.beginPath(); badgeInk.moveTo(210, 62); badgeInk.lineTo(340, 62); badgeInk.stroke();
  badgeInk.fillStyle = '#9fb4c2'; badgeInk.font = '500 24px "Segoe UI", sans-serif'; badgeInk.fillText('GIMBAL CAM', 210, 104);
  badgeInk.fillStyle = '#46c8ee'; badgeInk.beginPath(); badgeInk.arc(340, 150, 8, 0, Math.PI * 2); badgeInk.fill();
  const badgeTexture = new THREE.CanvasTexture(cameraBadge); badgeTexture.colorSpace = THREE.SRGBColorSpace; badgeTexture.anisotropy = 4;
  const badgeMaterial = material({ map: badgeTexture, transparent: true, depthWrite: false, roughness: .5, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 });
  const cameraBadgePlane = mesh(cameraHead, 'camera-spec-badge', new THREE.PlaneGeometry(.105, .0525), V(.0925, .023, .03), badgeMaterial);
  cameraBadgePlane.rotation.y = Math.PI / 2; cameraBadgePlane.castShadow = false;
  const bay = interior;
  const bayLight = new THREE.PointLight('#cfe6ff', 0, 2.6, 2);
  bayLight.position.set(0, 1.56, .02);
  bay.add(bayLight);
  const linerRows = Array.from({ length: 22 }, (_, i) => .98 + i / 21 * .335);
  const linerColumns = 72, linerVertices: number[] = [], linerUvs: number[] = [], linerIndices: number[] = [];
  linerRows.forEach((y, row) => {
    for (let col = 0; col <= linerColumns; col++) {
      linerVertices.push(...hullPoint(col / linerColumns * Math.PI * 2, y, -.014).toArray());
      linerUvs.push(col / linerColumns, row / (linerRows.length - 1));
    }
  });
  for (let row = 0; row < linerRows.length - 1; row++) for (let col = 0; col < linerColumns; col++) {
    const a = row * (linerColumns + 1) + col, b = a + linerColumns + 1;
    linerIndices.push(a, b, a + 1, b, b + 1, a + 1);
  }
  const linerGeo = new THREE.BufferGeometry();
  linerGeo.setAttribute('position', new THREE.Float32BufferAttribute(linerVertices, 3));
  linerGeo.setAttribute('uv', new THREE.Float32BufferAttribute(linerUvs, 2));
  linerGeo.setIndex(linerIndices); linerGeo.computeVertexNormals();
  mesh(bay, 'cabin-liner', linerGeo, V(0, 0, 0), liner);
  mesh(bay, 'bay-floor', new RoundedBoxGeometry(1.02, .008, 1.5, 1, .02), V(0, 1.078, 0), carbon);
  mesh(bay, 'avionics-tray', new RoundedBoxGeometry(.92, .014, 1.52, 2, .012), V(0, 1.118, 0), carbon);
  for (const x of [-.4, .4]) mesh(bay, 'tray-rail', new RoundedBoxGeometry(.035, .022, 1.5, 1, .008), V(x, 1.1, 0), graphite);
  for (const z of [-.4, .4]) mesh(bay, 'tray-cross-beam', new RoundedBoxGeometry(.8, .02, .055, 1, .008), V(0, 1.1, z), graphite);
  for (const x of [-.36, .36]) for (const z of [-.6, .6]) {
    cylinder(bay, 'tray-isolator', V(x, 1.078, z), V(x, 1.111, z), .024, rubber);
    cylinder(bay, 'tray-isolator-washer', V(x, 1.111, z), V(x, 1.116, z), .031, silver);
  }
  for (const x of [-.42, .42]) for (const z of [-.7, .7]) bolt(bay, V(x, 1.127, z), V(0, 1, 0), .012);
  const frameRing = (y: number, offset: number) => Array.from({ length: 48 }, (_, i) => hullPoint(i / 112 * Math.PI * 2, y, offset));
  tube(bay, 'cabin-frame-ring', frameRing(1.185, -.055), .008, carbon, true, 96, 6);
  tube(bay, 'cabin-upper-ring', frameRing(1.288, -.045), .007, carbon, true, 96, 6);
  for (const angle of [.78, 2.36, 3.93, 5.5]) {
    const foot = hullPoint(angle, 1.185, -.055), top = hullPoint(angle, 1.288, -.045);
    tube(bay, 'cabin-frame-post', [foot, foot.clone().lerp(top, .5), top], .007, carbon, false, 10, 5);
  }
  for (const side of [-1, 1]) tube(bay, 'cabin-led-strip', Array.from({ length: 33 }, (_, i) => hullPoint(side < 0 ? THREE.MathUtils.lerp(.42, 2.72, i / 32) : THREE.MathUtils.lerp(Math.PI + .42, Math.PI + 2.72, i / 32), 1.245, -.03)), .0035, led, false, 64, 5);
  const armRoots: [number, number][] = [[.62, 0], [.48, .83], [-.48, .83], [-.62, 0], [-.48, -.83], [.48, -.83]];
  for (const [x, z] of armRoots) {
    const yaw = Math.atan2(x, z);
    const saddle = mesh(bay, 'arm-root-saddle', new RoundedBoxGeometry(.17, .026, .105, 2, .008), V(x, 1.277, z), carbon);
    saddle.rotation.y = yaw;
    const strap = mesh(bay, 'arm-root-strap', new RoundedBoxGeometry(.12, .012, .055, 1, .004), V(x, 1.289, z), blueMatte);
    strap.rotation.y = yaw;
    for (const side of [-1, 1]) bolt(bay, V(x + Math.cos(yaw) * side * .062, 1.291, z - Math.sin(yaw) * side * .062), V(0, 1, 0), .008);
  }
  mesh(bay, 'flight-battery', new RoundedBoxGeometry(.52, .145, .7, 3, .04), V(0, 1.345, .01), cell);
  for (const x of [-.15, .15]) mesh(bay, 'battery-sled', new RoundedBoxGeometry(.06, .132, .72, 1, .01), V(x, 1.206, .01), carbon);
  for (const z of [-.2, .18]) {
    mesh(bay, 'battery-strap', new RoundedBoxGeometry(.545, .012, .05, 1, .004), V(0, 1.422, .01 + z), neutral);
    for (const side of [-1, 1]) mesh(bay, 'strap-buckle', new RoundedBoxGeometry(.016, .055, .05, 1, .005), V(side * .277, 1.372, .01 + z), blueMatte);
  }
  const packCanvas = document.createElement('canvas'); packCanvas.width = 900; packCanvas.height = 640;
  const packInk = packCanvas.getContext('2d')!;
  packInk.fillStyle = '#1c252e'; packInk.fillRect(0, 0, 900, 640);
  packInk.fillStyle = '#2b3a47'; packInk.fillRect(0, 0, 900, 118);
  packInk.fillStyle = '#7fc4e8'; packInk.fillRect(0, 118, 900, 8);
  packInk.fillStyle = '#e9f2f7'; packInk.font = '600 54px "Microsoft YaHei", sans-serif'; packInk.textBaseline = 'middle';
  packInk.fillText('翔云智航', 44, 62);
  packInk.fillStyle = '#9fb4c2'; packInk.font = '500 23px "Microsoft YaHei", sans-serif';
  packInk.fillText('LI-PO FLIGHT PACK / 智能飞行电池', 236, 64);
  packInk.fillStyle = '#e9f2f7'; packInk.font = '700 66px "Segoe UI", "Microsoft YaHei", sans-serif';
  packInk.fillText('6S · 16000mAh', 44, 198);
  packInk.fillStyle = '#7fc4e8'; packInk.font = '600 44px "Segoe UI", sans-serif';
  packInk.fillText('22.2V', 44, 274);
  packInk.fillStyle = '#c2d2dc'; packInk.font = '500 28px "Microsoft YaHei", sans-serif';
  packInk.fillText('15C 持续放电 / 240A 峰值', 216, 277);
  packInk.strokeStyle = '#6b7d8a'; packInk.lineWidth = 2; packInk.strokeRect(44, 330, 812, 108);
  packInk.fillStyle = '#93a7b4'; packInk.font = '400 22px "Microsoft YaHei", sans-serif';
  packInk.fillText('警告：禁止短路、穿刺或过充。仅使用原厂充电器。', 64, 366);
  packInk.fillText('WARNING: DO NOT SHORT CIRCUIT, PUNCTURE OR OVERCHARGE.', 64, 404);
  packInk.fillStyle = '#dfe8ee';
  let barX = 64;
  for (let i = 0; i < 46; i++) { const w = 2 + (i * 7) % 5; packInk.fillRect(barX, 470, w, 92); barX += w + 6; }
  packInk.fillStyle = '#93a7b4'; packInk.font = '400 21px "Segoe UI", monospace';
  packInk.fillText('SY-6S-16000-2026', 64, 592);
  packInk.fillStyle = '#46c8ee'; packInk.beginPath(); packInk.arc(812, 200, 9, 0, Math.PI * 2); packInk.fill();
  const packTexture = new THREE.CanvasTexture(packCanvas); packTexture.colorSpace = THREE.SRGBColorSpace; packTexture.anisotropy = 4;
  const packMaterial = material({ map: packTexture, roughness: .95, metalness: 0, envMapIntensity: .1, specularIntensity: .18 });
  const dataLabel = mesh(bay, 'battery-data-label', new THREE.PlaneGeometry(.46, .327), V(0, 1.4192, .01), packMaterial);
  dataLabel.rotation.x = -Math.PI / 2; dataLabel.castShadow = false;
  mesh(bay, 'battery-latch', new RoundedBoxGeometry(.14, .045, .022, 1, .006), V(0, 1.297, .362), blueMatte);
  mesh(bay, 'battery-terminal-block', new RoundedBoxGeometry(.18, .055, .04, 1, .008), V(0, 1.33, -.352), black);
  for (const x of [-.045, .045]) {
    cylinder(bay, 'main-terminal', V(x, 1.33, -.371), V(x, 1.33, -.387), .011, gold, .011, 16);
    cylinder(bay, 'terminal-shrink', V(x, 1.33, -.34), V(x, 1.33, -.352), .013, power, .013, 12);
  }
  mesh(bay, 'balance-port', new RoundedBoxGeometry(.06, .024, .022, 1, .004), V(.12, 1.35, -.356), trimWhite);
  for (let i = 0; i < 4; i++) cylinder(bay, 'charge-indicator', V(-.09 + i * .06, 1.408, .353), V(-.09 + i * .06, 1.408, .363), .008, i < 3 ? led : chip, .008, 12);
  mesh(bay, 'power-distribution-board', new RoundedBoxGeometry(.5, .012, .28, 1, .008), V(0, 1.14, .53), pcb);
  for (const x of [-.19, .19]) for (const z of [.46, .6]) cylinder(bay, 'pdb-standoff', V(x, 1.127, z), V(x, 1.135, z), .01, silver, .01, 10);
  for (let i = 0; i < 8; i++) {
    const x = -.16 + (i % 4) * .1, z = .44 + Math.floor(i / 4) * .1;
    cylinder(bay, 'pdb-pad', V(x, 1.146, z), V(x, 1.1475, z), .011, gold, .011, 10);
  }
  for (const x of [-.17, .17]) {
    cylinder(bay, 'pdb-capacitor', V(x, 1.147, .46), V(x, 1.202, .46), .021, black, .018, 18);
    cylinder(bay, 'pdb-capacitor-top', V(x, 1.202, .46), V(x, 1.205, .46), .016, silver, .016, 18);
  }
  mesh(bay, 'main-power-connector', new RoundedBoxGeometry(.075, .032, .05, 1, .006), V(0, 1.152, .65), black);
  for (const x of [-.022, .022]) cylinder(bay, 'connector-pin', V(x, 1.152, .675), V(x, 1.152, .688), .006, gold, .006, 10);
  mesh(bay, 'fc-base-plate', new RoundedBoxGeometry(.32, .008, .24, 1, .012), V(0, 1.162, -.5), carbon);
  for (const x of [-.13, .13]) for (const z of [-.59, -.41]) {
    cylinder(bay, 'fc-standoff', V(x, 1.166, z), V(x, 1.241, z), .007, silver, .007, 10);
    cylinder(bay, 'fc-grommet', V(x, 1.168, z), V(x, 1.18, z), .015, rubber);
  }
  mesh(bay, 'flight-controller-board', new RoundedBoxGeometry(.30, .008, .24, 1, .008), V(0, 1.206, -.5), pcb);
  mesh(bay, 'fc-top-board', new RoundedBoxGeometry(.24, .006, .18, 1, .006), V(0, 1.244, -.5), pcb);
  mesh(bay, 'fc-processor', new RoundedBoxGeometry(.055, .012, .055, 1, .003), V(0, 1.216, -.53), chip);
  cylinder(bay, 'imu-can', V(.09, 1.21, -.45), V(.09, 1.232, -.45), .019, silver, .019, 16);
  mesh(bay, 'barometer', new RoundedBoxGeometry(.028, .008, .028, 1, .003), V(-.09, 1.214, -.45), chip);
  for (const side of [-1, 1]) mesh(bay, 'fc-pin-header', new RoundedBoxGeometry(.13, .014, .018, 1, .003), V(0, 1.215, -.5 + side * .1), trimWhite);
  mesh(bay, 'usb-c-port', new RoundedBoxGeometry(.034, .012, .014, 1, .003), V(0, 1.206, -.619), silver);
  mesh(bay, 'micro-sd', new RoundedBoxGeometry(.022, .004, .018, 1, .002), V(.126, 1.211, -.41), gold);
  cylinder(bay, 'fc-buzzer', V(-.1, 1.21, -.575), V(-.1, 1.223, -.575), .014, black, .014, 16);
  mesh(bay, 'fc-top-component', new RoundedBoxGeometry(.04, .01, .04, 1, .003), V(0, 1.251, -.5), chip);
  mesh(bay, 'fc-top-connector', new RoundedBoxGeometry(.06, .01, .02, 1, .003), V(0, 1.25, -.43), trimWhite);
  for (const x of [-.045, .045]) cylinder(bay, 'fc-status-led', V(x, 1.249, -.468), V(x, 1.2505, -.468), .005, led, .005, 10);
  cylinder(bay, 'antenna-mast', V(0, 1.12, -.65), V(0, 1.505, -.65), .022, carbon, .017, 18);
  cylinder(bay, 'mast-collar', V(0, 1.318, -.65), V(0, 1.338, -.65), .031, silver, .031, 18);
  mesh(bay, 'gps-mount-plate', new RoundedBoxGeometry(.22, .008, .17, 1, .012), V(0, 1.332, -.65), carbon);
  mesh(bay, 'gps-module', new RoundedBoxGeometry(.12, .012, .1, 1, .006), V(0, 1.344, -.65), pcb);
  mesh(bay, 'gps-patch', new RoundedBoxGeometry(.085, .006, .07, 1, .004), V(0, 1.353, -.65), silver);
  mesh(bay, 'gps-ceramic', new RoundedBoxGeometry(.055, .004, .045, 1, .003), V(0, 1.358, -.65), trimWhite);
  mesh(bay, 'compass-board', new RoundedBoxGeometry(.055, .008, .05, 1, .004), V(0, 1.341, -.715), pcb);
  mesh(bay, 'compass-chip', new RoundedBoxGeometry(.018, .006, .018, 1, .002), V(0, 1.348, -.715), chip);
  mesh(bay, 'mast-mount-plate', new THREE.CylinderGeometry(.13, .13, .008, 28), V(0, 1.486, -.65), carbon);
  cylinder(bay, 'mast-coupler', V(0, 1.488, -.65), V(0, 1.505, -.65), .052, black);
  for (let i = 0; i < 4; i++) {
    const angle = i / 4 * Math.PI * 2 + .4;
    bolt(bay, V(Math.sin(angle) * .085, 1.49, -.65 + Math.cos(angle) * .085), V(0, 1, 0), .01);
  }
  mesh(bay, 'nose-sensor-housing', new RoundedBoxGeometry(.44, .1, .16, 2, .03), V(0, 1.212, 1.02), graphite);
  mesh(bay, 'sensor-heatsink-base', new RoundedBoxGeometry(.30, .012, .12, 1, .006), V(0, 1.268, 1.0), machined);
  for (let i = 0; i < 5; i++) mesh(bay, 'sensor-fin', new THREE.BoxGeometry(.28, .016, .006), V(0, 1.282, .958 + i * .022), machined);
  for (const side of [-1, 1]) {
    const x = side * .155;
    cylinder(bay, 'lens-barrel', V(x, 1.212, 1.095), V(x, 1.212, 1.166), .036, black, .036, 24);
    cylinder(bay, 'lens-bezel', V(x, 1.212, 1.162), V(x, 1.212, 1.174), .041, black, .041, 24);
    cylinder(bay, 'camera-lens', V(x, 1.212, 1.173), V(x, 1.212, 1.179), .028, glass, .028, 24);
    mesh(bay, 'sensor-led-ring', new THREE.TorusGeometry(.033, .0035, 8, 24), V(x, 1.212, 1.18), led);
  }
  mesh(bay, 'ir-window', new RoundedBoxGeometry(.05, .028, .006, 1, .002), V(0, 1.212, 1.178), glass);
  mesh(bay, 'sensor-bracket', new RoundedBoxGeometry(.12, .11, .07, 1, .01), V(0, 1.164, 1.01), carbon);
  for (let cable = 0; cable < 3; cable++) tube(bay, 'nose-signal-harness', [
    V(-.1 + cable * .1, 1.196, .94), V(.28 + cable * .006, 1.176, .58), V(.32, 1.164, .18), V(.24, 1.17, -.28), V(.1, 1.19, -.4),
  ], .004, neutral, false, 12, 5);
  for (const side of [-1, 1]) tube(bay, 'main-power-lead', [
    V(side * .06, 1.33, -.39), V(side * .29, 1.29, -.28), V(side * .34, 1.2, .08), V(side * .3, 1.158, .4), V(side * .18, 1.152, .58),
  ], .008, side < 0 ? neutral : harnessRed, false, 12, 5);
  const armAngle = (x: number, z: number) => Math.atan2(Math.sign(x) * Math.pow(Math.abs(x) / .7, 1 / .79), Math.sign(z) * Math.pow(Math.abs(z) / 1.2, 1 / .79));
  const escSpots: [number, number][] = [[.4, .57], [.53, 0], [.4, -.57], [-.4, -.57], [-.53, 0], [-.4, .57]];
  escSpots.forEach(([x, z]) => {
    const yaw = Math.atan2(x, z), radialX = Math.sin(yaw), radialZ = Math.cos(yaw), tangentX = Math.cos(yaw), tangentZ = -Math.sin(yaw);
    const board = mesh(bay, 'esc-board', new RoundedBoxGeometry(.16, .008, .3, 1, .006), V(x, 1.145, z), pcb);
    board.rotation.y = yaw;
    const sink = mesh(bay, 'esc-heatsink', new RoundedBoxGeometry(.1, .014, .14, 1, .004), V(x + radialX * .04, 1.157, z + radialZ * .04), machined);
    sink.rotation.y = yaw;
    for (let fin = 0; fin < 4; fin++) {
      const rib = mesh(bay, 'esc-fin', new THREE.BoxGeometry(.095, .01, .01), V(x + radialX * (-.01 + fin * .035), 1.166, z + radialZ * (-.01 + fin * .035)), machined);
      rib.rotation.y = yaw;
    }
    for (let cap = -1; cap <= 1; cap++) {
      const cx = x - radialX * .115 + tangentX * cap * .045, cz = z - radialZ * .115 + tangentZ * cap * .045;
      cylinder(bay, 'esc-capacitor', V(cx, 1.15, cz), V(cx, 1.182, cz), .011, black, .011, 12);
    }
    const connector = mesh(bay, 'esc-connector', new RoundedBoxGeometry(.05, .026, .04, 1, .005), V(x - radialX * .125, 1.158, z - radialZ * .125), blueMatte);
    connector.rotation.y = yaw;
    for (const [tx, tz] of [[-.065, -.13], [.065, -.13], [-.065, .13], [.065, .13]]) {
      bolt(bay, V(x + tangentX * tx + radialX * tz, 1.151, z + tangentZ * tx + radialZ * tz), V(0, 1, 0), .007);
    }
    const socketAngle = armAngle(x, z), socketX = Math.sin(socketAngle), socketZ = Math.cos(socketAngle);
    const socketAnchor = hullPoint(socketAngle, 1.172, -.07);
    const inward = V(-socketX, 0, -socketZ);
    const socket = socketAnchor.clone().addScaledVector(inward, .02);
    const socketBlock = mesh(bay, 'arm-power-socket', new RoundedBoxGeometry(.078, .095, .07, 2, .01), socket, blueMatte);
    socketBlock.rotation.y = socketAngle;
    cylinder(bay, 'socket-bushing', socket.clone().add(V(0, .045, 0)), socket.clone().add(V(0, .072, 0)), .03, carbon);
    for (let pin = -1; pin <= 1; pin++) {
      const pinBase = socket.clone().add(V(-socketZ * pin * .019, .04, socketX * pin * .019)).addScaledVector(inward, .035);
      cylinder(bay, 'phase-pin', pinBase, pinBase.clone().addScaledVector(inward, .012), .005, gold, .005, 8);
      const start = V(x + radialX * .14 + tangentX * pin * .03, 1.152, z + radialZ * .14 + tangentZ * pin * .03);
      const end = socketAnchor.clone().addScaledVector(inward, .05).add(V(-socketZ * pin * .019, .04, socketX * pin * .019));
      tube(bay, 'phase-harness', [start, start.clone().lerp(end, .45).add(V(0, .035, 0)), end], .0042, [harnessYellow, harnessRed, neutral][pin + 1], false, 12, 5);
    }
    const signalStart = V(x - radialX * .12 + tangentX * .05, 1.159, z - radialZ * .12 + tangentZ * .05);
    tube(bay, 'esc-signal', [signalStart, V(x * .62, 1.19, z * .62), V(x * .28, 1.2, z * .28), V(.12, 1.19, -.42)], .0026, neutral, false, 12, 5);
    const pdbEdge = V(THREE.MathUtils.clamp(x * .42, -.21, .21), 1.148, z > 0 ? .615 : .445);
    const escInner = V(x - radialX * .12, 1.155, z - radialZ * .12);
    for (const side of [-1, 1]) {
      const offset = V(tangentX, 0, tangentZ).multiplyScalar(side * .007);
      tube(bay, 'esc-power-lead', [pdbEdge.clone().add(offset), pdbEdge.clone().lerp(escInner, .5).add(offset).add(V(0, .03, 0)), escInner.clone().add(offset)], .005, side < 0 ? neutral : harnessRed, false, 12, 5);
    }
  });
  const batch = (group: THREE.Group) => {
    const buckets = new Map<THREE.Material, THREE.Mesh[]>();
    group.children.forEach(child => {
      if (child instanceof THREE.Group && !child.userData.standalone) batch(child);
      if (!(child instanceof THREE.Mesh) || Array.isArray(child.material)) return;
      const bucket = buckets.get(child.material) ?? []; bucket.push(child); buckets.set(child.material, bucket);
    });
    for (const [finish, children] of buckets) {
      if (children.length < 2) continue;
      const geometries = children.map(child => { child.updateMatrix(); return child.geometry.clone().applyMatrix4(child.matrix); });
      const indexed = geometries.every(geometry => geometry.index);
      const sources = indexed ? geometries : geometries.map(geometry => geometry.index ? geometry.toNonIndexed() : geometry);
      const geometry = mergeGeometries(sources, false)!;
      const combined = mesh(group, `${group.name}-details-${finish.id}`, geometry, V(0, 0, 0), finish as THREE.MeshPhysicalMaterial);
      combined.castShadow = children.some(child => child.castShadow);
      combined.userData.components = children.map(child => child.name);
      children.forEach(child => group.remove(child));
      geometries.forEach(geometry => geometry.dispose());
      if (!indexed) sources.forEach(geometry => { if (!geometries.includes(geometry)) geometry.dispose(); });
    }
  };
  parts.forEach(p => batch(p.group));
  batch(cowling);
  batch(interior);
  batch(payloadMount);
  Object.values(payloadPods).forEach(pod => batch(pod));
  [payloadMount, ...Object.values(payloadPods)].forEach(group => group.traverse(child => { if (child instanceof THREE.Mesh) child.castShadow = false; }));
  let payloadId: PayloadId = 'none';
  const setPayload = (id: PayloadId) => {
    payloadId = id;
    const attached = payload.children.find(child => child.userData.payloadPod);
    if (attached) { payload.remove(attached); payloadStash.add(attached); }
    if (id !== 'none') { const pod = payloadPods[id]; payloadStash.remove(pod); payload.add(pod); }
  };
  setPayload('camera');
  root.userData.sculptRuntime = { nodes: Object.fromEntries(parts.map(p=>[p.id,p.group])), pivots:rotors, sockets:positions.map(([x,z])=>V(x,1.19,z)), collider:{type:'compound',dimensions:[4.5,1.8,5.5]}, destructionGroups:parts.map(p=>({id:p.id,componentIds:[p.id]})) };
  return {root,parts,rotors,materials,payloadRig:{ringAssembly,ringFloat,cameraHead,speakerHead,releaseLever,speakerDirection:speakerDirection.clone()},setExplode(amount){parts.forEach(p=>p.group.position.copy(p.explode).multiplyScalar(amount));},setWireframe(enabled){materials.forEach(m=>m.wireframe=enabled);},setCabinOpen(enabled){cowling.visible=!enabled;},setInteriorVisible(visible){interior.visible=visible;bayLight.intensity=visible?0.45:0;},setPayload,getPayload:()=>payloadId};
}
