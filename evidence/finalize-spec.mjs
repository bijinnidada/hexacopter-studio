import fs from 'node:fs';
const s=JSON.parse(fs.readFileSync('object-sculpt-spec.json','utf8'));
s.scores={object_isolation:3,silhouette_readability:3,depth_inference:2,primitive_decomposition:3,material_procedurality:2,occlusion_risk:1,interaction_fit:3};
s.preSpecAssessment.unknownsToResolveBeforeImplementation=[];
s.preSpecAssessment.acceptedInferenceLimits=s.risks;
s.lightingFromPhoto[2].shadowBehavior='soft ground shadow and local contact shadow';
for(const m of s.materials){
 for(const b of m.surfaceFrequencyBands) b.amplitude=Math.max(b.amplitude,.001);
 const r=JSON.parse(fs.readFileSync(`evidence/materials/${m.id}/report.json`,'utf8'));
 if(!r.ok) throw new Error('Material evidence incomplete: '+m.id);
 m.referencePbr={usable:r.ok,confidence:r.confidence,targetThreshold:r.targetThreshold,maps:r.maps,sourceImage:r.sourceImage,source:'reference-pixel-extraction',limitation:r.limitation};
}
for(const c of s.componentTree){
 const m=s.materials.find(m=>m.id===c.material);const rgb=m.baseColor.match(/\w\w/g).map(v=>parseInt(v,16));
 c.colorMaterialRecipe={dominantAlbedo:`rgba(${rgb.join(',')},1)`,secondaryAlbedo:`rgba(${rgb.join(',')},1)`,materialClass:m.id==='silver'?'metal':m.id==='rubber'?'rubber':'plastic',materialClassConfidence:.85,evidenceRefs:['full-object'],roughness:m.roughness.base,metalness:m.metalness.base};
 if(c.parent&&!c.attachment){
  const p=s.componentTree.find(p=>p.id===c.parent);
  const endpoints=c.geometryDescriptor.endpoints;
  let start,end;
  if(endpoints){start=endpoints.start;end=endpoints.end;}
  else {start=[...c.transform.position];start[1]-=c.dimensions.height/2;end=[...c.transform.position];end[1]+=c.dimensions.height/2;}
  c.attachment={parentId:c.parent,parentSocket:c.id+'-socket',localStart:start,localEnd:end,contactType:'overlap',embedDepth:.03,overlap:.03,gapTolerance:.01,baseRadius:c.dimensions.width/2,evidenceRefs:['full-object']};
  p.actionProfile.sockets.push({id:c.id+'-socket',name:c.id+'-socket',localPosition:start,localRotation:[0,0,0],direction:[0,1,0],radius:c.dimensions.width/2});
 }
}
fs.writeFileSync('object-sculpt-spec.json',JSON.stringify(s,null,2));
fs.writeFileSync('evidence/projection-applicability.json',JSON.stringify(s.reconstructionParameters.finishProjection,null,2));
