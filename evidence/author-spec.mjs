import fs from 'node:fs';
const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const write = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2));
const a = read('assessment.json');
const s = read('object-sculpt-spec.json');
const observation = read('evidence/image-analysis.json');
a.preSpecAssessment.objectClass = {primaryType:'hexacopter',primaryDomain:'object',formLanguage:['mechanical','hard-surface'],structureKind:['layered shell','repeated modules','articulated assembly'],motionPotential:['whole-object transform','articulated','detachable'],materialFamilies:['plastic','metal','rubber'],notes:'Six independently pivoted rigid rotor modules. Reference concept variants, not flight engineering.'};
a.preSpecAssessment.complexity.scores = {silhouetteComplexity:3,componentCount:3,hierarchyDepth:2,repetitionDensity:2,materialLayerCount:2,localDetailDensity:2,occlusionRisk:1,actionReadinessNeed:2};
a.preSpecAssessment.complexity.estimatedCounts = {macroComponents:10,mesoComponents:30,microFeatureGroups:12,materialLayers:6,repetitionSystems:3};
a.preSpecAssessment.complexity.reasoning = ['Six arms and motors with twelve profiled blades surround one continuous shell.', 'Layered motor hardware, antenna, seams and a two-runner landing gear require independent geometry.'];
a.preSpecAssessment.specDepthDecision.rationale = 'Six repeated rotor modules with stack hierarchy and painted continuous shell.';
a.preSpecAssessment.unknownsToResolveBeforeImplementation = observation.uncertainties;
a.qualityContract.definitionOfDone = observation.qualityContract.critical.concat(['All named assemblies selectable and explodable; all six rigid rotor pivots rotate with alternating direction.', 'Four azimuths and a top view reveal non-planar enclosed geometry.', 'Reference-proportional visual study only; hidden electronics not reconstructed.']);
s.preSpecAssessment = a.preSpecAssessment;
s.qualityContract = a.qualityContract;
s.scores = {object_isolation:.95,silhouette_readability:.95,depth_inference:.85,primitive_decomposition:.9,material_procedurality:.85,occlusion_risk:.2,interaction_fit:1};
s.referenceCamera = {solved:false,fovDegrees:33,aspect:1.78,orientation:{yaw:42,pitch:26,roll:0},positionHint:[5.8,4.4,7.5],target:[0,1,0],note:'Visually matched three-quarter camera; not a solved calibration.'};
s.silhouette = {boundingShape:'Six-arm interrupted radial footprint surrounding elongated convex shell',aspectRatios:['fuselage length/width = 2.4/1.4','motor center span/body width = 4.22/1.4'],symmetry:'bilateral on X',dominantCurves:['elliptic crown','rounded capsule perimeter','swept tapered blades'],negativeSpaces:['six open inter-arm wedges','space under fuselage between skids'],landmarks:observation.motorCentersXZ};
s.viewEvidence = [{id:'full-object',view:'primary',imageRegion:{x:0,y:0,width:1,height:1,units:'normalized'},observations:observation.observations.macro,confidence:.95},{id:'structural-plan',view:'top/bottom orthographic',imageRegion:{x:0,y:0,width:1,height:1,units:'normalized'},observations:['Six rotor centers symmetric about longitudinal centerline','Fuselage aspect 1.68','Not the same finish variant as the render'],confidence:.9}];
const template = structuredClone(s.componentTree[0]);
function part(id,parent,level,primitive,position,size,material,topology='assembled-solid') {
 const c = structuredClone(template);
 Object.assign(c,{id,name:id,parent,level,primitive,topologyClass:topology,topologyRationale:topology==='continuous-sculpt'?'Continuous lofted cross-sections give a variable-width convex surface.':'Discrete cylindrical, extruded or tubular mechanical element.',importance:.9,confidence:.9,role: id.startsWith('arm-')?'boom':'body',material,materialLayers:[material],fidelityTier:'reference-proportional'});
 c.dimensions = {width:size[0],height:size[1],depth:size[2],units:'relative',confidence:.85};
 c.transform = {position,rotation:[0,0,0],scale:[1,1,1]};
 c.actionProfile.animationRole = parent ? 'static-part' : 'root';
 c.actionProfile.pivot.confidence=.9;
 c.actionProfile.destruction.fractureGroup = id;
 c.actionProfile.transformChannels.detach = !!parent;
 c.geometryDescriptor = {topologyIntent: topology==='continuous-sculpt'?'closed anisotropic loft':'closed profiled mechanical solid',edgeTreatment:{type:'bevel',bevelRadius:.008,segments:3},deformationStack:[],uvStrategy:'generated procedural coordinates',normalStrategy:'smooth vertex normals'};
 c.details=[id+' observed in reference'];
 c.evidenceRefs=['full-object','structural-plan'];
 return c;
}
const root=part('root',null,'macro','box',[0,0,0],[1,1,1],'white');root.geometryDescriptor.invisibleRoot=true;
const hull=part('fuselage','root','macro','lathe',[0,1.32,0],[1.4,.62,2.4],'white','continuous-sculpt');
hull.geometryDescriptor.loft={axis:'Y',rings:[[-.32,.8],[-.26,.95],[-.15,1],[0,1],[.12,.97],[.23,.83],[.31,.12]],crossSection:'superellipse exponent 2.8',halfWidth:.7,halfLength:1.2};
const antenna=part('antenna','root','macro','cylinder',[0,1.73,-.65],[.73,.13,.73],'white');
const gear=part('landing-gear','root','macro','tube',[0,0,0],[1.2,.95,2.1],'graphite','fiber-strand');
gear.geometryDescriptor.paths=[[-.53,.12,-1],[-.53,.12,1],[.53,.12,-1],[.53,.12,1]];
s.componentTree=[root,hull,antenna,gear];
for(let i=0;i<6;i++) {
 const [x,z]=observation.motorCentersXZ[i];const sign=Math.sign(x);const start=[sign*(z===0?.62:.48),1.19,z===0?0:Math.sign(z)*.83];const end=[x,1.19,z];
 const arm=part(`arm-${i+1}`,'root','macro','cylinder',[0,0,0],[.105,Math.hypot(x-start[0],z-start[2]),.105],'silver');
 arm.attachment={parentSocket:`boom-${i+1}`,localStart:start,localEnd:end,contactType:'socket',embedDepth:.06,overlap:.04,gapTolerance:.01,baseRadius:.0525};
 root.actionProfile.sockets.push({id:`boom-${i+1}`,name:`boom-${i+1}`,localPosition:start,localRotation:[0,0,0],direction:[sign,0,Math.sign(z)],radius:.055});
 arm.geometryDescriptor.endpoints={start,end};
 const mount=part(`motor-mount-${i+1}`,`arm-${i+1}`,'meso','cylinder',[x,1.2,z],[.26,.2,.26],'blue');
 const motor=part(`motor-${i+1}`,`arm-${i+1}`,'meso','cylinder',[x,1.38,z],[.235,.2,.235],'silver');
 const rotor=part(`rotor-${i+1}`,`arm-${i+1}`,'macro','extrude',[x,1.53,z],[1.8,.022,.18],'graphite','continuous-sculpt');
 rotor.geometryDescriptor.bladeProfile=[[.08,0],[.2,.02],[.35,.095],[.8,.075],[.9,.045],[.88,-.025],[.36,-.04],[.22,-.02]];
 rotor.geometryDescriptor.pitchDegrees=9;rotor.geometryDescriptor.bladeCount=2;
 rotor.actionProfile.animationRole='rotor';rotor.actionProfile.pivot.localPosition=[x,1.53,z];
 s.componentTree.push(arm,mount,motor,rotor);
}
for(const side of [-1,1]) {
 const gside=side===-1?'left':'right';
 s.componentTree.push(part(`blue-inset-${gside}`,'fuselage','meso','extrude',[side*.57,1.53,-.06],[.05,.13,1.58],'blue','conforming-shell'));
 for(const end of [-1,1]) {const c=part(`strut-${gside}-${end===-1?'rear':'front'}`,'landing-gear','meso','tube',[0,0,0],[.06,.85,.06],'graphite','fiber-strand');c.geometryDescriptor.endpoints={start:[side*.42,.99,end*.63],end:[side*.58,.15,end*.85]};s.componentTree.push(c);}
}
s.componentTree.push(part('lower-tray','fuselage','meso','lathe',[0,1.04,0],[1.3,.2,2.26],'blue','continuous-sculpt'),part('nose-opening','fuselage','meso','extrude',[0,1.21,1.18],[.6,.115,.055],'black'),part('antenna-rim','antenna','meso','cylinder',[0,1.76,-.65],[.77,.025,.77],'white'));
const details=[
 ['shell-seam','seam','fuselage','Circumferential dark joint between upper and lower white shell', [.35,.42,.28,.13]],
 ['shoulder-inset','linework','fuselage','Two dark-blue elongated shoulder insets bounded by continuous curved geometry',[.37,.34,.19,.08]],
 ['brand-print','decal','fuselage','Side lettering 翔云智航; bird symbol approximate',[.37,.395,.12,.07]],
 ['nose-recess','hole','nose-opening','Black sensor recess, split vertically by thin separators',[.55,.485,.07,.05]],
 ['antenna-bevel','bevel','antenna-rim','Stepped white antenna cap edge',[.355,.26,.09,.08]],
 ['motor-bolts','fastener','motor-1','Two cap bolts per rotor and four clamp bolts per mount',[.31,.62,.07,.09]],
 ['motor-vents','groove','motor-1','Repeated radial motor crown cooling slots',[.32,.65,.04,.03]],
 ['mount-collar','ridge','motor-mount-1','Blue cylindrical mount flange and bottom step',[.32,.68,.055,.06]],
 ['blade-tip','linework','rotor-1','White distal blade tips on twelve blades',[.47,.675,.015,.015]],
 ['arm-collar','ridge','arm-1','Blue root socket ring and exposed silver tube',[.42,.49,.035,.055]],
 ['rubber-foot','bevel','landing-gear','Four black landing contact foot caps',[.46,.82,.03,.04]],
 ['panel-slot','groove','fuselage','Short gray horizontal side access slot',[.4,.448,.02,.012]]
];
s.preSpecAssessment.detailInventory={scanMethod:'grid-3x3',targetMinDetails:10,details:details.map(([id,kind,ref,description,region])=>({id,kind,description,region:{x:region[0],y:region[1],width:region[2],height:region[3],units:'normalized'},scale:kind==='fastener'?'micro':'meso',affects:kind==='linework'||kind==='decal'?'material':'geometry',mapsTo:{type:'component',ref},evidenceRef:'full-object',confidence:id==='brand-print'?.75:.88}))};
for(const [id,kind,ref,description] of details) {s.componentTree.find(c=>c.id===ref).localFeatures.push({id,type:kind,name:id,description,placement:{position:[0,0,0],size:[.02,.02,.02]},geometryEffect:description,materialEffect:kind==='linework'?'local albedo boundary':'unchanged',confidence:.88,evidenceRefs:['full-object']});}
for(const [id,parent] of [['cap-bolt-group','motor-1'],['vent-group','motor-1'],['clamp-bolt-group','motor-mount-1'],['foot-cap-group','landing-gear'],['panel-bolt-group','fuselage']]) s.componentTree.push(part(id,parent,'micro','cylinder',[0,0,0],[.01,.008,.01],'silver'));
const mt=s.materials[0];
s.materials=[['white','#edf1f5',.28,0],['blue','#244b75',.32,.25],['silver','#c6ced8',.26,.92],['graphite','#303640',.38,.2],['black','#101720',.34,0],['rubber','#171d24',.72,0]].map(([id,color,roughness,metalness])=>{const m=structuredClone(mt);Object.assign(m,{id,name:id,type:'physical',baseColor:color,color,albedo:{dominant:color,secondary:[color],samplingNotes:'Observed de-lit target of solid material; studio highlights are not pigmentation'},colorVariation:{palette:[color],pattern:'uniform',amplitude:0,heightCorrelation:0},roughness:{base:roughness,variation:.015,map:'independent-procedural-field',localResponse:'subtle manufactured finish'},metalness:{base:metalness,variation:0},clearcoat:id==='white'?.3:0,clearcoatRoughness:.2,normal:{pattern:'micro-finish',strength:.015,scale:256,space:'tangent'},notes:'Single-color manufactured finish, no wear visible. RGB inferred from rendered reference, not a calibrated measurement.'});m.surfaceFrequencyBands=[{id:'macro',frequency:1,amplitude:0,role:'uniform paint'},{id:'meso',frequency:20,amplitude:0,role:'no fictional damage'},{id:'micro',frequency:256,amplitude:.003,role:'manufacturing finish'}];m.localOverrides=[{id:id+'-edges',region:'edge fillet',roughness:Math.max(.1,roughness-.04),clearcoat:id==='white'?.3:0,evidenceRefs:['full-object']}];return m;});
s.repetitionSystems=[{id:'rotor-array',type:'radial',count:6,componentRefs:Array.from({length:6},(_,i)=>`rotor-${i+1}`),distribution:'three bilateral pairs from measured plan',seed:17},{id:'cap-bolts',type:'instanced',count:12,componentRefs:['cap-bolt-group'],distribution:'two per motor crown',seed:17},{id:'vent-slots',type:'instanced',count:96,componentRefs:['vent-group'],distribution:'six rings of sixteen slots',seed:17}];
s.featureReviewTargets=[['six-axis-layout','Six arms and six two-blade rotors',['blockout','structural-pass'],['root']],['shell-proportion','Elongated continuous hull and circular rear antenna',['blockout','form-refinement'],['fuselage','antenna']],['landing-connectivity','Connected double-skid landing gear',['structural-pass','form-refinement'],['landing-gear']],['white-blue-finish','White shell blue shoulders silver booms',['material-pass','surface-pass'],['fuselage','arm-1']],['mechanical-details','Motor crown vents bolts blade tips',['form-refinement','surface-pass'],['motor-1','rotor-1']]].map(([id,name,passIds,componentRefs])=>({id,name,tier:'critical',passIds,minimumScore:.8,mustPass:true,componentRefs,evidenceRefs:['full-object','structural-plan']}));
for(const pass of s.buildPasses) pass.componentRefs=s.componentTree.filter(c=>pass.id!=='blockout'||c.level==='macro').map(c=>c.id);
s.performanceBudget={qualityPriority:'reference-fidelity',targetTriangles:120000,maxDrawCalls:180,textureSize:1024,fpsTarget:30,optimizationPolicy:'Share geometries; instance bolts and cooling recesses.'};
s.lightingFromPhoto=[{type:'key',position:[-3,6,4],color:'#fff6ed',intensity:4,shadowSoftness:.4},{type:'fill',position:[4,3,-2],color:'#dbe7ff',intensity:2},{type:'environment',source:'procedural studio area panels',exposure:1.1,toneMapping:'ACESFilmic',background:'#e7edf2',contactShadow:true}];
s.risks=observation.uncertainties;
s.reconstructionParameters={motorCentersXZ:observation.motorCentersXZ,body:{halfWidth:.7,halfLength:1.2,centerY:1.32,height:.62},rotor:{radius:.9,topY:1.53,bladeCount:2},landingGear:{runnerX:.58,runnerHalfLength:1.02,footY:.1},finishProjection:{applies:false,reason:'Solid-color paint with geometric shoulder boundaries. Lettering drawn procedurally; exact bird logo not claimed.'}};
a.preSpecAssessment=s.preSpecAssessment;write('assessment.json',a);write('object-sculpt-spec.json',s);write('evidence/detail-inventory.json',{sourceImage:s.sourceImage,detailInventory:s.preSpecAssessment.detailInventory});
