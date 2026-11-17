import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const profile = await mkdtemp(join(tmpdir(), 'hexacopter-anim-'));
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--disable-background-networking', '--enable-unsafe-swiftshader', 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
const exited = new Promise(resolve => chrome.once('exit', resolve));
let socket;
const errors = [], log = [];
try {
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Chrome did not start')), 15000);
    let output = '';
    chrome.stderr.on('data', chunk => {
      output += chunk;
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    chrome.once('error', reject);
  });
  socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  const pending = new Map(); let id = 0, sessionId;
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject, timer, method } = pending.get(message.id); clearTimeout(timer); pending.delete(message.id);
      message.error ? reject(new Error(`${method}: ${JSON.stringify(message.error)}`)) : resolve(message.result);
    }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') errors.push(message.params.args.map(a => a.value ?? a.description));
  });
  const send = (method, params = {}, page = true) => new Promise((resolve, reject) => {
    const messageId = ++id;
    pending.set(messageId, { resolve, reject, method, timer: setTimeout(() => { pending.delete(messageId); reject(new Error(`Timed out: ${method}`)); }, 45000) });
    socket.send(JSON.stringify({ id: messageId, method, params, ...(page && sessionId ? { sessionId } : {}) }));
  });
  const target = await send('Target.createTarget', { url: 'about:blank' }, false);
  sessionId = (await send('Target.attachToTarget', { targetId: target.targetId, flatten: true }, false)).sessionId;
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
  const loaded = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Page load timed out')), 20000);
    const onMessage = event => {
      const message = JSON.parse(event.data);
      if (message.method === 'Page.loadEventFired' && message.sessionId === sessionId) {
        clearTimeout(timer); socket.removeEventListener('message', onMessage); resolve();
      }
    };
    socket.addEventListener('message', onMessage);
  });
  await send('Page.navigate', { url: 'http://127.0.0.1:5174/' });
  await loaded;
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  for (let attempt = 0; ; attempt++) {
    try { await evaluate(`new Promise((resolve,reject)=>{const until=performance.now()+15000;function ready(){if(window.droneReview&&document.getElementById('loading').hidden)resolve(true);else if(performance.now()>until)reject(new Error('Viewer did not load'));else requestAnimationFrame(ready)}ready()})`); break; }
    catch (error) { if (attempt >= 4) throw error; await new Promise(resolve => setTimeout(resolve, 600)); }
  }
  const frames = count => evaluate(`new Promise(resolve=>{let n=0;function tick(){if(++n>=${count})resolve(true);else requestAnimationFrame(tick)}requestAnimationFrame(tick)})`);
  const wait = ms => evaluate(`new Promise(resolve=>setTimeout(resolve,${ms}))`);
  const inspect = () => evaluate('window.droneReview.inspect()');
  const screenshot = async name => {
    const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(resolve('evidence', name), Buffer.from(result.data, 'base64'));
  };
  const click = async selector => {
    const point = await evaluate(`(()=>{const element=document.querySelector(${JSON.stringify(selector)});element.scrollIntoView({block:'center'});const r=element.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
    await frames(2);
  };
  const key = async (key, code = key, keyCode = 0) => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode });
    await frames(2);
  };
  const rig = () => evaluate(`(()=>{const r=window.droneReview.model.payloadRig;return {lever:r.releaseLever.rotation.x,ringY:r.ringAssembly.position.y,ringZ:r.ringAssembly.position.z,cameraY:r.cameraHead.rotation.y,cameraX:r.cameraHead.rotation.x,speakerX:r.speakerHead.rotation.x,marker:window.droneReview.scene.children.some(o=>o.geometry&&o.geometry.type==='RingGeometry'&&o.visible)}})()`);
  const waves = () => evaluate(`(()=>{const head=window.droneReview.model.payloadRig.speakerHead;return head.children.filter(c=>c.geometry&&c.geometry.type==='TorusGeometry').map(c=>({visible:c.visible,opacity:c.material.opacity,scale:c.scale.x}))})()`);
  await frames(5);

  const grounded = await inspect();
  log.push({ step: 'initial', flightPhase: grounded.flightPhase, altitude: grounded.altitude, hudHidden: await evaluate('document.getElementById("flight-hud").hidden'), demo: grounded.demo });
  assert(grounded.battery === 100 && grounded.flightElapsed === 0, `initial telemetry ${JSON.stringify({ battery: grounded.battery, time: grounded.flightElapsed })}`);
  assert(grounded.rotorBlur === false && grounded.dust === false && grounded.altitudeTicks === false && grounded.callouts === false, 'grounded effects stay hidden');
  assert(await evaluate('document.getElementById("loading").hidden') === true, 'loading overlay dismissed');
  assert(await evaluate('document.getElementById("loading-progress").style.width') === '100%', 'loading progress reached 100%');
  assert(await evaluate('document.querySelectorAll(".keyboard-hint").length') === 2, 'keyboard hints present');
  await screenshot('anim-01-grounded.png');

  await click('#flight-toggle');
  const lifted0 = await inspect();
  assert(lifted0.flightPhase === 'ascending', 'takeoff phase');
  assert(await evaluate('document.getElementById("flight-hud").hidden') === false, 'HUD visible in flight');
  assert(await evaluate('document.getElementById("flight-toggle").disabled') === true, 'flight button disabled while ascending');
  assert(await evaluate('document.getElementById("spin-toggle").disabled') === true, 'rotor demo disabled in flight');
  await wait(1400); await screenshot('anim-02-ascending.png');
  const mid = await inspect();
  log.push({ step: 'ascending', altitude: mid.altitude, rotorLevel: mid.rotorLevel, cameraY: mid.camera[1] });
  assert(mid.rotorBlur === true, 'rotor blur discs visible in flight');
  assert(mid.dust === true, 'takeoff dust rings visible near the pad');
  assert(mid.altitudeTicks === true, 'altitude ticks visible during climb');
  assert(mid.padLampIntensity > .55, `pad lamps lit ${mid.padLampIntensity}`);
  assert(mid.flightElapsed > .5 && mid.battery < 100, `flight telemetry running ${JSON.stringify({ time: mid.flightElapsed, battery: mid.battery })}`);
  assert(await evaluate('document.getElementById("flight-hud-battery").textContent') === String(Math.round(mid.battery)), 'HUD battery readout matches state');
  assert(await evaluate('document.getElementById("flight-hud-phase").textContent') === '旋翼启动 · 爬升', 'HUD climb phase text');
  assert(/^\d{2}:\d{2}$/.test(await evaluate('document.getElementById("flight-hud-time").textContent')), 'HUD flight timer format');
  await wait(3800);
  const hover = await inspect();
  assert(hover.flightPhase === 'hovering', `hover phase, got ${hover.flightPhase}`);
  assert(Math.abs(hover.altitude - 2.1) < .06, `hover altitude ${hover.altitude}`);
  assert(hover.rotorLevel > 1.5, `rotor level ${hover.rotorLevel}`);
  assert(hover.rotorBlur === true && hover.altitudeTicks === true && hover.dust === false, 'hover keeps blur and ticks, clears dust');
  assert(hover.padLampIntensity > .55, `airborne pad lamps ${hover.padLampIntensity}`);
  assert(await evaluate('document.getElementById("flight-toggle-label").textContent') === '一键降落', 'landing label');
  assert(await evaluate('document.querySelector(".flight-hud").classList.contains("is-airborne")') === true, 'airborne HUD');
  assert(await evaluate('document.getElementById("flight-hud-altitude").textContent') === hover.altitude.toFixed(1), 'HUD altitude text');
  assert(hover.drawCalls <= 200, `airborne draw calls ${hover.drawCalls}`);
  log.push({ step: 'hovering', altitude: hover.altitude, drawCalls: hover.drawCalls, cameraY: hover.camera[1] });
  await screenshot('anim-03-hovering.png');

  await click('[data-view="side"]'); await frames(4); await screenshot('anim-04-hovering-side.png');
  await click('#flight-toggle');
  const descending = await inspect();
  assert(descending.flightPhase === 'descending', 'descending phase');
  await wait(1800); await screenshot('anim-05-descending.png');
  await wait(2600);
  const landed = await inspect();
  assert(landed.flightPhase === 'grounded', 'landed phase');
  assert(landed.altitude === 0, `landed altitude ${landed.altitude}`);
  assert(landed.rotorLevel < .4, `rotor spool down ${landed.rotorLevel}`);
  assert(await evaluate('document.getElementById("flight-hud").hidden') === true, 'HUD hidden after landing');
  assert(await evaluate('document.getElementById("spin-toggle").disabled') === false, 'rotor demo re-enabled');
  log.push({ step: 'landed', altitude: landed.altitude, rotorLevel: landed.rotorLevel });
  await screenshot('anim-06-landed.png');

  await click('#reset');
  await click('[data-payload="ring"]');
  await click('#payload-demo');
  const ringStart = await inspect();
  assert(ringStart.demo === 'ring', 'ring demo active');
  assert(ringStart.cameraPosition[2] > 6.5 && ringStart.cameraPosition[1] > 1.2, `ring tutorial camera framing ${JSON.stringify(ringStart.cameraPosition)}`);
  assert(ringStart.cameraFrame === false && ringStart.speakerSector === false, 'other payload markers stay hidden');
  assert(await evaluate('document.getElementById("tutorial").hidden') === false, 'ring tutorial visible');
  assert(await evaluate('document.querySelectorAll("#tutorial-steps li").length') === 4, 'ring has four steps');
  await wait(1100);
  const lever = await rig();
  assert(lever.lever < -.1, `release lever ${lever.lever}`);
  await screenshot('anim-07-ring-unlock.png');
  await wait(1900);
  const slide = await rig();
  assert(slide.ringZ > .02, `ring slide z ${slide.ringZ}`);
  await screenshot('anim-08-ring-slide.png');
  await wait(1200);
  const drop = await rig();
  assert(drop.ringY < -.12, `ring drop y ${drop.ringY}`);
  assert(drop.marker === true, 'drop marker visible');
  const ringStep = await inspect();
  assert(ringStep.demoStep === 2, `ring step ${ringStep.demoStep}`);
  assert(ringStep.ringPulse === true, 'ground target pulses during ring release');
  await screenshot('anim-09-ring-drop.png');
  await wait(3400);
  const ringEnd = await inspect();
  assert(ringEnd.demo === null, 'ring demo ended');
  assert(await evaluate('document.getElementById("tutorial").hidden') === true, 'tutorial hidden after ring demo');
  const ringRestored = await rig();
  assert(Math.abs(ringRestored.ringY) < .001 && Math.abs(ringRestored.ringZ) < .001 && Math.abs(ringRestored.lever) < .001, `ring restored ${JSON.stringify(ringRestored)}`);
  log.push({ step: 'ring-demo', ended: ringEnd.demo, restored: ringRestored });

  await click('[data-payload="camera"]');
  await click('#payload-demo');
  await wait(3000);
  const cam = await rig();
  assert(Math.abs(cam.cameraY) > .05, `camera yaw ${cam.cameraY}`);
  const camState = await inspect();
  assert(camState.cameraFrame === true, 'camera ground framing reticle visible');
  assert(camState.cameraPosition[2] > 6.5 && camState.cameraPosition[1] > 1.2, `camera tutorial framing ${JSON.stringify(camState.cameraPosition)}`);
  assert(await evaluate('document.getElementById("tutorial-code").textContent') === 'GC', 'camera tutorial code');
  await screenshot('anim-10-camera-scan.png');
  await wait(2400); await screenshot('anim-11-camera-pitch.png');
  await wait(2400);
  assert((await inspect()).demo === null, 'camera demo ended');
  const camRestore = await rig();
  assert(Math.abs(camRestore.cameraY) < .001 && Math.abs(camRestore.cameraX) < .001, `camera restored ${JSON.stringify(camRestore)}`);
  log.push({ step: 'camera-demo', scanYaw: cam.cameraY, restored: camRestore });

  await click('[data-payload="speaker"]');
  await click('#payload-demo');
  await wait(4300);
  const waveState = await waves();
  assert(waveState.filter(w => w.visible && w.opacity > .01).length >= 2, `speaker waves ${JSON.stringify(waveState)}`);
  const spk = await rig();
  assert(Math.abs(spk.speakerX) > .001, `speaker aim ${spk.speakerX}`);
  const spkState = await inspect();
  assert(spkState.speakerSector === true, 'speaker broadcast sector visible on the ground');
  assert(spkState.cameraPosition[2] > 6.5 && spkState.cameraPosition[1] > 1.2, `speaker tutorial framing ${JSON.stringify(spkState.cameraPosition)}`);
  await screenshot('anim-12-speaker-waves.png');
  await wait(3100);
  assert((await inspect()).demo === null, 'speaker demo ended');
  assert((await waves()).every(w => !w.visible), 'speaker waves hidden');
  log.push({ step: 'speaker-demo', waves: waveState });

  await click('#reset');
  await click('[data-payload="camera"]');
  await click('#payload-demo');
  await wait(1000);
  await click('#tutorial-pause');
  const paused = await inspect();
  assert(paused.demoPaused === true && paused.demo === 'camera', 'tutorial pauses in place');
  assert(await evaluate('document.getElementById("tutorial-pause").getAttribute("aria-pressed")') === 'true', 'pause button pressed state');
  await wait(800);
  const pausedLater = await inspect();
  assert(Math.abs(pausedLater.demoTime - paused.demoTime) < .08, `paused time drifted ${paused.demoTime} -> ${pausedLater.demoTime}`);
  await screenshot('anim-20-tutorial-paused.png');
  await click('#tutorial-pause');
  await wait(650);
  const resumed = await inspect();
  assert(resumed.demoPaused === false && resumed.demoTime > pausedLater.demoTime + .25, `tutorial resumed ${JSON.stringify({ paused: pausedLater.demoTime, resumed: resumed.demoTime })}`);
  await click('#tutorial-replay');
  const replayed = await inspect();
  assert(replayed.demo === 'camera' && replayed.demoTime < .6, `tutorial replay restarted at ${replayed.demoTime}`);
  await click('#tutorial-close');
  const closed = await inspect();
  assert(closed.demo === null && await evaluate('document.getElementById("tutorial").hidden') === true, 'tutorial closes cleanly');
  log.push({ step: 'tutorial-controls', pausedAt: paused.demoTime, resumedAt: resumed.demoTime, replayedAt: replayed.demoTime });

  await click('#reset');
  assert(await evaluate('document.getElementById("explode-auto").textContent') === '自动', 'auto explode idle label');
  await click('#explode-auto');
  assert((await inspect()).explodeAuto === 1, 'auto explode started');
  assert(await evaluate('document.getElementById("explode-auto").textContent') === '停止', 'auto explode stop label while animating');
  await wait(1550);
  const exploding = await inspect();
  assert(exploding.explosion > .8, `auto explode progress ${exploding.explosion}`);
  assert(exploding.callouts === true, 'part callouts visible while exploded');
  assert(await evaluate('document.querySelectorAll(".part-callout:not([hidden])").length') === 4, 'four callouts shown');
  assert(await evaluate('document.querySelectorAll(".callout-lines line").length') === 4, 'four callout leader lines');
  await screenshot('anim-21-explode-callouts.png');
  await wait(1800);
  const exploded = await inspect();
  assert(exploded.explodeAuto === null && exploded.explosion === 1, `auto explode settled ${JSON.stringify({ explosion: exploded.explosion, auto: exploded.explodeAuto })}`);
  assert(await evaluate('document.getElementById("explode-auto").textContent') === '复位', 'auto explode reset label');
  await click('#explode-auto');
  assert((await inspect()).explodeAuto === 0, 'auto collapse started');
  await wait(3000);
  const collapsed = await inspect();
  assert(collapsed.explodeAuto === null && collapsed.explosion === 0 && collapsed.callouts === false, 'auto collapse restores assembly and hides callouts');
  assert(await evaluate('document.getElementById("explode-auto").textContent') === '自动', 'auto explode returns to idle label');
  log.push({ step: 'auto-explode', mid: exploding.explosion, callouts: 4, final: exploded.explosion });

  await click('#reset');
  await evaluate('document.querySelector("canvas").focus()');
  await key(' ', 'Space', 32);
  assert((await inspect()).flightPhase === 'ascending', 'Space starts takeoff');
  await wait(5400);
  assert((await inspect()).flightPhase === 'hovering', 'Space flight reaches hover');
  await key(' ', 'Space', 32);
  assert((await inspect()).flightPhase === 'descending', 'Space starts landing');
  await wait(4400);
  assert((await inspect()).flightPhase === 'grounded', 'Space landing completes');
  await key('3', 'Digit3', 51);
  assert(await evaluate('document.querySelector("[data-view=top]").getAttribute("aria-pressed")') === 'true', 'number key 3 selects top view');
  await key('1', 'Digit1', 49);
  assert(await evaluate('document.querySelector("[data-view=perspective]").getAttribute("aria-pressed")') === 'true', 'number key 1 returns to perspective');
  await click('#reset');
  log.push({ step: 'keyboard', takeoff: 'Space', hover: true, landing: true, views: '1-5' });

  await click('#flight-toggle');
  await wait(5600);
  await click('#payload-demo');
  assert((await inspect()).demo === null, 'demo blocked while airborne');
  assert(/完成降落/.test(await evaluate('document.getElementById("toast").textContent')), 'airborne demo toast');
  log.push({ step: 'mutual-exclusion', toast: await evaluate('document.getElementById("toast").textContent'), phase: (await inspect()).flightPhase });
  await click('#flight-toggle'); await wait(4400);
  assert((await inspect()).flightPhase === 'grounded', 'landing before mobile pass');

  await click('#reset');
  await click('[data-payload="ring"]');
  await click('#flight-toggle'); await wait(5600);
  const armed = await inspect();
  assert(armed.flightPhase === 'hovering', 'airdrop hover phase');
  assert(await evaluate('document.getElementById("airdrop-toggle").hidden') === false, 'airdrop button armed');
  assert(await evaluate('document.getElementById("airdrop-label").textContent') === '抛投救生圈', 'airdrop armed label');
  await evaluate('document.getElementById("toast").textContent=""');
  await screenshot('anim-15-airdrop-armed.png');
  await click('#airdrop-toggle');
  const dropping = await inspect();
  assert(dropping.airdrop === 'dropping', `airdrop dropping ${dropping.airdrop}`);
  assert(await evaluate('document.getElementById("flight-toggle").disabled') === true, 'flight disabled while dropping');
  assert(await evaluate('document.getElementById("airdrop-label").textContent') === '正在抛投', 'airdrop dropping label');
  await wait(900);
  const falling = await inspect();
  assert(falling.ringAttached === false, 'ring detached in air');
  assert(falling.ringWorld[1] > .5 && falling.ringWorld[1] < 2.6, `falling height ${falling.ringWorld[1]}`);
  await screenshot('anim-16-airdrop-falling.png');
  await wait(1800);
  const dropped = await inspect();
  assert(dropped.airdrop === 'landed', `airdrop landed ${dropped.airdrop}`);
  assert(Math.abs(dropped.ringWorld[0] + .1) < .01, `ring x ${dropped.ringWorld[0]}`);
  assert(Math.abs(dropped.ringWorld[1] - .144) < .01, `ring y ${dropped.ringWorld[1]}`);
  assert(Math.abs(dropped.ringWorld[2] - 1) < .01, `ring z ${dropped.ringWorld[2]}`);
  assert(dropped.drawCalls <= 200, `airdrop draw calls ${dropped.drawCalls}`);
  assert(await evaluate('document.getElementById("airdrop-toggle").hidden') === true, 'airdrop button hidden while hovering after drop');
  await evaluate('document.getElementById("toast").textContent=""');
  await screenshot('anim-17-airdrop-landed.png');
  await click('[data-payload="camera"]');
  assert((await inspect()).payload === 'ring', 'payload switch blocked in flight');
  assert(/飞行中不可更换载荷/.test(await evaluate('document.getElementById("toast").textContent')), 'airborne payload toast');
  await click('#flight-toggle'); await wait(4400);
  assert((await inspect()).flightPhase === 'grounded', 'landed after airdrop');
  assert(await evaluate('document.getElementById("airdrop-label").textContent') === '收回救生圈', 'recover label');
  assert(await evaluate('document.getElementById("payload-demo").disabled') === true, 'ground tutorial blocked while ring dropped');
  const sceneTriangles = await evaluate(`(()=>{let n=0;window.droneReview.scene.traverse(o=>{if(o.isMesh)n+=(o.geometry.index?.count??o.geometry.attributes.position.count)/3});return Math.round(n)})()`);
  await click('#flight-toggle'); await wait(5600);
  assert((await inspect()).flightPhase === 'hovering', 'retakeoff with dropped ring');
  assert(await evaluate('document.getElementById("airdrop-toggle").hidden') === true, 'no airdrop button with ring already dropped');
  await click('#flight-toggle'); await wait(4400);
  await click('#airdrop-toggle');
  const recovered = await inspect();
  assert(recovered.airdrop === 'idle' && recovered.ringAttached === true, 'ring recovered');
  assert(Math.abs(recovered.ringWorld[1] - .615) < .01, `recovered ring y ${recovered.ringWorld[1]}`);
  const recoveredTriangles = await evaluate(`(()=>{let n=0;window.droneReview.scene.traverse(o=>{if(o.isMesh)n+=(o.geometry.index?.count??o.geometry.attributes.position.count)/3});return Math.round(n)})()`);
  assert(recoveredTriangles === sceneTriangles, `triangle count changed ${sceneTriangles} -> ${recoveredTriangles}`);
  await click('[data-payload="ring"]'); await click('#payload-demo');
  assert((await inspect()).demo === 'ring', 'ground tutorial replayable after recover');
  await click('#payload-demo'); await click('#reset');
  log.push({ step: 'airdrop', armed: armed.airdrop, fallingY: falling.ringWorld[1], landed: dropped.ringWorld, drawCalls: dropped.drawCalls, triangles: recoveredTriangles });

  await click('[data-payload="ring"]');
  await click('#flight-toggle'); await wait(5600);
  await click('#airdrop-toggle'); await wait(900);
  assert((await inspect()).ringAttached === false, 'reset mid-air detach');
  await click('#reset');
  const resetMidAir = await inspect();
  assert(resetMidAir.flightPhase === 'grounded' && resetMidAir.altitude === 0, 'reset mid-air grounds the model');
  assert(resetMidAir.airdrop === 'idle' && resetMidAir.ringAttached === true, 'reset mid-air restores the ring');
  assert(Math.abs(resetMidAir.ringWorld[1] - .615) < .01, `reset ring y ${resetMidAir.ringWorld[1]}`);
  log.push({ step: 'airdrop-reset', phase: resetMidAir.flightPhase, ring: resetMidAir.ringWorld });

  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true });
  await frames(6); await evaluate('window.scrollTo(0,0)'); await frames(3);
  assert(await evaluate('document.documentElement.scrollWidth<=innerWidth') === true, 'mobile no horizontal overflow');
  assert(await evaluate(`document.querySelectorAll('.control-section.is-collapsed').length`) === 4, 'mobile inspector starts folded');
  await click('#sections-toggle');
  assert(await evaluate(`document.querySelectorAll('.control-section.is-collapsed').length`) === 0, 'mobile inspector expands all sections');
  assert(await evaluate('document.getElementById("sections-toggle").textContent') === '全部收起', 'mobile expand-all label');
  await click('#flight-toggle'); await wait(5200);
  await evaluate('window.scrollTo(0,0)'); await frames(3);
  const mobileBox = await evaluate(`(()=>{const hud=document.getElementById('flight-hud').getBoundingClientRect(),panel=document.querySelector('.scene-panel').getBoundingClientRect();return {hud:{top:hud.top,right:hud.right,bottom:hud.bottom},panel:{top:panel.top,right:panel.right,bottom:panel.bottom},overflow:document.documentElement.scrollWidth>innerWidth}})()`);
  assert(mobileBox.hud.right <= mobileBox.panel.right + 1 && mobileBox.hud.top >= mobileBox.panel.top, `mobile HUD ${JSON.stringify(mobileBox)}`);
  assert(mobileBox.overflow === false, 'mobile airborne overflow');
  await screenshot('anim-13-mobile-hover.png');
  await click('#flight-toggle'); await wait(4400);
  await click('[data-payload="ring"]'); await click('#payload-demo'); await wait(2400);
  await evaluate('window.scrollTo(0,0)'); await frames(3);
  const tutorialBox = await evaluate(`(()=>{const t=document.getElementById('tutorial').getBoundingClientRect(),panel=document.querySelector('.scene-panel').getBoundingClientRect();return {left:t.left,right:t.right,top:t.top,bottom:t.bottom,panel:{left:panel.left,right:panel.right,bottom:panel.bottom},overflow:document.documentElement.scrollWidth>innerWidth}})()`);
  assert(tutorialBox.left >= 0 && tutorialBox.right <= 390 && tutorialBox.bottom <= tutorialBox.panel.bottom, `mobile tutorial ${JSON.stringify(tutorialBox)}`);
  assert(tutorialBox.overflow === false, 'mobile tutorial overflow');
  await screenshot('anim-14-mobile-tutorial.png');
  assert(await evaluate(`(()=>{const a=document.querySelector('.tutorial-actions').getBoundingClientRect();return a.left>=0&&a.right<=390&&a.top>=0})()`) === true, 'mobile tutorial controls stay in view');
  await click('#tutorial-pause');
  assert((await inspect()).demoPaused === true, 'mobile tutorial pause');
  await click('#tutorial-pause');
  await click('#reset');
  assert((await inspect()).demo === null && (await inspect()).flightPhase === 'grounded', 'mobile reset');

  await click('[data-payload="ring"]');
  await click('#flight-toggle'); await wait(5200);
  await evaluate('window.scrollTo(0,0)'); await frames(3);
  const mobileAirdropBox = await evaluate(`(()=>{const b=document.getElementById('airdrop-toggle').getBoundingClientRect(),p=document.querySelector('.scene-panel').getBoundingClientRect();return {hidden:document.getElementById('airdrop-toggle').hidden,left:b.left,right:b.right,top:b.top,bottom:b.bottom,panelBottom:p.bottom,overflow:document.documentElement.scrollWidth>innerWidth}})()`);
  assert(!mobileAirdropBox.hidden && mobileAirdropBox.left >= 0 && mobileAirdropBox.right <= 390, `mobile airdrop button ${JSON.stringify(mobileAirdropBox)}`);
  assert(mobileAirdropBox.top >= 0 && mobileAirdropBox.bottom <= mobileAirdropBox.panelBottom, `mobile airdrop button vertical ${JSON.stringify(mobileAirdropBox)}`);
  assert(mobileAirdropBox.overflow === false, 'mobile airdrop overflow');
  await evaluate('document.getElementById("toast").textContent=""');
  await screenshot('anim-18-airdrop-mobile.png');
  await click('#airdrop-toggle'); await wait(2800);
  assert((await inspect()).airdrop === 'landed', 'mobile airdrop landed');
  const mobileDropView = await evaluate(`(()=>{const {camera,model,scene}=window.droneReview;scene.updateMatrixWorld(true);const ring=model.payloadRig.ringFloat.getWorldPosition(model.payloadRig.ringFloat.position.clone()).project(camera);const body=camera.position.clone().set(0,2.4,0).project(camera);return {ring:[ring.x,ring.y],body:[body.x,body.y],overflow:document.documentElement.scrollWidth>innerWidth}})()`);
  assert(Math.abs(mobileDropView.ring[0]) < 1 && Math.abs(mobileDropView.ring[1]) < 1, `mobile ring out of frame ${JSON.stringify(mobileDropView)}`);
  assert(Math.abs(mobileDropView.body[0]) < 1 && Math.abs(mobileDropView.body[1]) < 1, `mobile body out of frame ${JSON.stringify(mobileDropView)}`);
  assert(mobileDropView.overflow === false, 'mobile landed overflow');
  await screenshot('anim-19-airdrop-mobile-landed.png');
  await click('#flight-toggle'); await wait(4400);
  await click('#airdrop-toggle');
  assert((await inspect()).airdrop === 'idle', 'mobile airdrop recover');
  await click('#reset');
  log.push({ step: 'airdrop-mobile', button: mobileAirdropBox, frame: mobileDropView });

  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await send('Page.navigate', { url: 'http://127.0.0.1:5174/' });
  await new Promise(resolve => setTimeout(resolve, 1500));
  for (let attempt = 0; ; attempt++) {
    try { await evaluate(`new Promise((resolve,reject)=>{const until=performance.now()+15000;function ready(){if(window.droneReview&&document.getElementById('loading').hidden)resolve(true);else if(performance.now()>until)reject(new Error('Reload did not finish'));else requestAnimationFrame(ready)}ready()})`); break; }
    catch (error) { if (attempt >= 12) throw error; await new Promise(resolve => setTimeout(resolve, 500)); }
  }
  await frames(5);
  assert(await evaluate(`document.querySelectorAll('.control-section.is-collapsed').length`) === 4, 'mobile reload restores folded sections');
  await click('#sections-toggle');
  await click('[data-payload="ring"]');
  await click('#flight-toggle'); await wait(5200);
  await click('#airdrop-toggle'); await wait(1000);
  const reducedFall = await evaluate(`(()=>{const r=window.droneReview.model.payloadRig.ringFloat.rotation;return {x:r.x,y:r.y,z:r.z,airdrop:window.droneReview.inspect().airdrop}})()`);
  assert(reducedFall.airdrop === 'dropping' && reducedFall.x === 0 && reducedFall.z === 0, `reduced motion tumble ${JSON.stringify(reducedFall)}`);
  await wait(1600);
  assert((await inspect()).airdrop === 'landed', 'reduced-motion airdrop landed');
  await click('#flight-toggle'); await wait(4400);
  await click('#airdrop-toggle');
  const reducedRecovered = await inspect();
  assert(reducedRecovered.airdrop === 'idle' && reducedRecovered.ringAttached === true, 'reduced-motion recover');
  log.push({ step: 'airdrop-reduced-motion', rotation: reducedFall, landed: true });

  assert(errors.length === 0, `console errors: ${JSON.stringify(errors)}`);
  await writeFile(resolve('evidence', 'animation-probe.json'), JSON.stringify({ passed: true, log, errors }, null, 2));
  console.log(JSON.stringify({ passed: true, log, errors }, null, 2));
  await send('Browser.close', {}, false);
} catch (error) {
  await writeFile(resolve('evidence', 'animation-probe.json'), JSON.stringify({ passed: false, log, errors, failure: error.stack }, null, 2));
  console.error(error); process.exitCode = 1;
} finally {
  socket?.close();
  if (chrome.exitCode === null) chrome.kill();
  await exited;
  await rm(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 });
}
function assert(value, message) { if (!value) throw new Error(message); }
