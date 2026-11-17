import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { createSixAxisHexacopterModel, type PayloadId } from './createObjectModel';

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const viewport = el('viewport');
const scenePanel = document.querySelector<HTMLElement>('.scene-panel')!;
const loading = el('loading');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const scene = new THREE.Scene();
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.domElement.setAttribute('aria-label', '可旋转的六轴无人机模型');
renderer.domElement.tabIndex = 0;
viewport.append(renderer.domElement);
const camera = new THREE.PerspectiveCamera(33, 1, .05, 150);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = .08;
controls.minDistance = 3;
controls.maxDistance = 20;
controls.maxPolarAngle = Math.PI*.87;
controls.autoRotateSpeed = .6;
const target = new THREE.Vector3(0,.98,0);
controls.target.copy(target);
const environmentScene = new RoomEnvironment();
const pmrem = new THREE.PMREMGenerator(renderer);
const environment = pmrem.fromScene(environmentScene,.035);
scene.environment = environment.texture;
scene.environmentIntensity = .75;
environmentScene.dispose(); pmrem.dispose();
scene.add(new THREE.HemisphereLight('#eef5ff','#798598',.6));
const key = new THREE.DirectionalLight('#fff8ed',2.5);
key.position.set(-3,7,5); key.castShadow = true;
key.shadow.mapSize.set(2048,2048);
Object.assign(key.shadow.camera,{left:-5,right:5,top:5,bottom:-5,near:.1,far:20});
key.shadow.bias=-.0003;key.shadow.normalBias=.025;key.shadow.radius=4;
scene.add(key);
const fill = new THREE.DirectionalLight('#cfdeff',1.1);
fill.position.set(4,3,-4); scene.add(fill);
const floor = new THREE.Mesh(new THREE.PlaneGeometry(200,200),new THREE.ShadowMaterial({color:'#687a91',opacity:.18}));
floor.rotation.x=-Math.PI/2;floor.position.y=.085;floor.receiveShadow=true;scene.add(floor);
const padCanvas=document.createElement('canvas');padCanvas.width=padCanvas.height=1024;
const padContext=padCanvas.getContext('2d')!;
padContext.strokeStyle='#7993a4';padContext.fillStyle='#7993a4';padContext.lineCap='round';
padContext.lineWidth=5;padContext.beginPath();padContext.arc(512,512,438,0,Math.PI*2);padContext.stroke();
padContext.lineWidth=4;padContext.setLineDash([20,28]);padContext.beginPath();padContext.arc(512,512,352,0,Math.PI*2);padContext.stroke();padContext.setLineDash([]);
for(const angle of [0,Math.PI/2,Math.PI,Math.PI*1.5]){
 const cos=Math.cos(angle),sin=Math.sin(angle);
 padContext.lineWidth=10;padContext.beginPath();padContext.moveTo(512+cos*410,512+sin*410);padContext.lineTo(512+cos*462,512+sin*462);padContext.stroke();
}
padContext.lineWidth=24;padContext.beginPath();padContext.moveTo(452,424);padContext.lineTo(452,600);padContext.moveTo(572,424);padContext.lineTo(572,600);padContext.moveTo(452,512);padContext.lineTo(572,512);padContext.stroke();
padContext.font='600 26px "PingFang SC","Microsoft YaHei",sans-serif';padContext.textAlign='center';padContext.fillText('LANDING PAD 01',512,686);
const padTexture=new THREE.CanvasTexture(padCanvas);padTexture.colorSpace=THREE.SRGBColorSpace;padTexture.anisotropy=renderer.capabilities.getMaxAnisotropy();
const landingPad=new THREE.Mesh(new THREE.PlaneGeometry(2.8,2.8),new THREE.MeshBasicMaterial({map:padTexture,transparent:true,opacity:.55,depthWrite:false,toneMapped:false}));
landingPad.rotation.x=-Math.PI/2;landingPad.position.set(0,.087,.02);landingPad.renderOrder=1;scene.add(landingPad);
const altitudeLineGeometry=new THREE.BufferGeometry();
altitudeLineGeometry.setAttribute('position',new THREE.BufferAttribute(new Float32Array(6),3));
const altitudeLine=new THREE.Line(altitudeLineGeometry,new THREE.LineDashedMaterial({color:'#477995',dashSize:.06,gapSize:.05,transparent:true,opacity:0,depthWrite:false,toneMapped:false}));
altitudeLine.visible=false;altitudeLine.renderOrder=2;scene.add(altitudeLine);
const model=createSixAxisHexacopterModel();scene.add(model.root);

const padLampMaterial=new THREE.MeshStandardMaterial({color:'#d8eef7',emissive:'#5fd0ef',emissiveIntensity:.5,roughness:.4,metalness:.15});
const padLamps=new THREE.InstancedMesh(new THREE.CylinderGeometry(.055,.072,.032,20),padLampMaterial,4);
const lampMatrix=new THREE.Matrix4();
for(const [index,[x,z]] of [[-1.42,-1.42],[1.42,-1.42],[-1.42,1.42],[1.42,1.42]].entries()){
 lampMatrix.makeTranslation(x,.101,.02+z);padLamps.setMatrixAt(index,lampMatrix);
}
padLamps.instanceMatrix.needsUpdate=true;padLamps.receiveShadow=true;scene.add(padLamps);

const blurCanvas=document.createElement('canvas');blurCanvas.width=blurCanvas.height=256;
const blurContext=blurCanvas.getContext('2d')!;
blurContext.translate(128,128);
const blurWash=blurContext.createRadialGradient(0,0,14,0,0,124);
blurWash.addColorStop(0,'rgba(90,108,121,0)');blurWash.addColorStop(.52,'rgba(90,108,121,.05)');blurWash.addColorStop(.86,'rgba(90,108,121,.16)');blurWash.addColorStop(1,'rgba(90,108,121,0)');
blurContext.fillStyle=blurWash;blurContext.fillRect(-128,-128,256,256);
blurContext.strokeStyle='#5a6c79';blurContext.lineCap='round';
for(let i=0;i<84;i++){
 const angle=i/84*Math.PI*2,inner=30+(i*37%70),outer=112+(i*23%16);
 blurContext.globalAlpha=.09+(i%5)*.022;blurContext.lineWidth=1.8+(i%4)*.7;
 blurContext.beginPath();blurContext.moveTo(Math.cos(angle)*inner,Math.sin(angle)*inner);blurContext.lineTo(Math.cos(angle)*outer,Math.sin(angle)*outer);blurContext.stroke();
}
blurContext.globalAlpha=.26;blurContext.lineWidth=2.2;blurContext.beginPath();blurContext.arc(0,0,121,0,Math.PI*2);blurContext.stroke();
const blurTexture=new THREE.CanvasTexture(blurCanvas);blurTexture.colorSpace=THREE.SRGBColorSpace;
const blurMaterial=new THREE.MeshBasicMaterial({map:blurTexture,transparent:true,opacity:0,depthWrite:false,side:THREE.DoubleSide,toneMapped:false});
const rotorBlur=model.rotors.map(rotor=>{
 const disc=new THREE.Mesh(new THREE.CircleGeometry(.9,48),blurMaterial);
 disc.rotation.x=-Math.PI/2;disc.position.y=.009;disc.renderOrder=2;disc.visible=false;rotor.add(disc);return disc;
});

const dustRings=Array.from({length:2},()=>{
 const dust=new THREE.Mesh(new THREE.RingGeometry(.34,.405,64),new THREE.MeshBasicMaterial({color:'#b7c5ce',transparent:true,opacity:0,depthWrite:false,side:THREE.DoubleSide,toneMapped:false}));
 dust.rotation.x=-Math.PI/2;dust.position.set(0,.091,.02);dust.renderOrder=3;dust.visible=false;scene.add(dust);return dust;
});

const tickMaterial=new THREE.LineBasicMaterial({color:'#477995',transparent:true,opacity:0,depthWrite:false,toneMapped:false});
const tickGeometry=new THREE.BufferGeometry();
tickGeometry.setAttribute('position',new THREE.Float32BufferAttribute([.5,1,1.5,2].flatMap(height=>[-.16,height,.02,.16,height,.02]),3));
const altitudeTicks=new THREE.LineSegments(tickGeometry,tickMaterial);
altitudeTicks.visible=false;altitudeTicks.renderOrder=2;scene.add(altitudeTicks);
const altitudeTickLabels=[.5,1,1.5,2].map(height=>{
 const node=document.createElement('span');node.className='altitude-tick';node.textContent=height.toFixed(1);node.hidden=true;viewport.append(node);
 return {height,point:new THREE.Vector3(.24,height,.02),node};
});

const frameCanvas=document.createElement('canvas');frameCanvas.width=frameCanvas.height=512;
const frameContext=frameCanvas.getContext('2d')!;
frameContext.strokeStyle='#2f7f9c';frameContext.lineWidth=8;frameContext.lineCap='square';
for(const [x,y,sx,sy] of [[0,0,1,1],[512,0,-1,1],[0,512,1,-1],[512,512,-1,-1]]){
 frameContext.beginPath();frameContext.moveTo(x+sx*64,y+sy*12);frameContext.lineTo(x+sx*12,y+sy*12);frameContext.lineTo(x+sx*12,y+sy*64);frameContext.stroke();
}
frameContext.lineWidth=3;frameContext.beginPath();frameContext.moveTo(228,256);frameContext.lineTo(284,256);frameContext.moveTo(256,228);frameContext.lineTo(256,284);frameContext.stroke();
frameContext.lineWidth=2;frameContext.globalAlpha=.5;frameContext.beginPath();frameContext.arc(256,256,96,0,Math.PI*2);frameContext.stroke();
const frameTexture=new THREE.CanvasTexture(frameCanvas);frameTexture.colorSpace=THREE.SRGBColorSpace;
const frameMaterial=new THREE.MeshBasicMaterial({map:frameTexture,transparent:true,opacity:0,depthWrite:false,toneMapped:false});
const cameraFrame=new THREE.Mesh(new THREE.PlaneGeometry(1,.96),frameMaterial);
cameraFrame.rotation.x=-Math.PI/2;cameraFrame.position.set(0,.092,1.55);cameraFrame.renderOrder=3;cameraFrame.visible=false;scene.add(cameraFrame);

const ringPulses=Array.from({length:2},()=>{
 const pulse=new THREE.Mesh(new THREE.RingGeometry(.16,.185,48),new THREE.MeshBasicMaterial({color:'#de5a1b',transparent:true,opacity:0,depthWrite:false,side:THREE.DoubleSide,toneMapped:false}));
 pulse.rotation.x=-Math.PI/2;pulse.position.set(0,.093,.06);pulse.renderOrder=4;pulse.visible=false;scene.add(pulse);return pulse;
});

const sectorMaterial=new THREE.MeshBasicMaterial({color:'#2f94b8',transparent:true,opacity:0,depthWrite:false,side:THREE.DoubleSide,toneMapped:false});
const speakerSector=new THREE.Mesh(new THREE.RingGeometry(.24,1.65,48,1,-Math.PI/2-.52,1.04),sectorMaterial);
speakerSector.rotation.x=-Math.PI/2;speakerSector.position.set(0,.091,.18);speakerSector.renderOrder=3;speakerSector.visible=false;scene.add(speakerSector);
const sectorArcGeometry=new THREE.BufferGeometry().setFromPoints(Array.from({length:26},(_,i)=>{
 const angle=-Math.PI/2-.52+1.04*i/25;return new THREE.Vector3(Math.cos(angle)*1.65,.093,.18-Math.sin(angle)*1.65);
}));
const sectorArcMaterial=new THREE.LineBasicMaterial({color:'#2f94b8',transparent:true,opacity:0,depthWrite:false,toneMapped:false});
const speakerArc=new THREE.Line(sectorArcGeometry,sectorArcMaterial);
speakerArc.visible=false;speakerArc.renderOrder=4;scene.add(speakerArc);

const calloutSvg=document.createElementNS('http://www.w3.org/2000/svg','svg');
calloutSvg.setAttribute('class','callout-lines');
const calloutSpecs=[
 {partId:'fuselage',label:'中央机身',dx:118,dy:-70},
 {partId:'antenna',label:'顶部天线',dx:126,dy:-20},
 {partId:'arm-1',label:'机臂 · 电机',dx:132,dy:24},
 {partId:'landing-gear',label:'滑橇起落架',dx:-124,dy:64},
];
const callouts=calloutSpecs.map(spec=>{
 const part=model.parts.find(p=>p.id===spec.partId)!;
 const node=document.createElement('button');node.type='button';node.className='part-callout';node.textContent=spec.label;node.hidden=true;node.onclick=()=>select(spec.partId);
 const line=document.createElementNS('http://www.w3.org/2000/svg','line');
 const dot=document.createElementNS('http://www.w3.org/2000/svg','circle');dot.setAttribute('r','2');
 calloutSvg.append(line,dot);viewport.append(node);
 return {...spec,part,node,line,dot};
});
calloutSvg.style.display='none';viewport.append(calloutSvg);

let spinning=false,labelsVisible=true,explosion=0,selected='',wireframe=false,cabin=false;
let payload:PayloadId='camera',triangleCount=0,meshCount=0;
type FlightPhase='grounded'|'ascending'|'hovering'|'descending';
type DemoId=Exclude<PayloadId,'none'>;
let flightPhase:FlightPhase='grounded',flightTime=0,flightAltitude=0,rotorLevel=0;
let activeDemo:DemoId|null=null,demoTime=0,demoStepIndex=-1,demoPaused=false;
let explodeAutoTarget:number|null=null,landingBounceTime=-1,battery=100,flightElapsed=0,dustTime=0,padPulse=0;
let batteryReadout='',telemetryReadout='';
type AirdropPhase='idle'|'dropping'|'landed';
let airdropPhase:AirdropPhase='idle',airdropTime=0,airdropRippleTime=0;
const FLIGHT_HEIGHT=2.1,TAKEOFF_TIME=4.2,LANDING_TIME=4,CAMERA_FOLLOW=.65;
const AIRDROP_PUSH=.55,AIRDROP_FALL=1.5;
const AIRDROP_TARGET=new THREE.Vector3(-.1,.144,1);
const airdropStart=new THREE.Vector3();
const demoScripts:Record<DemoId,{code:string;title:string;duration:number;steps:{at:number;label:string;caption:string}[]}>={
 camera:{code:'GC',title:'高清云台相机 · 取景教学',duration:7.2,steps:[
  {at:0,label:'云台自检',caption:'上电后三轴电机依次回中，前向 4K 镜头回到水平基准。'},
  {at:2.1,label:'偏航扫描',caption:'偏航电机左右转动，带动镜头扩大侧向观察范围。'},
  {at:4.4,label:'俯仰取景',caption:'俯仰轴下压锁定地面目标，状态灯同步闪烁。'},
 ]},
 ring:{code:'LR',title:'抛投式救生圈 · 释放教学',duration:7.4,steps:[
  {at:0,label:'解除锁定',caption:'释放手柄抬起，红色保险销退出快拆挂架锁孔。'},
  {at:2,label:'推出浮体',caption:'托架前倾，橙色浮体沿燕尾导轨滑出挂架。'},
  {at:3.5,label:'抛投演示',caption:'浮体脱离挂架下落，四段反光带保持朝上便于水面识别。'},
  {at:5.7,label:'教学复位',caption:'演示结束，浮体回到托架并重新锁定。'},
 ]},
 speaker:{code:'LS',title:'定向喊话器 · 广播教学',duration:7,steps:[
  {at:0,label:'上电自检',caption:'挂架供电，号角后部驱动单元进入待机状态。'},
  {at:2,label:'定向调整',caption:'号角绕挂点微调俯仰，对准前方目标区域。'},
  {at:3.6,label:'广播扩散',caption:'声波自号角口向外扩散，覆盖前下方扇形区域。'},
 ]}
};
const payloadInfo:Record<PayloadId,{title:string;description:string;note:string}>={
 camera:{title:'高清三轴云台相机',description:'三轴增稳云台挂载：偏航、横滚与俯仰三组电机，石墨灰相机壳体、前向 4K 镜头与侧向传感器。镜头朝前下方取景，可通过机腹快拆板整体拆换。',note:'三轴云台 · 4K 前向镜头，按市面同类机载相机近似重建。'},
 ring:{title:'抛投式救生圈',description:'橙色浮体救生圈配四段反光带与系绳环，由双挂钩和快拆托架固定；侧置小型气瓶对应市面常见的水上抛投方案，属于结构演示。',note:'抛投式救生圈 · 反光带与快拆托架；起飞悬停后可演示空中抛投，非认证救援设备。'},
 speaker:{title:'定向喊话器',description:'黑色喇叭形声学号角与后置驱动单元，向前下方倾斜安装；蓝色快拆板与碳纤维吊架连接机腹挂架，背部带状态指示灯。',note:'定向喊话器 · 号角朝前下方，仅作结构演示。'},
 none:{title:'机腹快拆挂架',description:'碳纤维底板、蓝色快拆板、双燕尾导轨与带保险销的释放手柄。当前未安装任务载荷，可随时挂载救生圈、喊话器或三轴云台相机。',note:'快拆挂架空载状态，保留全部安装接口。'},
};
let toastTimer=0;
function toast(text:string){clearTimeout(toastTimer);el('toast').textContent=text;toastTimer=window.setTimeout(()=>el('toast').textContent='',3200);}
const highlight = new THREE.BoxHelper(model.root, '#6798b9');
(highlight.material as THREE.LineBasicMaterial).transparent=true;
(highlight.material as THREE.LineBasicMaterial).opacity=.45;
highlight.visible=false;scene.add(highlight);
const labels = model.parts.filter(p=>p.id.startsWith('arm-')).map(p=>{
 const node=document.createElement('button');node.type='button';node.className='label';node.textContent=p.id.slice(4).padStart(2,'0');node.setAttribute('aria-label',p.title);node.style.pointerEvents='auto';node.onclick=()=>select(p.id);viewport.append(node);return {p,node};
});
const dropMarker=new THREE.Mesh(new THREE.RingGeometry(.28,.315,64),new THREE.MeshBasicMaterial({color:'#de5a1b',transparent:true,opacity:0,depthWrite:false,side:THREE.DoubleSide,toneMapped:false}));
dropMarker.rotation.x=-Math.PI/2;dropMarker.position.set(0,.09,.02);dropMarker.visible=false;dropMarker.renderOrder=3;scene.add(dropMarker);
const cameraGlow=new THREE.Sprite(new THREE.SpriteMaterial({color:'#6cddf7',transparent:true,opacity:0,depthWrite:false,toneMapped:false}));
cameraGlow.position.set(-.06,.066,.109);cameraGlow.scale.set(.05,.05,1);cameraGlow.visible=false;model.payloadRig.cameraHead.add(cameraGlow);
const waveZ=new THREE.Vector3(0,0,1);
const speakerWaves=Array.from({length:3},()=>{
 const material=new THREE.MeshBasicMaterial({color:'#2f94b8',transparent:true,opacity:0,depthWrite:false,side:THREE.DoubleSide,toneMapped:false});
 const wave=new THREE.Mesh(new THREE.TorusGeometry(.15,.0065,6,48),material);
 wave.quaternion.setFromUnitVectors(waveZ,model.payloadRig.speakerDirection);
 wave.position.copy(model.payloadRig.speakerDirection).multiplyScalar(.335);
 wave.visible=false;wave.renderOrder=3;model.payloadRig.speakerHead.add(wave);return wave;
});
const zoneCanvas=document.createElement('canvas');zoneCanvas.width=zoneCanvas.height=512;
const zoneContext=zoneCanvas.getContext('2d')!;
zoneContext.strokeStyle='#de5a1b';zoneContext.lineWidth=9;zoneContext.setLineDash([30,22]);
zoneContext.beginPath();zoneContext.arc(256,256,198,0,Math.PI*2);zoneContext.stroke();
zoneContext.setLineDash([]);zoneContext.lineWidth=4;
for(let i=0;i<4;i++){
 const angle=i*Math.PI/2+Math.PI/4;
 zoneContext.beginPath();zoneContext.moveTo(256+Math.cos(angle)*160,256+Math.sin(angle)*160);zoneContext.lineTo(256+Math.cos(angle)*218,256+Math.sin(angle)*218);zoneContext.stroke();
}
zoneContext.beginPath();zoneContext.moveTo(228,256);zoneContext.lineTo(284,256);zoneContext.moveTo(256,228);zoneContext.lineTo(256,284);zoneContext.stroke();
const zoneTexture=new THREE.CanvasTexture(zoneCanvas);zoneTexture.colorSpace=THREE.SRGBColorSpace;zoneTexture.anisotropy=renderer.capabilities.getMaxAnisotropy();
const zoneMaterial=new THREE.MeshBasicMaterial({map:zoneTexture,transparent:true,opacity:0,depthWrite:false,toneMapped:false});
const dropZone=new THREE.Mesh(new THREE.PlaneGeometry(.8,.8),zoneMaterial);
dropZone.rotation.x=-Math.PI/2;dropZone.position.copy(AIRDROP_TARGET).setY(.092);dropZone.renderOrder=3;dropZone.visible=false;scene.add(dropZone);
const airdropRipples=Array.from({length:2},()=>{
 const ripple=new THREE.Mesh(new THREE.RingGeometry(.05,.064,48),new THREE.MeshBasicMaterial({color:'#e07030',transparent:true,opacity:0,depthWrite:false,side:THREE.DoubleSide,toneMapped:false}));
 ripple.rotation.x=-Math.PI/2;ripple.position.copy(AIRDROP_TARGET).setY(.093);ripple.renderOrder=4;ripple.visible=false;scene.add(ripple);return ripple;
});
const smooth01=(value:number)=>{const t=THREE.MathUtils.clamp(value,0,1);return t*t*(3-2*t);};
function select(id:string){
 const p=model.parts.find(p=>p.id===id);selected=p?.id??'';
 const info=p?.id==='payload'?payloadInfo[payload]:null;
 el('selected-title').textContent=info?.title??p?.title??'整机总览';
 el('selected-description').textContent=info?.description??p?.description??'选择模型或下方部件，查看六轴无人机的结构细节。';
 document.querySelectorAll<HTMLButtonElement>('[data-part]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.part===selected)));
 highlight.visible=!!p&&p.group.visible;if(p)highlight.setFromObject(p.group);
 if(selected==='antenna'&&cabin)toast('顶部天线随上舱盖一同移除；关闭“舱内结构”可查看完整外观');
 labels.forEach(l=>l.node.classList.toggle('selected',l.p.id===selected));
}
function view(name:string,immediate=false){
 controls.autoRotate=false;el('auto-toggle').setAttribute('aria-pressed','false');
 const scale=Math.max(1,1.25/camera.aspect);
 const distanceScale=scale*(1+explosion*.26);
 const lift=name==='airdrop'?0:model.root.position.y*CAMERA_FOLLOW;
 const views:Record<string,{position:[number,number,number];target:THREE.Vector3}>={
  perspective:{position:[-4.8,3.9,6.2],target},top:{position:[0,10.8,.001],target},front:{position:[0,2.05,10.6],target},side:{position:[10.6,2.15,0],target},
  payload:{position:[-2.6,1.6,3.35],target:new THREE.Vector3(0,.74,.04)},
  airdrop:{position:[-5.8,4.6,10.6],target:new THREE.Vector3(-.15,1.15,.65)},
  launch:{position:[-5.2,.85,7.4],target:new THREE.Vector3(0,1.12,0)},
  'demo-camera':{position:[-1.8,1.42,7.4],target:new THREE.Vector3(0,.45,.48)},
  'demo-ring':{position:[-1.1,1.38,7.4],target:new THREE.Vector3(0,.42,.45)},
  'demo-speaker':{position:[-1.8,1.5,7.2],target:new THREE.Vector3(0,.4,.55)},
 };
 const v=views[name]??views.perspective;
 const viewTarget=v.target.clone().setY(v.target.y+lift);
 camera.position.set(...v.position);camera.position.y+=lift;
 camera.position.sub(viewTarget).multiplyScalar(distanceScale).add(viewTarget);
 controls.target.copy(viewTarget);camera.up.set(0,1,0);controls.update();
 document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach(b=>{const on=b.dataset.view===name;b.classList.toggle('active',on);b.setAttribute('aria-pressed',String(on));});
 if(immediate)renderer.render(scene,camera);
}
function syncCabin(){
 model.setCabinOpen(cabin);
 model.setInteriorVisible(cabin||wireframe);
 const antenna=model.parts.find(p=>p.id==='antenna');
 if(antenna)antenna.group.visible=!cabin;
}
function setWireframe(enabled:boolean){
 wireframe=enabled;
 model.setWireframe(enabled);
 scenePanel.classList.toggle('is-wireframe',enabled);
 syncCabin();
}
const phaseLabels:Record<FlightPhase,string>={grounded:'地面待机',ascending:'旋翼启动 · 爬升',hovering:'空中悬停',descending:'下降 · 对准起降点'};
let flightReadout='',flightProgress=-1;
function updateFlightReadout(force=false){
 const altitude=model.root.position.y,text=altitude.toFixed(1);
 if(force||text!==flightReadout){flightReadout=text;el('flight-altitude').textContent=text;el('flight-hud-altitude').textContent=text;}
 const progress=Math.round(THREE.MathUtils.clamp(altitude/FLIGHT_HEIGHT,0,1)*100);
 if(force||progress!==flightProgress){flightProgress=progress;el('flight-progress').style.width=`${progress}%`;}
}
function updateTelemetry(force=false){
 const value=Math.max(0,Math.round(battery));
 if(force||String(value)!==batteryReadout){
  batteryReadout=String(value);
  const node=el('flight-hud-battery');
  node.textContent=String(value);node.classList.toggle('low-battery',value<25);
 }
 const seconds=Math.floor(flightElapsed);
 const text=`${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;
 if(force||text!==telemetryReadout){telemetryReadout=text;el('flight-hud-time').textContent=text;}
}
function syncFlightUI(){
 const airborne=flightPhase!=='grounded';
 const button=el<HTMLButtonElement>('flight-toggle');
 button.disabled=flightPhase==='ascending'||flightPhase==='descending'||airdropPhase==='dropping';
 button.setAttribute('aria-pressed',String(airborne));
 el('flight-toggle-label').textContent={grounded:'一键起飞',ascending:'正在起飞',hovering:'一键降落',descending:'正在降落'}[flightPhase];
 el('flight-phase').textContent=phaseLabels[flightPhase];
 el('flight-hud-phase').textContent=phaseLabels[flightPhase];
 el('flight-hud').hidden=!airborne;
 el('flight-hud').classList.toggle('is-airborne',airborne);
 el<HTMLButtonElement>('spin-toggle').disabled=airborne;
 el('spin-toggle').setAttribute('aria-pressed',String(spinning));
 updateFlightReadout(true);updateTelemetry(true);
 syncAirdropUI();
}
function startFlight(){
 if(activeDemo)stopDemo(false);
 spinning=false;
 explodeAutoTarget=null;if(explosion>.001)applyExplosion(0,false);
 flightPhase='ascending';flightTime=0;flightAltitude=0;flightElapsed=0;model.root.position.y=0;
 updateAltitudeLine();view('launch');select('');syncFlightUI();
 toast(payload==='ring'&&airdropPhase==='idle'?'起飞演示：爬升至悬停后，可点击“抛投救生圈”演示空中救援':airdropPhase==='landed'?'起飞演示：已投放的救生圈留在停机坪':'起飞演示：旋翼启动，模型爬升至悬停高度');
}
function landFlight(){
 if(flightPhase!=='hovering')return;
 flightPhase='descending';flightTime=0;syncFlightUI();
 toast('降落演示：模型下降并对准起降点');
}
function updateFlight(dt:number){
 if(flightPhase==='grounded'){updateFlightReadout();return;}
 flightElapsed+=dt;battery=Math.max(0,battery-.42*dt);updateTelemetry();
 const before=model.root.position.y;
 if(flightPhase==='ascending'){
  flightTime+=dt;
  const t=THREE.MathUtils.clamp((flightTime-.65)/(TAKEOFF_TIME-.65),0,1);
  flightAltitude=FLIGHT_HEIGHT*(t*t*(3-2*t));
  if(flightTime>=TAKEOFF_TIME){flightPhase='hovering';flightTime=0;flightAltitude=FLIGHT_HEIGHT;syncFlightUI();toast('已到达悬停高度，可点击“一键降落”');}
 }else if(flightPhase==='hovering'){
  flightTime+=dt;flightAltitude=FLIGHT_HEIGHT+Math.sin(flightTime*1.25)*.03;
 }else{
  flightTime+=dt;
  if(flightTime>=LANDING_TIME){
   flightAltitude=0;flightPhase='grounded';flightTime=0;landingBounceTime=0;syncFlightUI();toast('已模拟接地，旋翼停转');
  }else{
   const t=flightTime/LANDING_TIME;flightAltitude=FLIGHT_HEIGHT*(1-t*t*(3-2*t));
  }
 }
 model.root.position.y=Math.max(0,flightAltitude);
 const delta=model.root.position.y-before;
 camera.position.y+=delta*CAMERA_FOLLOW;controls.target.y+=delta*CAMERA_FOLLOW;
 updateFlightReadout();updateAltitudeLine();
}
function updateAltitudeLine(){
 const altitude=model.root.position.y;
 const attribute=altitudeLine.geometry.getAttribute('position') as THREE.BufferAttribute;
 attribute.setXYZ(0,0,.09,.02);attribute.setXYZ(1,0,altitude+.06,.02);attribute.needsUpdate=true;
 altitudeLine.geometry.computeBoundingSphere();altitudeLine.computeLineDistances();
 const material=altitudeLine.material as THREE.LineDashedMaterial;
 material.opacity=THREE.MathUtils.clamp((altitude-.02)/.5,0,1)*.6;
 altitudeLine.visible=material.opacity>.01;
}
function updateEffects(dt:number){
 const airborne=flightPhase!=='grounded',altitude=model.root.position.y;
 padPulse+=dt*(airborne?3.4:1.1);
 padLampMaterial.emissiveIntensity=airborne?.95+.35*Math.sin(padPulse):.5;
 const nearGround=THREE.MathUtils.clamp(1-altitude/1.15,0,1);
 const touchdown=landingBounceTime>=0?Math.max(0,1-landingBounceTime/.75):0;
 const dustStrength=Math.max(nearGround*nearGround*(airborne?.6:0),touchdown*.85);
 dustTime+=dt;
 dustRings.forEach((dust,index)=>{
  const phase=(dustTime*.8+index*.45)%1;
  dust.visible=dustStrength>.015;
  dust.scale.setScalar(.55+phase*2.7);
  (dust.material as THREE.MeshBasicMaterial).opacity=dustStrength*.5*(1-phase);
 });
 const tickGate=THREE.MathUtils.clamp((altitude-.12)/.32,0,1);
 tickMaterial.opacity=tickGate*.55;altitudeTicks.visible=tickGate>.01;
 const blurPower=THREE.MathUtils.clamp((rotorLevel-.15)/1.4,0,1);
 blurMaterial.opacity=.52*blurPower;
 rotorBlur.forEach(disc=>disc.visible=blurPower>.02);
 const gear=model.parts.find(p=>p.id==='landing-gear')!.group;
 if(landingBounceTime>=0){
  landingBounceTime+=dt;
  const t=landingBounceTime/.85;
  if(t>=1){landingBounceTime=-1;gear.scale.set(1,1,1);}
  else{const squash=Math.sin(t*Math.PI);gear.scale.set(1+.014*squash,1-.05*squash,1+.014*squash);}
 }else gear.scale.set(1,1,1);
}
function updateAltitudeLabels(){
 for(const {point,node} of altitudeTickLabels){
  if(!altitudeTicks.visible){node.hidden=true;continue;}
  const v=point.clone().project(camera);
  node.hidden=v.z>1||v.z<0;
  if(node.hidden)continue;
  node.style.left=`${(v.x*.5+.5)*viewport.clientWidth}px`;
  node.style.top=`${(-v.y*.5+.5)*viewport.clientHeight}px`;
 }
}
function updateCallouts(){
 const alpha=labelsVisible&&!activeDemo&&flightPhase==='grounded'?THREE.MathUtils.clamp((explosion-.16)/.22,0,1):0;
 calloutSvg.style.display=alpha>.01?'block':'none';
 for(const callout of callouts){
  const visible=alpha>.01&&callout.part.group.visible;
  callout.node.hidden=!visible;
  if(!visible){callout.line.style.opacity='0';callout.dot.style.opacity='0';continue;}
  const anchor=callout.part.group.localToWorld(callout.part.anchor.clone()).project(camera);
  if(anchor.z>1||anchor.z<0){callout.node.hidden=true;callout.line.style.opacity='0';callout.dot.style.opacity='0';continue;}
  const ax=(anchor.x*.5+.5)*viewport.clientWidth,ay=(-anchor.y*.5+.5)*viewport.clientHeight;
  const cx=THREE.MathUtils.clamp(ax+callout.dx,74,viewport.clientWidth-74);
  const cy=THREE.MathUtils.clamp(ay+callout.dy,28,viewport.clientHeight-28);
  callout.node.style.left=`${cx}px`;callout.node.style.top=`${cy}px`;callout.node.style.opacity=String(alpha);
  callout.line.setAttribute('x1',String(ax));callout.line.setAttribute('y1',String(ay));
  callout.line.setAttribute('x2',String(cx));callout.line.setAttribute('y2',String(cy));
  callout.line.style.opacity=String(alpha*.9);
  callout.dot.setAttribute('cx',String(ax));callout.dot.setAttribute('cy',String(ay));callout.dot.style.opacity=String(alpha*.9);
 }
}
function syncAirdropUI(){
 const button=el<HTMLButtonElement>('airdrop-toggle'),label=el('airdrop-label');
 const dropping=airdropPhase==='dropping';
 const recoverable=airdropPhase==='landed'&&flightPhase==='grounded';
 const armed=flightPhase==='hovering'&&payload==='ring'&&airdropPhase==='idle';
 button.hidden=!(dropping||armed||recoverable);
 button.disabled=dropping;
 button.classList.toggle('is-recover',recoverable);
 button.classList.toggle('is-dropping',dropping);
 label.textContent=dropping?'正在抛投':recoverable?'收回救生圈':'抛投救生圈';
 button.setAttribute('aria-label',dropping?'救生圈正在抛投':recoverable?'收回已投放的救生圈':'抛投救生圈');
 syncDemoButton();
}
function setRingShadow(enabled:boolean){
 model.payloadRig.ringFloat.traverse(child=>{if(child instanceof THREE.Mesh)child.castShadow=enabled;});
}
function recoverRing(announce=false){
 const rig=model.payloadRig;
 if(rig.ringFloat.parent!==rig.ringAssembly)rig.ringAssembly.attach(rig.ringFloat);
 rig.ringFloat.position.set(0,.615,.02);rig.ringFloat.rotation.set(0,0,0);rig.ringFloat.scale.set(1,1,1);
 rig.ringAssembly.position.set(0,0,0);rig.ringAssembly.rotation.set(0,0,0);
 rig.releaseLever.rotation.set(0,0,0);
 setRingShadow(false);
 zoneMaterial.opacity=0;dropZone.visible=false;
 airdropRipples.forEach(ripple=>{ripple.visible=false;(ripple.material as THREE.MeshBasicMaterial).opacity=0;});
 airdropPhase='idle';airdropTime=0;airdropRippleTime=0;
 syncAirdropUI();
 if(announce)toast('救生圈已收回挂架并重新锁定');
}
function startAirdrop(){
 if(payload!=='ring'||flightPhase!=='hovering'||airdropPhase!=='idle'||activeDemo)return;
 airdropPhase='dropping';airdropTime=0;airdropRippleTime=0;
 zoneMaterial.opacity=.62;dropZone.visible=true;
 airdropRipples.forEach(ripple=>{ripple.visible=false;(ripple.material as THREE.MeshBasicMaterial).opacity=0;});
 select('');view('airdrop');syncFlightUI();
 toast('空中救援演示：解除挂架锁，救生圈脱离并落向目标圈');
}
function updateAirdrop(dt:number){
 if(airdropPhase==='idle')return;
 const rig=model.payloadRig;
 if(airdropPhase==='dropping'){
  airdropTime+=dt;
  const push=smooth01(airdropTime/AIRDROP_PUSH);
  rig.releaseLever.rotation.x=-.34*push;
  rig.ringAssembly.position.set(0,-.02*push,.35*push);
  if(airdropTime>=AIRDROP_PUSH){
   if(rig.ringFloat.parent===rig.ringAssembly){
    model.root.updateMatrixWorld(true);
    scene.attach(rig.ringFloat);
    setRingShadow(true);
    airdropStart.copy(rig.ringFloat.position);
   }
   const t=THREE.MathUtils.clamp((airdropTime-AIRDROP_PUSH)/AIRDROP_FALL,0,1);
   const lateral=smooth01(t);
   rig.ringFloat.position.set(
    THREE.MathUtils.lerp(airdropStart.x,AIRDROP_TARGET.x,lateral),
    THREE.MathUtils.lerp(airdropStart.y,AIRDROP_TARGET.y,t*t),
    THREE.MathUtils.lerp(airdropStart.z,AIRDROP_TARGET.z,lateral)
   );
   if(reducedMotion){
    rig.ringFloat.rotation.set(0,0,0);
   }else{
    const decay=1-t;
    rig.ringFloat.rotation.set(Math.sin(t*Math.PI*3.1)*.42*decay,t*Math.PI*.6,Math.sin(t*Math.PI*2.3+.6)*.34*decay);
   }
   zoneMaterial.opacity=.5+.18*Math.sin(airdropTime*9);
   if(t>=1){
    rig.ringFloat.position.copy(AIRDROP_TARGET);
    rig.ringFloat.rotation.set(0,rig.ringFloat.rotation.y,0);
    airdropPhase='landed';airdropRippleTime=0;zoneMaterial.opacity=.66;
    syncFlightUI();
    toast('救生圈已落入目标圈，可继续观察或一键降落');
   }
  }
 }else{
  airdropRippleTime+=dt;
  airdropRipples.forEach((ripple,index)=>{
   const phase=(airdropRippleTime*1.35+index*.5)%1;
   ripple.visible=airdropRippleTime<1.6;
   ripple.scale.setScalar(.8+phase*4.2);
   (ripple.material as THREE.MeshBasicMaterial).opacity=.55*(1-phase);
  });
  zoneMaterial.opacity=.62+.08*Math.sin(airdropRippleTime*2.2);
 }
}
function syncDemoButton(){
 const button=el<HTMLButtonElement>('payload-demo');
 const blocked=airdropPhase!=='idle';
 button.disabled=payload==='none'||blocked;
 button.setAttribute('aria-pressed',String(!!activeDemo));
 el('payload-demo-label').textContent=activeDemo?'结束载荷教学':blocked?(payload==='ring'&&airdropPhase==='dropping'?'空中抛投中':'救生圈已投放'):payload==='none'?'请先选择载荷':'播放载荷教学';
}
function syncPauseButton(){
 const paused=!!activeDemo&&demoPaused;
 const button=el<HTMLButtonElement>('tutorial-pause');
 button.disabled=!activeDemo;
 button.setAttribute('aria-pressed',String(paused));
 button.setAttribute('aria-label',paused?'继续教学':'暂停教学');
 button.title=paused?'继续教学':'暂停教学';
 button.querySelector('use')?.setAttribute('href',paused?'#icon-play':'#icon-pause');
}
function setDemoPaused(paused:boolean){
 if(!activeDemo)return;
 demoPaused=paused;syncPauseButton();
}
function setDemoStep(index:number){
 if(index===demoStepIndex)return;
 demoStepIndex=index;
 if(!activeDemo)return;
 const items=[...document.querySelectorAll<HTMLElement>('#tutorial-steps li')];
 items.forEach((item,i)=>{item.classList.toggle('is-active',i===index);item.classList.toggle('is-done',i<index);});
 el('tutorial-caption').textContent=demoScripts[activeDemo].steps[index]?.caption??'';
}
function resetDemoTransforms(){
 const rig=model.payloadRig;
 rig.releaseLever.rotation.set(0,0,0);
 rig.ringAssembly.position.set(0,0,0);rig.ringAssembly.rotation.set(0,0,0);
 rig.cameraHead.rotation.set(0,0,0);
 rig.speakerHead.rotation.set(0,0,0);
 cameraGlow.visible=false;(cameraGlow.material as THREE.SpriteMaterial).opacity=0;
 speakerWaves.forEach(wave=>{wave.visible=false;wave.scale.set(1,1,1);(wave.material as THREE.MeshBasicMaterial).opacity=0;});
 dropMarker.visible=false;(dropMarker.material as THREE.MeshBasicMaterial).opacity=0;
 frameMaterial.opacity=0;cameraFrame.visible=false;
 ringPulses.forEach(pulse=>{pulse.visible=false;(pulse.material as THREE.MeshBasicMaterial).opacity=0;pulse.scale.setScalar(1);});
 sectorMaterial.opacity=0;sectorArcMaterial.opacity=0;speakerSector.visible=false;speakerArc.visible=false;
}
function startDemo(){
 if(airdropPhase!=='idle'){toast('请先收回已投放的救生圈，再播放地面教学');return;}
 if(payload==='none'){toast('请先选择一项任务载荷，再播放教学');return;}
 if(flightPhase!=='grounded'){toast('请先完成降落，再播放载荷教学');return;}
 const id=payload as DemoId;
 explodeAutoTarget=null;if(explosion>.001)applyExplosion(0,false);
 activeDemo=id;demoTime=0;demoStepIndex=-1;demoPaused=false;
 resetDemoTransforms();select('payload');highlight.visible=false;view(`demo-${id}`);
 const script=demoScripts[id],list=el('tutorial-steps');
 list.replaceChildren();
 script.steps.forEach((step,index)=>{
  const item=document.createElement('li'),code=document.createElement('span');
  code.textContent=String(index+1).padStart(2,'0');item.append(code,document.createTextNode(step.label));list.append(item);
 });
 el('tutorial').hidden=false;
 el('tutorial-code').textContent=script.code;
 el('tutorial-title').textContent=script.title;
 el('tutorial-progress').style.width='0%';
 setDemoStep(0);syncDemoButton();syncPauseButton();
 if(matchMedia('(max-width: 760px)').matches)scenePanel.scrollIntoView({block:'start',behavior:reducedMotion?'auto':'smooth'});
 toast(`开始${script.title}`);
}
function stopDemo(announce=true){
 const previous=activeDemo;
 activeDemo=null;demoTime=0;demoStepIndex=-1;demoPaused=false;
 resetDemoTransforms();el('tutorial').hidden=true;syncDemoButton();syncPauseButton();
 if(selected==='payload')select('payload');
 if(previous&&announce)toast('载荷教学已结束');
}
function updateDemo(dt:number){
 if(!activeDemo||demoPaused)return;
 demoTime+=dt;
 const script=demoScripts[activeDemo];
 let step=0;for(let i=0;i<script.steps.length;i++)if(demoTime>=script.steps[i].at)step=i;
 setDemoStep(step);
 el('tutorial-progress').style.width=`${THREE.MathUtils.clamp(demoTime/script.duration,0,1)*100}%`;
 const rig=model.payloadRig;
 if(activeDemo==='ring'){
  const release=smooth01(demoTime/1.2)*(1-smooth01((demoTime-5.4)/.9));
  rig.releaseLever.rotation.x=-.34*release;
  const slide=smooth01((demoTime-1.6)/1.4),drop=smooth01((demoTime-3.2)/1.7),restore=smooth01((demoTime-5.5)/1.1);
  rig.ringAssembly.position.set(0,-(.10*slide+.36*drop)*(1-restore),.05*slide*(1-restore));
  rig.ringAssembly.rotation.set(0,.5*drop*(1-restore),.08*drop*(1-restore));
  dropMarker.visible=drop>0&&restore<1;
  (dropMarker.material as THREE.MeshBasicMaterial).opacity=(.22+.16*Math.sin(demoTime*6))*(1-restore);
  dropMarker.rotation.z+=dt*.5;
  const pulseGate=smooth01((demoTime-2.3)/.7)*(1-smooth01((demoTime-5.4)/.7));
  ringPulses.forEach((pulse,index)=>{
   pulse.visible=pulseGate>.01;
   const phase=(demoTime*.85+index*.5)%1;
   pulse.scale.setScalar(.8+phase*2.4);
   (pulse.material as THREE.MeshBasicMaterial).opacity=.6*(1-phase)*pulseGate;
  });
 }else if(activeDemo==='camera'){
  const scan=smooth01((demoTime-.8)/.7)*(1-smooth01((demoTime-4.2)/.7));
  const pitch=smooth01((demoTime-3.8)/.8)*(1-smooth01((demoTime-6.1)/.7));
  rig.cameraHead.rotation.y=Math.sin((demoTime-1)*1.45)*.55*scan;
  rig.cameraHead.rotation.x=-.26*pitch+Math.sin(demoTime*1.2)*.025*scan;
  const blink=(Math.sin(demoTime*9)>0?.55:.12)*(1-smooth01((demoTime-6.4)/.6));
  cameraGlow.visible=blink>0;(cameraGlow.material as THREE.SpriteMaterial).opacity=blink;
  frameMaterial.opacity=.85*smooth01((demoTime-.6)/.7)*(1-smooth01((demoTime-5.6)/.8));
  cameraFrame.visible=frameMaterial.opacity>.01;
 }else{
  const aim=smooth01((demoTime-1.4)/.8)*(1-smooth01((demoTime-5.8)/.7));
  rig.speakerHead.rotation.x=Math.sin(demoTime*.9)*.06*aim;
  rig.speakerHead.rotation.y=Math.sin(demoTime*.65)*.035*aim;
  const gate=smooth01((demoTime-3.2)/.6)*(1-smooth01((demoTime-6.2)/.6));
  speakerWaves.forEach((wave,index)=>{
   const phase=(demoTime*1.2+index/3)%1;
   wave.visible=gate>.01;
   wave.scale.setScalar(.7+phase*1.9);
   (wave.material as THREE.MeshBasicMaterial).opacity=.46*(1-phase)*gate;
  });
  const sectorGate=smooth01((demoTime-3.2)/.7)*(1-smooth01((demoTime-6.3)/.7));
  speakerSector.visible=sectorGate>.01;speakerArc.visible=speakerSector.visible;
  sectorMaterial.opacity=(.17+.05*Math.sin(demoTime*5))*sectorGate;
  sectorArcMaterial.opacity=.7*sectorGate;
 }
 if(demoTime>=script.duration)stopDemo(true);
}
function applyPayload(id:PayloadId,announce=false){
 if(id!==payload&&flightPhase!=='grounded'){toast('飞行中不可更换载荷，请先降落');return false;}
 if(id!==payload&&airdropPhase!=='idle')recoverRing(false);
 if(activeDemo)stopDemo(false);
 payload=id;model.setPayload(id);
 document.querySelectorAll<HTMLButtonElement>('[data-payload]').forEach(b=>{const on=b.dataset.payload===id;b.classList.toggle('active',on);b.setAttribute('aria-pressed',String(on));});
 el('payload-note').textContent=payloadInfo[id].note;
 if(selected==='payload')select('payload');
 syncDemoButton();syncAirdropUI();updateStats();
 if(announce)toast(id==='none'?'已卸下任务载荷，快拆挂架保留':`已挂载${payloadInfo[id].title}`);
 return true;
}
function applyExplosion(value:number,scaleCamera=true){
 const previous=explosion;
 explosion=THREE.MathUtils.clamp(value,0,1);
 model.setExplode(explosion);
 if(scaleCamera)camera.position.sub(controls.target).multiplyScalar((1+explosion*.26)/(1+previous*.26)).add(controls.target);
 el<HTMLInputElement>('explode').value=String(Math.round(explosion*100));
 el('explode-value').textContent=`${Math.round(explosion*100)}%`;
 syncExplodeAutoButton();
}
function syncExplodeAutoButton(){
 const button=el<HTMLButtonElement>('explode-auto');
 button.setAttribute('aria-pressed',String(explodeAutoTarget!==null));
 button.textContent=explodeAutoTarget!==null?'停止':explosion>.98?'复位':'自动';
}
function updateExplode(dt:number){
 if(explodeAutoTarget===null)return;
 const next=THREE.MathUtils.damp(explosion,explodeAutoTarget,2.1,dt);
 if(Math.abs(next-explodeAutoTarget)<.003){
  applyExplosion(explodeAutoTarget);explodeAutoTarget=null;syncExplodeAutoButton();
 }else applyExplosion(next);
}
function updateStats(){
 triangleCount=0;meshCount=0;
 model.root.traverse(o=>{if(o instanceof THREE.Mesh){meshCount++;triangleCount+=(o.geometry.index?.count??o.geometry.attributes.position.count)/3*(o instanceof THREE.InstancedMesh?o.count:1);}});
 el('stats-triangles').textContent=Math.round(triangleCount).toLocaleString();el('stats-parts').textContent=String(model.parts.length);
}
function reset(){
 if(activeDemo)stopDemo(false);
 recoverRing(false);
 spinning=false;labelsVisible=true;cabin=false;rotorLevel=0;demoPaused=false;
 explodeAutoTarget=null;flightElapsed=0;battery=100;landingBounceTime=-1;
 flightPhase='grounded';flightTime=0;flightAltitude=0;model.root.position.y=0;updateAltitudeLine();
 setWireframe(false);
 const gear=model.parts.find(p=>p.id==='landing-gear')!.group;gear.visible=true;gear.scale.set(1,1,1);
 model.rotors.forEach(r=>r.rotation.y=r.userData.initialAngle);
 el<HTMLInputElement>('gear-toggle').checked=true;el<HTMLInputElement>('wire-toggle').checked=false;el<HTMLInputElement>('cabin-toggle').checked=false;el<HTMLInputElement>('labels-toggle').checked=true;
 applyPayload('camera');
 applyExplosion(0,false);
 el('spin-toggle').setAttribute('aria-pressed','false');syncFlightUI();select('');view('perspective');syncPauseButton();
}
const raycaster=new THREE.Raycaster(),pointer=new THREE.Vector2();
let down=[0,0];
renderer.domElement.addEventListener('pointerdown',e=>down=[e.clientX,e.clientY]);
renderer.domElement.addEventListener('pointerup',e=>{
 if(Math.hypot(e.clientX-down[0],e.clientY-down[1])>5)return;
 const r=renderer.domElement.getBoundingClientRect();pointer.set((e.clientX-r.left)/r.width*2-1,-(e.clientY-r.top)/r.height*2+1);raycaster.setFromCamera(pointer,camera);
 const hit=raycaster.intersectObjects(model.parts.filter(p=>p.group.visible).map(p=>p.group),true)[0];
 if(!hit){select('');return;}let object:THREE.Object3D|null=hit.object;
 while(object&&!object.userData.partId)object=object.parent;
 select(object?.userData.partId??'');
});
renderer.domElement.addEventListener('keydown',e=>{
 if(e.key==='Escape'){select('');return;}
 const directions:Record<string,number>={ArrowLeft:-.13,ArrowRight:.13};
 if(e.key in directions){const offset=camera.position.clone().sub(controls.target);offset.applyAxisAngle(new THREE.Vector3(0,1,0),directions[e.key]);camera.position.copy(controls.target).add(offset);e.preventDefault();}
 if(e.key==='+'||e.key==='-'){camera.position.sub(controls.target).multiplyScalar(e.key==='+'?.9:1.1).add(controls.target);e.preventDefault();}
});
document.querySelectorAll<HTMLButtonElement>('[data-part]').forEach(b=>b.onclick=()=>select(b.dataset.part!));
document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach(b=>b.onclick=()=>view(b.dataset.view!));
document.querySelectorAll<HTMLButtonElement>('[data-payload]').forEach(b=>b.onclick=()=>{if(applyPayload(b.dataset.payload as PayloadId,true))select('payload');});
el('selection-clear').onclick=()=>select('');
el('spin-toggle').onclick=()=>{if(flightPhase!=='grounded')return;spinning=!spinning;el('spin-toggle').setAttribute('aria-pressed',String(spinning));if(reducedMotion&&spinning)toast('已按你的操作开启旋翼视觉演示');};
el('flight-toggle').onclick=()=>{if(flightPhase==='grounded')startFlight();else if(flightPhase==='hovering')landFlight();};
el('airdrop-toggle').onclick=()=>{
 if(airdropPhase==='dropping')return;
 if(airdropPhase==='landed'&&flightPhase==='grounded'){recoverRing(true);return;}
 startAirdrop();
};
el('payload-demo').onclick=()=>{if(activeDemo)stopDemo(true);else startDemo();};
el('tutorial-close').onclick=()=>stopDemo(true);
el('tutorial-pause').onclick=()=>setDemoPaused(!demoPaused);
el('tutorial-replay').onclick=()=>{
 if(!activeDemo)return;
 demoTime=0;demoStepIndex=-1;demoPaused=false;resetDemoTransforms();
 el('tutorial-progress').style.width='0%';setDemoStep(0);syncPauseButton();
 view(`demo-${activeDemo}`);toast('教学已从头重播');
};
window.addEventListener('keydown',e=>{if(e.key==='Escape'&&activeDemo)stopDemo(true);});
el('auto-toggle').onclick=()=>{controls.autoRotate=!controls.autoRotate;el('auto-toggle').setAttribute('aria-pressed',String(controls.autoRotate));};
el<HTMLInputElement>('gear-toggle').onchange=e=>{model.parts.find(p=>p.id==='landing-gear')!.group.visible=(e.target as HTMLInputElement).checked;select(selected);};
el<HTMLInputElement>('wire-toggle').onchange=e=>setWireframe((e.target as HTMLInputElement).checked);
el<HTMLInputElement>('cabin-toggle').onchange=e=>{cabin=(e.target as HTMLInputElement).checked;syncCabin();select(selected);toast(cabin?'已移除上舱盖，显示航电舱布局':'上舱盖已复位');};
el<HTMLInputElement>('labels-toggle').onchange=e=>labelsVisible=(e.target as HTMLInputElement).checked;
el<HTMLInputElement>('explode').oninput=e=>{explodeAutoTarget=null;applyExplosion(Number((e.target as HTMLInputElement).value)/100);};
el('explode-auto').onclick=()=>{
 if(explodeAutoTarget!==null){explodeAutoTarget=null;syncExplodeAutoButton();return;}
 explodeAutoTarget=explosion>.98?0:1;syncExplodeAutoButton();
};
el('reset').onclick=()=>{reset();toast('已恢复完整装配与默认视角');};
const sectionsToggle=el<HTMLButtonElement>('sections-toggle');
function setSectionCollapsed(section:HTMLElement,collapsed:boolean){
 section.classList.toggle('is-collapsed',collapsed);
 const button=section.querySelector<HTMLButtonElement>('.section-toggle');
 if(!button)return;
 const title=section.querySelector('h3')?.textContent?.trim()??'检查器分区';
 button.setAttribute('aria-expanded',String(!collapsed));
 button.setAttribute('aria-label',`${collapsed?'展开':'收起'}${title}`);
}
function syncSectionsToggle(){
 const allCollapsed=[...document.querySelectorAll<HTMLElement>('.control-section')].every(section=>section.classList.contains('is-collapsed'));
 sectionsToggle.textContent=allCollapsed?'展开全部':'全部收起';
 sectionsToggle.setAttribute('aria-label',allCollapsed?'展开全部检查器分区':'收起全部检查器分区');
}
document.querySelectorAll<HTMLButtonElement>('.section-toggle').forEach(button=>{
 button.onclick=()=>{
  const section=button.closest<HTMLElement>('.control-section');
  if(!section)return;
  setSectionCollapsed(section,!section.classList.contains('is-collapsed'));
  syncSectionsToggle();
 };
});
sectionsToggle.onclick=()=>{
 const allCollapsed=[...document.querySelectorAll<HTMLElement>('.control-section')].every(section=>section.classList.contains('is-collapsed'));
 document.querySelectorAll<HTMLElement>('.control-section').forEach(section=>setSectionCollapsed(section,!allCollapsed));
 syncSectionsToggle();
};
syncSectionsToggle();
const dialog=el<HTMLDialogElement>('reference-dialog');el('reference-open').onclick=()=>dialog.showModal();el('reference-close').onclick=()=>dialog.close();dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();}});
window.addEventListener('keydown',e=>{
 if(e.defaultPrevented||e.metaKey||e.ctrlKey||e.altKey||dialog.open)return;
 const focused=e.target as HTMLElement|null;
 if(focused&&(focused.tagName==='INPUT'||focused.tagName==='TEXTAREA'||focused.tagName==='SELECT'||focused.isContentEditable))return;
 if(e.code==='Space'){
  if(activeDemo||airdropPhase==='dropping'||flightPhase==='ascending'||flightPhase==='descending')return;
  e.preventDefault();
  if(flightPhase==='grounded')startFlight();else landFlight();
  return;
 }
 const presets:Record<string,string>={'1':'perspective','2':'payload','3':'top','4':'front','5':'side'};
 if(presets[e.key]){e.preventDefault();view(presets[e.key]);}
});
el('screenshot').onclick=()=>{
 const background=scene.background;scene.background=new THREE.Color(scenePanel.classList.contains('is-wireframe')?getComputedStyle(scenePanel).backgroundColor:'#edf1f3');renderer.render(scene,camera);
 renderer.domElement.toBlob(blob=>{if(!blob){toast('无法保存画面，请重试');return;}const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='六轴无人机-三维视图.png';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('已保存当前三维画面');},'image/png');scene.background=background;
};
const resize=()=>{const w=viewport.clientWidth,h=viewport.clientHeight;if(!w||!h)return;const oldFit=Math.max(1,1.25/camera.aspect);const newFit=Math.max(1,1.25/(w/h));camera.position.sub(controls.target).multiplyScalar(newFit/oldFit).add(controls.target);renderer.setSize(w,h);camera.aspect=w/h;camera.updateProjectionMatrix();};
new ResizeObserver(resize).observe(viewport);resize();reset();
const timer=new THREE.Timer();timer.connect(document);
let reviewing=false;
function animate(){
 requestAnimationFrame(animate);timer.update();if(document.hidden||reviewing)return;const dt=Math.min(timer.getDelta(),.05);
 const rotorTarget=flightPhase!=='grounded'?1.9:spinning?1:0;
 rotorLevel=THREE.MathUtils.damp(rotorLevel,rotorTarget,3,dt);
 if(rotorLevel>.001)model.rotors.forEach((r,i)=>r.rotation.y+=dt*(i%2?1:-1)*9*rotorLevel);
 updateFlight(dt);updateDemo(dt);updateAirdrop(dt);updateExplode(dt);updateEffects(dt);
 controls.update();if(highlight.visible)highlight.update();
 model.root.updateMatrixWorld(true);camera.updateMatrixWorld();
 for(const {p,node} of labels){const v=p.group.localToWorld(p.anchor.clone()).project(camera);node.hidden=!labelsVisible||!!activeDemo||flightPhase!=='grounded'||v.z>1||v.z<0;node.style.left=`${(v.x*.5+.5)*viewport.clientWidth}px`;node.style.top=`${(-v.y*.5+.5)*viewport.clientHeight-14}px`;}
 updateAltitudeLabels();updateCallouts();
 renderer.render(scene,camera);
}
animate();
requestAnimationFrame(()=>{
 (window as unknown as {__loadingComplete?:()=>void}).__loadingComplete?.();
 loading.classList.add('is-ready');
 window.setTimeout(()=>{loading.hidden=true;},reducedMotion?80:420);
});
updateStats();
renderer.domElement.addEventListener('webglcontextlost',e=>{e.preventDefault();loading.hidden=false;loading.textContent='图形上下文已中断，请刷新页面恢复模型。';});

if(import.meta.env.DEV){
 const capture=async(pass:string)=>{
  reviewing=true;const savedPos=camera.position.clone(),savedTarget=controls.target.clone(),savedBg=scene.background;const savedSize=new THREE.Vector2();renderer.getSize(savedSize);const savedRatio=renderer.getPixelRatio();const savedAspect=camera.aspect;const savedHighlight=highlight.visible;
  highlight.visible=false;renderer.setPixelRatio(1);renderer.setSize(1280,800,false);camera.aspect=1.6;camera.updateProjectionMatrix();scene.background=new THREE.Color('#e9edf1');
  const shots:Record<string,[number,number,number]>={reference:[-4.8,3.9,6.2],front:[0,3.8,9.8],right:[9.8,3.8,0],rear:[0,3.8,-9.8],left:[-9.8,3.8,0],top:[0,11,.001]};
  try{for(const [name,xyz]of Object.entries(shots)){camera.position.set(...xyz);camera.lookAt(target);camera.updateMatrixWorld();renderer.render(scene,camera);const res=await fetch('/__evidence',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:`${pass}-${name}.png`,data:renderer.domElement.toDataURL('image/png')})});if(!res.ok)throw new Error('Capture failed');}}finally{renderer.setPixelRatio(savedRatio);renderer.setSize(savedSize.x,savedSize.y);camera.aspect=savedAspect;camera.updateProjectionMatrix();camera.position.copy(savedPos);controls.target.copy(savedTarget);controls.update();scene.background=savedBg;highlight.visible=savedHighlight;reviewing=false;}
  return Object.keys(shots).map(name=>`evidence/${pass}-${name}.png`);
 };
 const inspect=()=>({rotors:model.rotors.length,blades:model.rotors.reduce((n,r)=>n+r.children.filter(c=>c.name.startsWith('blade-')).length,0),parts:model.parts.map(p=>p.id),meshes:meshCount,triangles:triangleCount,spinning,explosion,gearVisible:model.parts.find(p=>p.id==='landing-gear')!.group.visible,wireframe:model.materials.some(m=>m.wireframe),cabin,interiorVisible:model.root.getObjectByName('avionics-bay')?.visible??false,cowlingVisible:model.root.getObjectByName('upper-cowling')?.visible??true,labelsVisible,selected,payload,attachedPayload:model.parts.find(p=>p.id==='payload')!.group.children.find(c=>c.userData.payloadPod)?.name??null,rotorAngles:model.rotors.map(r=>r.rotation.y),camera:camera.position.toArray(),flightPhase,altitude:Number(model.root.position.y.toFixed(3)),rotorLevel:Number(rotorLevel.toFixed(2)),demo:activeDemo,demoTime:Number(demoTime.toFixed(2)),demoStep:demoStepIndex,airdrop:airdropPhase,airdropTime:Number(airdropTime.toFixed(2)),ringAttached:model.payloadRig.ringFloat.parent===model.payloadRig.ringAssembly,ringWorld:(()=>{scene.updateMatrixWorld(true);return model.payloadRig.ringFloat.getWorldPosition(new THREE.Vector3()).toArray().map(n=>Number(n.toFixed(3)));})(),drawCalls:renderer.info.render.calls,battery:Number(battery.toFixed(1)),flightElapsed:Number(flightElapsed.toFixed(2)),demoPaused,explodeAuto:explodeAutoTarget,landingBounce:landingBounceTime>=0,rotorBlur:rotorBlur[0].visible,padLampIntensity:Number(padLampMaterial.emissiveIntensity.toFixed(2)),dust:dustRings[0].visible,altitudeTicks:altitudeTicks.visible,callouts:callouts.some(c=>!c.node.hidden),cameraFrame:cameraFrame.visible,speakerSector:speakerSector.visible,ringPulse:ringPulses[0].visible,cameraPosition:camera.position.toArray().map(n=>Number(n.toFixed(2)))});
 Object.assign(window,{droneReview:{capture,inspect,model,scene,camera,renderer,controls,select,view}});
}
