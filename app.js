import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { VignetteShader } from 'three/examples/jsm/shaders/VignetteShader.js';
import { ColorCorrectionShader } from 'three/examples/jsm/shaders/ColorCorrectionShader.js';

import { VRMLoaderPlugin, VRMUtils, VRMHumanBoneName } from '@pixiv/three-vrm';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from '@pixiv/three-vrm-animation';

// ---------------- VRMA (motion pack) ----------------
// Loads .vrma files (VRM Animation) and plays them via AnimationMixer.
// NOTE: The user's VRMA_MotionPack contains only gestures/poses (no locomotion walk).
let vrmaMixer = null;
let vrmaActions = {}; // key -> THREE.AnimationAction
let vrmaCurrentKey = null;
let vrmaLoaded = false;
const IDLE_VRMA_KEY = 'motion7';

// ---------------- UI ----------------
const elMessages = document.getElementById('messages');
const elText = document.getElementById('text');
const elSend = document.getElementById('send');
const elLoading = document.getElementById('loading');
const elAudioGate = document.getElementById('audioGate');

function addBubble(who, text, isUser=false){
  const wrap = document.createElement('div');
  wrap.className = 'bubble' + (isUser ? ' user' : '');
  wrap.innerHTML = `<div class="who"></div><div class="msg"></div>`;
  wrap.querySelector('.who').textContent = who;
  wrap.querySelector('.msg').textContent = text;
  elMessages.appendChild(wrap);
  elMessages.scrollTop = elMessages.scrollHeight;
}

function setLoadingText(title, desc=''){
  const t = elLoading?.querySelector('.title');
  const d = elLoading?.querySelector('.desc');
  if (t) t.textContent = title;
  if (d) d.textContent = desc;
}

function hideLoadingOverlay(){
  if (!elLoading) return;
  elLoading.classList.add('fadeout');
  setTimeout(() => {
    if (elLoading) elLoading.style.display = 'none';
  }, 480);
}


// ---------------- Helpers ----------------
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const rand = (a,b) => a + Math.random()*(b-a);
const easeInOut = (t) => (t < 0.5 ? 2*t*t : 1 - Math.pow(-2*t+2,2)/2);

// three.js doesn't provide MathUtils.lerpAngle; implement shortest-path angle lerp.
function lerpAngle(a, b, t){
  const twoPi = Math.PI * 2;
  const diff = THREE.MathUtils.euclideanModulo((b - a + Math.PI), twoPi) - Math.PI;
  return a + diff * t;
}

function isMobile(){
  return matchMedia('(max-width: 879px)').matches || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

// ---------------- TTS (Web Speech API) ----------------
let ttsEnabled = localStorage.getItem('ttsEnabled') === '1';
let speaking = false;
let speakingText = '';
let speechStartedAt = 0;
let lipPlan = null;
let lipPulse = 0;
let cachedVoice = null;
let voicesReadyPromise = null;

function updateAudioGate(){
  elAudioGate?.classList.toggle('hidden', ttsEnabled);
}
updateAudioGate();

async function waitVoicesReady(timeoutMs=2500){
  if (!('speechSynthesis' in window)) return [];
  if (voicesReadyPromise) return voicesReadyPromise;

  voicesReadyPromise = new Promise((resolve) => {
    const t0 = performance.now();
    const tick = () => {
      const v = speechSynthesis.getVoices?.() ?? [];
      if (v.length || performance.now() - t0 > timeoutMs){
        resolve(v);
        return;
      }
      setTimeout(tick, 100);
    };
    tick();
  });

  return voicesReadyPromise;
}

function pickCuteKoreanVoice(voices){
  if (!voices?.length) return null;
  const ko = voices.filter(v => (v.lang || '').toLowerCase().startsWith('ko'));
  const score = (v) => {
    const name = (v.name || '').toLowerCase();
    let s = 0;
    if ((v.lang || '').toLowerCase().startsWith('ko')) s += 10;
    if (name.includes('female')) s += 2;
    if (name.includes('heami')) s += 4;
    if (name.includes('seoyeon')) s += 3;
    if (name.includes('jiyoung')) s += 2;
    if (name.includes('google')) s += 1;
    return s;
  };
  const pool = ko.length ? ko : voices;
  return [...pool].sort((a,b) => score(b) - score(a))[0] || pool[0] || null;
}

async function ensureVoiceCache(){
  if (cachedVoice) return;
  const voices = await waitVoicesReady();
  cachedVoice = pickCuteKoreanVoice(voices);
}

speechSynthesis?.addEventListener?.('voiceschanged', () => {
  cachedVoice = null;
  voicesReadyPromise = null;
});

// Lip sync plan is generated below (Hangul vowel buckets) so we don't need a real phoneme engine.

function speak(text){
  if (!ttsEnabled || !('speechSynthesis' in window)) return;
  speakingText = text;
  lipPlan = buildLipPlan(text);
  // iOS/모바일은 사용자 제스처 이후에만 안정적으로 재생되는 경우가 많아서
  // 버튼을 눌러 음성 허용을 켠 뒤에만 말하도록 처리.
  ensureVoiceCache().then(() => {
    try{
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      if (cachedVoice) u.voice = cachedVoice;
      u.lang = cachedVoice?.lang || 'ko-KR';
      // "귀엽게" 들리도록 살짝 높은 피치 + 약간 빠른 속도
      u.pitch = 1.28;
      u.rate = 1.06;
      u.volume = 1;
      u.onstart = () => { speaking = true; speechStartedAt = performance.now(); lipPulse = 0.35; };
      u.onend = () => { speaking = false; };
      u.onerror = () => { speaking = false; };
      // 일부 브라우저(특히 데스크탑)는 boundary 이벤트를 지원함
      // (안드로이드는 환경에 따라 지원이 들쭉날쭉해서, 지원되면 보너스 정도로 사용)
      u.onboundary = (e) => {
        // word/sentence boundary일 때 입을 살짝 더 크게
        if (e?.name) lipPulse = 0.65;
      };
      speechSynthesis.speak(u);
    }catch(e){
      console.warn('TTS failed', e);
    }
  });
}

elAudioGate?.addEventListener('click', () => {
  ttsEnabled = true;
  localStorage.setItem('ttsEnabled', '1');
  updateAudioGate();
  addBubble('시스템', '음성을 켰어요. 이제부터 캐릭터가 읽어줄게요!');
  // Prime voices
  ensureVoiceCache();
});

// ---------------- Three.js ----------------
const canvas = document.getElementById('stage');
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: !isMobile(),
  alpha: true,
  powerPreference: 'high-performance'
});
renderer.setClearColor(0x000000, 0);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = isMobile() ? 1.02 : 1.08; // tuned to match VRoidHub-like preview (less dazzling)

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xf6d9ff, 6, 22);
// Subtle studio-like environment reflections (helps skin highlights without bloom)
try{
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  scene.environment = envTex;
}catch{ /* ignore */ }

// Eye gaze target (drives VRM lookAt)
const gazeTarget = new THREE.Object3D();
scene.add(gazeTarget);


const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
camera.position.set(0.0, 1.35, 3.15);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.target.set(0, 1.2, 0);
controls.minDistance = 1.6;
controls.maxDistance = 6.0;
controls.maxPolarAngle = Math.PI * 0.49;
controls.minPolarAngle = Math.PI * 0.18;
controls.enablePan = false;
if (isMobile()){
  // 모바일은 제스처 충돌을 줄이기 위해 회전만 허용
  controls.enableZoom = true;
}

// --- Postprocessing (bright: color grading + vignette + FXAA; no bloom) ---
const composer = new EffectComposer(renderer);
const renderPass = new RenderPass(scene, camera);
composer.addPass(renderPass);


const colorPass = new ShaderPass(ColorCorrectionShader);
colorPass.uniforms.powRGB.value.set(1.0, 1.0, 1.0);
colorPass.uniforms.mulRGB.value.set(1.03, 1.02, 1.04);
colorPass.uniforms.addRGB.value.set(0.008, 0.008, 0.010);
composer.addPass(colorPass);

const vignettePass = new ShaderPass(VignetteShader);
vignettePass.uniforms.offset.value = 1.0;
vignettePass.uniforms.darkness.value = isMobile() ? 0.60 : 0.70;
composer.addPass(vignettePass);

const fxaaPass = new ShaderPass(FXAAShader);
composer.addPass(fxaaPass);

const outputPass = new OutputPass();
composer.addPass(outputPass);


function onResize(){
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  // Android 성능/발열/메모리 이슈를 줄이기 위해 모바일 DPR 상한을 낮춤
  // Mobile perf: keep DPR low to reduce memory/bandwidth and prevent "stuck" loads on some Android devices.
  const dprCap = isMobile() ? 0.95 : 2;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, dprCap));
  renderer.setSize(w, h, false);
  composer.setSize(w, h);
  const pr = renderer.getPixelRatio();
  fxaaPass.material.uniforms['resolution'].value.set(1 / (w * pr), 1 / (h * pr));
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', onResize);
window.addEventListener('orientationchange', () => setTimeout(onResize, 200));

// --- Avatar tap: play a random saved motion ---
const raycaster = new THREE.Raycaster();
const pointerNDC = new THREE.Vector2();
let tapStart = null;

function playRandomVRMA(){
  if (!vrm) return false;
  if (!vrmaLoaded){
    // If the motion pack isn't ready yet, load it and then retry once.
    loadVRMAMotionPack().then(() => {
      if (vrmaLoaded) playRandomVRMA();
    });
    return true;
  }
  const keys = Object.keys(vrmaActions).filter((k) => k && k !== IDLE_VRMA_KEY);
  if (!keys.length) return false;
  let pick = keys[Math.floor(Math.random() * keys.length)];
  if (keys.length > 1 && pick === vrmaCurrentKey){
    pick = keys[(keys.indexOf(pick) + 1) % keys.length];
  }
  return playVRMA(pick, { loop: 'once' });
}

function getPointerNDC(ev){
  const rect = renderer.domElement.getBoundingClientRect();
  const x = (ev.clientX - rect.left) / rect.width;
  const y = (ev.clientY - rect.top) / rect.height;
  pointerNDC.x = x * 2 - 1;
  pointerNDC.y = -(y * 2 - 1);
}

function hitTestAvatar(ev){
  if (!vrm) return false;
  getPointerNDC(ev);
  raycaster.setFromCamera(pointerNDC, camera);
  const hits = raycaster.intersectObject(vrm.scene, true);
  return hits && hits.length > 0;
}

renderer.domElement.addEventListener('pointerdown', (ev) => {
  if (ev.pointerType === 'mouse' && ev.button !== 0) return;
  tapStart = { x: ev.clientX, y: ev.clientY, t: performance.now(), id: ev.pointerId };
});
renderer.domElement.addEventListener('pointerup', (ev) => {
  if (!tapStart || ev.pointerId !== tapStart.id) return;
  const dt = performance.now() - tapStart.t;
  const dx = ev.clientX - tapStart.x;
  const dy = ev.clientY - tapStart.y;
  const dist = Math.hypot(dx, dy);
  tapStart = null;
  if (dt > 450 || dist > 8) return; // treat as drag, not tap
  if (hitTestAvatar(ev)){
    ev.preventDefault();
    playRandomVRMA();
  }
});

// Lights
scene.add(new THREE.AmbientLight(0xffffff, 0.65));
const key = new THREE.DirectionalLight(0xffffff, 1.10);
key.position.set(2.5, 4.0, 2.0);
scene.add(key);
const rim = new THREE.DirectionalLight(0xffe6f4, 0.35);
rim.position.set(-2.5, 2.2, -2.8);
scene.add(rim);
const hemi = new THREE.HemisphereLight(0xdff4ff, 0xffe7f2, 0.45);
scene.add(hemi);


// ---------------- Classroom corner diorama (no roof, no front wall) ----------------
const room = new THREE.Group();
scene.add(room);

function makePosterTexture(){
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 512;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#f2f5fb';
  ctx.fillRect(0,0,c.width,c.height);
  ctx.fillStyle = '#0b1220';
  ctx.font = 'bold 46px system-ui, sans-serif';
  ctx.fillText('오늘의', 42, 92);
  ctx.fillText('한마디', 42, 150);
  ctx.font = '28px system-ui, sans-serif';
  ctx.fillStyle = '#334155';
  const lines = [
    '1) 인사 / 기쁨 / 슬픔 / 화남',
    '2) "고마워" / "미안" / "졸려"',
    '3) 그냥 아무 말이나 해도 돼요'
  ];
  lines.forEach((l,i)=>ctx.fillText(l, 42, 230 + i*44));
  ctx.fillStyle = '#1d4ed8';
  ctx.fillRect(42, 360, 428, 6);
  ctx.fillStyle = '#0b1220';
  ctx.font = 'bold 34px system-ui, sans-serif';
  ctx.fillText('VTuber 교실', 42, 430);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function buildRoom(){
  // Floor
  const floorMat = new THREE.MeshStandardMaterial({ color: 0x8a6a4a, roughness: 0.92, metalness: 0.0 });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(6, 6), floorMat);
  floor.rotation.x = -Math.PI/2;
  floor.position.y = 0;
  room.add(floor);

  // Walls (corner)
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xcfd7e6, roughness: 1.0, metalness: 0.0 });
  const wallA = new THREE.Mesh(new THREE.PlaneGeometry(6, 3), wallMat);
  wallA.position.set(0, 1.5, -3);
  room.add(wallA);

  const wallB = new THREE.Mesh(new THREE.PlaneGeometry(6, 3), wallMat);
  wallB.rotation.y = Math.PI/2;
  wallB.position.set(-3, 1.5, 0);
  room.add(wallB);

  // Base trim
  const trimMat = new THREE.MeshStandardMaterial({ color: 0xb6c4dc, roughness: 1.0, metalness: 0.0 });
  const trimA = new THREE.Mesh(new THREE.BoxGeometry(6, 0.08, 0.12), trimMat);
  trimA.position.set(0, 0.04, -2.94);
  room.add(trimA);
  const trimB = new THREE.Mesh(new THREE.BoxGeometry(6, 0.08, 0.12), trimMat);
  trimB.rotation.y = Math.PI/2;
  trimB.position.set(-2.94, 0.04, 0);
  room.add(trimB);

  // Blackboard
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x3a2e24, roughness: 0.9, metalness: 0.0 });
  const boardMat = new THREE.MeshStandardMaterial({ color: 0x1f3b2e, roughness: 0.95, metalness: 0.0 });
  const boardFrame = new THREE.Mesh(new THREE.BoxGeometry(2.7, 1.5, 0.06), frameMat);
  boardFrame.position.set(0.9, 1.55, -2.95);
  room.add(boardFrame);
  const board = new THREE.Mesh(new THREE.PlaneGeometry(2.56, 1.36), boardMat);
  board.position.set(0.9, 1.55, -2.92);
  room.add(board);

  // Poster
  const posterTex = makePosterTexture();
  const posterMat = new THREE.MeshStandardMaterial({ map: posterTex, roughness: 0.95, metalness: 0.0 });
  const poster = new THREE.Mesh(new THREE.PlaneGeometry(0.95, 0.95), posterMat);
  poster.position.set(-2.92, 1.25, -0.2);
  poster.rotation.y = Math.PI/2;
  room.add(poster);

  // Window
  const winFrame = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.1, 0.06), frameMat);
  winFrame.position.set(-2.92, 1.55, 1.35);
  winFrame.rotation.y = Math.PI/2;
  room.add(winFrame);
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x9dd2ff, transparent: true, opacity: 0.22, roughness: 0.1, metalness: 0.0 });
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.0), glassMat);
  glass.position.set(-2.89, 1.55, 1.35);
  glass.rotation.y = Math.PI/2;
  room.add(glass);

  // Desk (simple)
  const deskTop = new THREE.Mesh(
    new THREE.BoxGeometry(1.2, 0.08, 0.65),
    new THREE.MeshStandardMaterial({ color: 0xb98a5e, roughness: 0.85, metalness: 0.0 })
  );
  deskTop.position.set(0.85, 0.78, -1.55);
  room.add(deskTop);
  const legMat = new THREE.MeshStandardMaterial({ color: 0x8a96a8, roughness: 0.9, metalness: 0.0 });
  const legGeo = new THREE.BoxGeometry(0.06, 0.78, 0.06);
  const legs = [
    [-0.55, -0.28], [0.55, -0.28], [-0.55, 0.28], [0.55, 0.28]
  ];
  legs.forEach(([x,z])=>{
    const leg = new THREE.Mesh(legGeo, legMat);
    leg.position.set(0.85 + x*0.9, 0.39, -1.55 + z*0.9);
    room.add(leg);
  });

  // Chair (place it cleanly in front of the desk; avoid intersection)
  const chairX = 0.85;
  const chairZ = -0.95;
  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.06, 0.55), new THREE.MeshStandardMaterial({ color: 0x6d7f97, roughness: 0.9 }));
  seat.position.set(chairX, 0.45, chairZ);
  room.add(seat);
  const back = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.5, 0.06), new THREE.MeshStandardMaterial({ color: 0x6d7f97, roughness: 0.9 }));
  back.position.set(chairX, 0.74, chairZ - 0.25);
  room.add(back);
  const chairLegGeo = new THREE.BoxGeometry(0.05, 0.45, 0.05);
  [[-0.22,-0.22],[0.22,-0.22],[-0.22,0.22],[0.22,0.22]].forEach(([x,z])=>{
    const leg = new THREE.Mesh(chairLegGeo, legMat);
    leg.position.set(chairX + x, 0.225, chairZ + z);
    room.add(leg);
  });

  // Small lamp (emissive)
  const lamp = new THREE.Mesh(
    new THREE.SphereGeometry(0.085, 20, 20),
    new THREE.MeshStandardMaterial({ color: 0xfff2bf, emissive: 0xffe3a0, emissiveIntensity: 0.55 })
  );
  lamp.position.set(0.55, 1.02, -1.65);
  room.add(lamp);

  // Bookshelf (low poly)
  const shelfMat = new THREE.MeshStandardMaterial({ color: 0xa57a51, roughness: 0.9, metalness: 0.0 });
  const shelf = new THREE.Mesh(new THREE.BoxGeometry(0.85, 1.35, 0.3), shelfMat);
  shelf.position.set(-2.35, 0.675, -1.85);
  shelf.rotation.y = Math.PI/2;
  room.add(shelf);
  const bookColors = [0xff6b6b, 0x6bcB77, 0x4d96ff, 0xffc300, 0x9b5de5];
  for (let i=0;i<10;i++){
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.18, 0.18), new THREE.MeshStandardMaterial({ color: bookColors[i%bookColors.length], roughness: 0.95 }));
    b.position.set(-2.48 + rand(-0.03,0.03), 0.28 + Math.floor(i/5)*0.42, -1.98 + (i%5)*0.07);
    b.rotation.y = Math.PI/2;
    room.add(b);
  }

  // Wall clock
  const clockBase = new THREE.Mesh(new THREE.CylinderGeometry(0.18,0.18,0.04,16), new THREE.MeshStandardMaterial({ color: 0xf6f2ea, roughness: 1 }));
  clockBase.position.set(-0.35, 2.35, -2.93);
  clockBase.rotation.x = Math.PI/2;
  room.add(clockBase);
  const clockHands = new THREE.Mesh(new THREE.BoxGeometry(0.02,0.12,0.01), new THREE.MeshStandardMaterial({ color: 0x22303f, roughness: 1 }));
  clockHands.position.set(-0.35, 2.35, -2.91);
  clockHands.rotation.z = 0.7;
  room.add(clockHands);

  // Desk items (books + chalk)
  const book = new THREE.Mesh(new THREE.BoxGeometry(0.22,0.04,0.16), new THREE.MeshStandardMaterial({ color: 0x4d96ff, roughness: 0.95 }));
  book.position.set(1.15, 0.83, -1.52);
  room.add(book);
  const chalk = new THREE.Mesh(new THREE.CylinderGeometry(0.01,0.01,0.1,10), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 }));
  chalk.position.set(0.1, 1.05, -2.88);
  chalk.rotation.z = Math.PI/3;
  room.add(chalk);

  // Ceiling edge frame (ceiling itself is removed)
  const beamMat = new THREE.MeshStandardMaterial({ color: 0xd7deea, roughness: 1.0 });
  const beamA = new THREE.Mesh(new THREE.BoxGeometry(6, 0.08, 0.08), beamMat);
  beamA.position.set(0, 2.98, -2.96);
  room.add(beamA);
  const beamB = new THREE.Mesh(new THREE.BoxGeometry(6, 0.08, 0.08), beamMat);
  beamB.rotation.y = Math.PI/2;
  beamB.position.set(-2.96, 2.98, 0);
  room.add(beamB);
}

buildRoom();

// ---------------- Avatar (VRM) ----------------
const vrmLoader = new GLTFLoader();
vrmLoader.register((parser) => new VRMLoaderPlugin(parser, { autoUpdateHumanBones: true }));

let vrm = null;
let avatarRoot = null;
let bones = {};
let fallback = null;
let baseLook = { head: null, neck: null, chest: null };
let yawOffset = 0; // auto-calibrated so the avatar doesn't "walk backwards"

function toStandardMaterials(obj){
  obj.traverse((n) => {
    if (!n.isMesh) return;
    const mats = Array.isArray(n.material) ? n.material : [n.material];
    const newMats = mats.map((m) => {
      const std = new THREE.MeshStandardMaterial({
        color: (m.color ? m.color.clone() : new THREE.Color(0xffffff)),
        map: m.map || null,
        emissive: m.emissive ? m.emissive.clone() : new THREE.Color(0x000000),
        emissiveMap: m.emissiveMap || null,
        transparent: !!m.transparent,
        opacity: (typeof m.opacity === 'number') ? m.opacity : 1,
        side: m.side,
        roughness: 0.88,
        metalness: 0.0
      });
      std.alphaTest = m.alphaTest || 0;
      std.depthWrite = m.depthWrite;
      return std;
    });
    n.material = Array.isArray(n.material) ? newMats : newMats[0];
  });
}

function tuneSkinHighlights(obj){
  // Goal: no bloom, but keep skin looking lively with gentle specular highlights.
  // Heuristic: match face/body/skin materials; exclude eyes/hair/clothes.
  const isSkinLike = (meshName, mat, mapSrc) => {
    const s = `${meshName||''} ${mat?.name||''} ${mapSrc||''}`.toLowerCase();
    const has = (...keys) => keys.some(k => s.includes(k));
    const not = (...keys) => keys.some(k => s.includes(k));
    if (not('eye','iris','pupil','sclera','lash','brow','teeth','tongue','mouth','hair','cloth','skirt','shoe','sock','uniform','button','tie')) return false;
    return has('skin','face','body','head','hada','flesh','arm','leg','neck');
  };

  obj.traverse((n) => {
    if (!n.isMesh) return;
    const mats = Array.isArray(n.material) ? n.material : [n.material];
    let changed = false;

    const tuned = mats.map((m) => {
      if (!m) return m;
      const mapSrc = m.map?.image?.src || m.map?.source?.data?.src || '';
      if (!isSkinLike(n.name, m, mapSrc)) return m;

      // Upgrade to physical material for nicer highlights, preserving textures.
      const phys = new THREE.MeshPhysicalMaterial();
      // Basic copies
      if (m.color) phys.color = m.color.clone();
      phys.map = m.map || null;
      phys.emissive = (m.emissive ? m.emissive.clone() : new THREE.Color(0x000000));
      phys.emissiveMap = m.emissiveMap || null;
      phys.normalMap = m.normalMap || null;
      phys.roughnessMap = m.roughnessMap || null;
      phys.metalnessMap = m.metalnessMap || null;
      phys.alphaMap = m.alphaMap || null;
      phys.transparent = !!m.transparent;
      phys.opacity = (typeof m.opacity === 'number') ? m.opacity : 1;
      phys.side = m.side;
      phys.alphaTest = m.alphaTest || 0;
      phys.depthWrite = m.depthWrite;

      // Tuning: gentle, not oily
      phys.metalness = 0.0;
      phys.roughness = 0.55;
      phys.clearcoat = 0.10;
      phys.clearcoatRoughness = 0.65;
      phys.reflectivity = 0.20;
      phys.envMapIntensity = 0.35;

      // Optional newer props (safe even if ignored)
      try{
        if ('ior' in phys) phys.ior = 1.4;
        if ('specularIntensity' in phys) phys.specularIntensity = 0.25;
        if ('specularColor' in phys) phys.specularColor.set(0xffffff);
      }catch{}

      phys.needsUpdate = true;
      changed = true;
      try{ m.dispose?.(); }catch{}
      return phys;
    });

    if (changed){
      n.material = Array.isArray(n.material) ? tuned : tuned[0];
    }
  });
}
function setExpression(name, v){
  if (!vrm?.expressionManager) return;
  try{ vrm.expressionManager.setValue(name, v); }catch{ /* ignore */ }
}

function pickFirstAvailable(names){
  const em = vrm?.expressionManager;
  if (!em) return null;
  for (const n of names){
    if (em.getExpressionTrackName?.(n) || em.getValue?.(n) !== undefined){
      return n;
    }
  }
  // Some builds expose expressionMap
  const keys = (em.expressionMap && Object.keys(em.expressionMap)) || [];
  for (const n of names){
    if (keys.includes(n)) return n;
  }
  return null;
}

let exprBlink = null;
let exprHappy = null;
let exprSad = null;
let exprAngry = null;
let exprVowels = { a:null, i:null, u:null, e:null, o:null };

function detectExpressions(){
  exprBlink = pickFirstAvailable(['blink', 'Blink']);
  exprHappy = pickFirstAvailable(['happy', 'joy', 'Fun', 'smile']);
  exprSad = pickFirstAvailable(['sad', 'Sorrow']);
  exprAngry = pickFirstAvailable(['angry', 'Angry']);
  // Surprise / shy are optional (model dependent)
  // We'll set them if present.
  // (names vary by exporter)
  exprSurprise = pickFirstAvailable(['surprised', 'Surprised', 'surprise']);
  exprShy = pickFirstAvailable(['blush', 'Blush', 'shy']);

  // Mouth shapes differ by model
  const a = pickFirstAvailable(['aa','A']);
  const i = pickFirstAvailable(['ih','I']);
  const u = pickFirstAvailable(['ou','U']);
  const e = pickFirstAvailable(['ee','E']);
  const o = pickFirstAvailable(['oh','O']);
  exprVowels = { a,i,u,e,o };
}

let exprSurprise = null;
let exprShy = null;

async function loadAvatar(){
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      setLoadingText('로딩이 조금 오래 걸려요…', '모바일은 네트워크/메모리 상태에 따라 시간이 더 걸릴 수 있어요.');
    }, 8000);

    const onProgress = (xhr) => {
      if (!xhr?.total) return;
      // Some servers report compressed totals; loaded can briefly exceed total.
      // Clamp to 1..99 while loading; set to 100 only when onLoad fires.
      const raw = (xhr.loaded / xhr.total) * 100;
      const p = Math.max(1, Math.min(99, Math.round(raw)));
      setLoadingText('아바타 로딩중…', `${p}%`);
    };

    vrmLoader.load('assets/avatar.vrm', (gltf) => {
      clearTimeout(timeout);
      const loaded = gltf.userData.vrm;
      if (!loaded){
        resolve(false);
        return;
      }

      vrm = loaded;

      // VRM0 -> Three.js axis, etc.
      VRMUtils.rotateVRM0(vrm);

      avatarRoot = vrm.scene;
      avatarRoot.position.set(0.2, 0, -0.25);
      avatarRoot.rotation.y = 0;
      scene.add(avatarRoot);

      // Calibrate model forward direction.
      // Some VRM models face -Z in their local space, which makes movement look like walking backwards.
      // We compare +Z vs -Z against the camera direction and pick the one that best faces the camera.
      try{
        const q = new THREE.Quaternion();
        avatarRoot.getWorldQuaternion(q);
        const fwd = new THREE.Vector3(0,0,-1).applyQuaternion(q);
        const toCam = new THREE.Vector3().subVectors(camera.position, avatarRoot.position);
        toCam.y = 0;
        if (toCam.lengthSq() > 1e-6) toCam.normalize();
        const dotPlus = fwd.dot(toCam);
        const dotMinus = fwd.clone().multiplyScalar(-1).dot(toCam);
        if (dotMinus > dotPlus){ avatarRoot.rotation.y += Math.PI; }
        yawOffset = 0;
      }catch{
        yawOffset = 0;
      }

      // If we were using a lightweight fallback on mobile, swap to the real avatar now
      if (fallback){
        scene.remove(fallback);
        fallback = null;
      }

      // 모바일 안정성: MToon 셰이더 대신 표준 머티리얼로 변환
      toStandardMaterials(avatarRoot);
      tuneSkinHighlights(avatarRoot);

      // Remove unnecessary stuff to speed up
      try{ VRMUtils.removeUnnecessaryJoints(avatarRoot); }catch{}
      // Cache bone refs (prefer normalized bones for posing; fallback to raw if needed)
      const h = vrm.humanoid;
      const getBone = (name) => (h.getNormalizedBoneNode?.(name) || h.getRawBoneNode?.(name) || null);
      bones = {
        head: getBone(VRMHumanBoneName.Head),
        neck: getBone(VRMHumanBoneName.Neck),
        chest: getBone(VRMHumanBoneName.Chest),
        spine: getBone(VRMHumanBoneName.Spine),
        hips: getBone(VRMHumanBoneName.Hips),
        rUpperArm: getBone(VRMHumanBoneName.RightUpperArm),
        rLowerArm: getBone(VRMHumanBoneName.RightLowerArm),
        rHand: getBone(VRMHumanBoneName.RightHand),
        lUpperArm: getBone(VRMHumanBoneName.LeftUpperArm),
        lLowerArm: getBone(VRMHumanBoneName.LeftLowerArm),
        lHand: getBone(VRMHumanBoneName.LeftHand),
        // legs
        rUpperLeg: getBone(VRMHumanBoneName.RightUpperLeg),
        rLowerLeg: getBone(VRMHumanBoneName.RightLowerLeg),
        rFoot: getBone(VRMHumanBoneName.RightFoot),
        rToes: getBone(VRMHumanBoneName.RightToes),
        lUpperLeg: getBone(VRMHumanBoneName.LeftUpperLeg),
        lLowerLeg: getBone(VRMHumanBoneName.LeftLowerLeg),
        lFoot: getBone(VRMHumanBoneName.LeftFoot),
        lToes: getBone(VRMHumanBoneName.LeftToes)
      };

      detectExpressions();

      // Cache base local rotations for look-at offsets
      baseLook = {
        head: bones.head?.quaternion?.clone?.() || null,
        neck: bones.neck?.quaternion?.clone?.() || null,
        chest: bones.chest?.quaternion?.clone?.() || null
      };

      // Calm base pose
      applyUpperBodyPose(0, { kind:'idle', wave:0, happy:0, sad:0, angry:0, talk:0 }, 1);
      // Avoid initial T-pose flash: keep avatar hidden until motion pack is ready
      if (vrm?.scene) vrm.scene.visible = false;

      resolve(true);
    }, onProgress, (err) => {
      clearTimeout(timeout);
      console.error('VRM load failed', err);
      resolve(false);
    });
  });
}

async function loadVRMAMotionPack(){
  if (!vrm || vrmaLoaded) return;

  // Prepare mixer on the avatar root
  vrmaMixer = new THREE.AnimationMixer(vrm.scene);
  vrmaActions = {};
  vrmaCurrentKey = null;
  vrmaLoaded = false;

  // When a VRMA (gesture) ends, fall back to procedural idle
  vrmaMixer.addEventListener('finished', () => {
    const prev = vrmaCurrentKey;
    vrmaCurrentKey = null;
    // After one-shot gestures, return to a looping idle (if available)
    if (prev && prev !== IDLE_VRMA_KEY && vrmaActions[IDLE_VRMA_KEY]){
      playVRMA(IDLE_VRMA_KEY, { loop: 'repeat', fadeIn: 0.25 });
    }
  });

  const animLoader = new GLTFLoader();
  animLoader.register((parser) => new VRMAnimationLoaderPlugin(parser));

  const files = [
    ['show',     'assets/motions/VRMA_01.vrma'],
    ['greeting', 'assets/motions/VRMA_02.vrma'],
    ['peace',    'assets/motions/VRMA_03.vrma'],
    ['shoot',    'assets/motions/VRMA_04.vrma'],
    ['spin',     'assets/motions/VRMA_05.vrma'],
    ['pose',     'assets/motions/VRMA_06.vrma'],
    ['squat',    'assets/motions/VRMA_07.vrma'],
    ['motion7',  'assets/motions/VRMA_07.vrma'],
  ];

  const loadOne = (url) => new Promise((resolve) => {
    animLoader.load(
      url,
      (gltf) => {
        const list = gltf?.userData?.vrmAnimations;
        resolve(Array.isArray(list) && list.length ? list[0] : null);
      },
      undefined,
      () => resolve(null),
    );
  });

  // Load sequentially to reduce memory spikes on mobile.
  for (const [key, url] of files){
    const vrmAnim = await loadOne(url);
    if (!vrmAnim) continue;
    const clip = createVRMAnimationClip(vrmAnim, vrm);
    const action = vrmaMixer.clipAction(clip);
    action.enabled = true;
    action.clampWhenFinished = true;
    vrmaActions[key] = action;
  }

  vrmaLoaded = Object.keys(vrmaActions).length > 0;
}

function playVRMA(key, opts = {}){
  if (!vrmaLoaded || !vrmaMixer) return false;
  const action = vrmaActions[key];
  if (!action) return false;

  const loop = opts.loop ?? 'once'; // 'once' | 'repeat'
  const fadeIn = opts.fadeIn ?? 0.12;
  const fadeOut = opts.fadeOut ?? 0.15;

  // Stop current VRMA action (if any)
  if (vrmaCurrentKey && vrmaActions[vrmaCurrentKey]){
    vrmaActions[vrmaCurrentKey].fadeOut(fadeOut);
  }

  vrmaCurrentKey = key;
  action.reset();

  if (loop === 'repeat'){
    action.setLoop(THREE.LoopRepeat, Infinity);
  } else {
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
  }

  action.fadeIn(fadeIn);
  action.play();

  // Keep attention / stop wandering during one-shot gestures
  if (loop !== 'repeat'){
    try{
      const d = Math.max(0.8, action.getClip().duration || 2.0);
      requestAttention(d + 1.0);
      if (interaction){
        interaction.mode = 'respond';
        interaction.respondUntil = clock.elapsedTime + d + 0.2;
      }
    }catch{}
  }
  return true;
}

function isVRMAActive(){
  if (!vrmaLoaded || !vrmaCurrentKey) return false;
  const a = vrmaActions[vrmaCurrentKey];
  return !!(a && a.isRunning());
}

// ---------- Mobile fallback avatar (very light) ----------
function createFallbackAvatar(){
  const g = new THREE.Group();
  const skin = new THREE.MeshStandardMaterial({ color: 0xffd3c4, roughness: 0.9, metalness: 0.0 });
  const hair = new THREE.MeshStandardMaterial({ color: 0x223e7a, roughness: 0.95, metalness: 0.0 });
  const cloth = new THREE.MeshStandardMaterial({ color: 0x3b4a6a, roughness: 0.95, metalness: 0.0 });

  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.48, 4, 12), cloth);
  body.position.y = 0.62;
  g.add(body);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.18, 18, 18), skin);
  head.position.y = 0.98;
  g.add(head);

  const hairCap = new THREE.Mesh(new THREE.SphereGeometry(0.185, 18, 18, 0, Math.PI*2, 0, Math.PI*0.62), hair);
  hairCap.position.copy(head.position);
  hairCap.position.y += 0.03;
  g.add(hairCap);

  // simple face (eyes + mouth plane)
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0x0b1220, roughness: 1.0 });
  const eyeGeo = new THREE.SphereGeometry(0.016, 10, 10);
  const eyeL = new THREE.Mesh(eyeGeo, eyeMat);
  const eyeR = new THREE.Mesh(eyeGeo, eyeMat);
  eyeL.position.set(-0.055, 1.02, 0.165);
  eyeR.position.set( 0.055, 1.02, 0.165);
  g.add(eyeL, eyeR);

  const mouthGeo = new THREE.PlaneGeometry(0.06, 0.02);
  const mouthMat = new THREE.MeshStandardMaterial({ color: 0x7a1c1c, roughness: 1.0, side: THREE.DoubleSide });
  const mouth = new THREE.Mesh(mouthGeo, mouthMat);
  mouth.position.set(0, 0.955, 0.17);
  g.add(mouth);

  g.userData = { head, mouth, eyeL, eyeR };
  g.position.set(0.2, 0, -0.25);
  g.rotation.y = Math.PI * 0.15;
  return g;
}

function showFallbackIfNeeded(){
  if (vrm || fallback) return;
  fallback = createFallbackAvatar();
  scene.add(fallback);
  addBubble('시스템', '모바일 간편 모드로 먼저 시작할게요(더 빠름). 네트워크/기기 상태가 좋아지면 VRM 아바타도 자동으로 시도해요.');
}

// ---------------- Procedural animation ----------------
const clock = new THREE.Clock();

let blinkTimer = rand(2.2, 4.2);
let blinkPhase = 0;
let mouth = 0;
let walkPhase = 0;
let moveAmount = 0; // 0..1

// Wandering around the diorama
const wander = {
  active: false,
  pointIndex: 0,
  nextSwitchAt: 0,
  points: [
    new THREE.Vector3(0.4, 0, -0.4),
    new THREE.Vector3(1.15, 0, -0.9),
    new THREE.Vector3(0.2, 0, 0.25),
    new THREE.Vector3(0.95, 0, 0.15)
  ]
};

function actor(){
  return avatarRoot || fallback;
}

const interaction = {
  mode: 'wander', // 'wander' | 'approach' | 'respond'
  attentionUntil: 0,
  approachTarget: null,
  approachUntil: 0,
  respondUntil: 0
};

function requestAttention(seconds=5){
  interaction.attentionUntil = Math.max(interaction.attentionUntil, clock.elapsedTime + seconds);
}

function startApproachToUser(seconds=6){
  const root = actor();
  if (!root) return;
  requestAttention(seconds);
  interaction.mode = 'approach';
  interaction.respondUntil = 0;

  // Approach a spot closer to the camera (projected to the floor), but keep inside the diorama bounds
  const pos = root.position.clone();
  const toCam = new THREE.Vector3().subVectors(camera.position, pos);
  toCam.y = 0;
  if (toCam.lengthSq() < 1e-6){
    interaction.mode = 'respond';
    interaction.respondUntil = clock.elapsedTime + 2.4;
    return;
  }
  const dir = toCam.clone().normalize();
  const stopDist = 1.85;
  const target = new THREE.Vector3(camera.position.x, 0, camera.position.z).addScaledVector(dir, -stopDist);
  target.x = THREE.MathUtils.clamp(target.x, -2.0, 2.0);
  target.z = THREE.MathUtils.clamp(target.z, -2.0, 2.0);

  interaction.approachTarget = target;
  interaction.approachUntil = clock.elapsedTime + 5.0;
}

function updateApproach(dt){
  const root = actor();
  if (!root || !interaction.approachTarget) return true;
  const pos = root.position;
  const target = interaction.approachTarget;

  const dir = new THREE.Vector3().subVectors(target, pos);
  dir.y = 0;
  const dist = dir.length();

  if (dist < 0.06 || clock.elapsedTime > interaction.approachUntil){
    interaction.mode = 'respond';
    interaction.respondUntil = clock.elapsedTime + 2.6;
    moveAmount = THREE.MathUtils.lerp(moveAmount, 0, 1 - Math.exp(-dt * 8));
    return true;
  }

  dir.normalize();
  const speed = 0.55;
  const step = Math.min(dist, speed * dt);
  pos.addScaledVector(dir, step);

  // Keep inside the diorama floor
  pos.x = THREE.MathUtils.clamp(pos.x, -2.05, 2.05);
  pos.z = THREE.MathUtils.clamp(pos.z, -2.05, 2.05);

  const yaw = Math.atan2(dir.x, -dir.z);
  root.rotation.y = lerpAngle(root.rotation.y, yaw, 1 - Math.exp(-dt * 7));

  // subtle bob
  root.position.y = Math.sin(clock.elapsedTime * 7.2) * 0.003;

  moveAmount = THREE.MathUtils.lerp(moveAmount, 1, 1 - Math.exp(-dt * 6));
  walkPhase += dt * (7.6 + 5.2 * moveAmount);
  return false;
}

function updateInteraction(dt){
  const root = actor();
  if (!root) return;

  if (interaction.mode === 'approach'){
    updateApproach(dt);
    return;
  }

  if (interaction.mode === 'respond'){
    // stand still while responding
    if (clock.elapsedTime >= interaction.respondUntil){
      interaction.mode = 'wander';
    }
    moveAmount = THREE.MathUtils.lerp(moveAmount, 0, 1 - Math.exp(-dt * 7));
    return;
  }

  // wander only when not paying attention
  const attentive = speaking || gesture.type !== 'none' || clock.elapsedTime < interaction.attentionUntil;
  if (!attentive){
    // walking disabled: no wandering movement
    moveAmount = THREE.MathUtils.lerp(moveAmount, 0, 1 - Math.exp(-dt * 8));
  } else {
    moveAmount = THREE.MathUtils.lerp(moveAmount, 0, 1 - Math.exp(-dt * 6));
  }
}

function faceCameraYaw(dt, strength=10){
  const root = actor();
  if (!root) return;

  const p = new THREE.Vector3();
  root.getWorldPosition(p);

  // Direction based on camera position (where the viewer is)
  const dirPos = new THREE.Vector3().subVectors(camera.position, p);
  dirPos.y = 0;
  if (dirPos.lengthSq() < 1e-6) return;
  dirPos.normalize();

  // Direction based on camera forward (what the viewer is facing)
  const dirView = new THREE.Vector3();
  camera.getWorldDirection(dirView);
  dirView.multiplyScalar(-1); // from avatar toward camera view origin
  dirView.y = 0;
  if (dirView.lengthSq() > 1e-6) dirView.normalize();

  // Blend: makes "look at the camera" feel stronger when camera is orbiting
  const dir = dirPos.clone().lerp(dirView, 0.35).normalize();

  const targetYaw = Math.atan2(dir.x, -dir.z);
  root.rotation.y = lerpAngle(root.rotation.y, targetYaw, 1 - Math.exp(-dt * strength));
}


function lookAtCameraUpperBody(dt, strength=1){
  const root = actor();
  if (!root) return;

  // Fallback avatar: rotate the head sphere toward camera
  if (!vrm && fallback?.userData?.head){
    const head = fallback.userData.head;
    const worldPos = new THREE.Vector3();
    head.getWorldPosition(worldPos);
    const q0 = head.quaternion.clone();
    head.lookAt(camera.position);
    const q1 = head.quaternion.clone();
    head.quaternion.copy(q0).slerp(q1, 1 - Math.exp(-dt * 6 * THREE.MathUtils.clamp(strength,0,1)));
    return;
  }

  if (!bones.head || !root) return;

  const headPos = new THREE.Vector3();
  bones.head.getWorldPosition(headPos);
  const toCam = new THREE.Vector3().subVectors(camera.position, headPos);

  // Convert to avatar local space
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  toCam.applyMatrix4(inv);

  const yaw = Math.atan2(toCam.x, toCam.z);
  const pitch = Math.atan2(-toCam.y, Math.sqrt(toCam.x*toCam.x + toCam.z*toCam.z));

  // Limits (a bit stronger than before, but still natural)
  const yawLim = THREE.MathUtils.clamp(yaw, -0.95, 0.95) * THREE.MathUtils.clamp(strength, 0, 1);
  const pitchLim = THREE.MathUtils.clamp(pitch, -0.35, 0.55) * THREE.MathUtils.clamp(strength, 0, 1);

  const aHead = 1 - Math.exp(-dt * 12);
  const aNeck = 1 - Math.exp(-dt * 11);
  const aChest = 1 - Math.exp(-dt * 9);

  const apply = (bone, baseQ, p, y, alpha) => {
    if (!bone || !baseQ) return;
    const off = new THREE.Quaternion().setFromEuler(new THREE.Euler(p, y, 0, 'YXZ'));
    const tgt = baseQ.clone().multiply(off);
    bone.quaternion.slerp(tgt, alpha);
  };

  // Distribute rotation across chest/neck/head for a clearer 'looking at you' feel
  apply(bones.chest, baseLook.chest, pitchLim * 0.22, yawLim * 0.35, aChest);
  apply(bones.neck,  baseLook.neck,  pitchLim * 0.55, yawLim * 0.70, aNeck);
  apply(bones.head,  baseLook.head,  pitchLim * 0.85, yawLim * 1.00, aHead);
}

function lookAtCameraHead(dt){
  // Backward compatibility: keep old name but call new system
  lookAtCameraUpperBody(dt, 1);
}

function updateEyeGaze(dt){
  if (!vrm?.lookAt) return;
  const root = actor();
  if (!root) return;

  // Neutral target: a point in front of the avatar
  const rootPos = new THREE.Vector3();
  root.getWorldPosition(rootPos);
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(root.quaternion).normalize();
  const neutral = rootPos.clone().addScaledVector(fwd, 3.0);
  neutral.y = 1.35;

  // Camera target
  const cam = camera.position.clone();

  // Blend weight: speaking -> strongest, otherwise gentle
  const attentive = speaking || gesture.type !== 'none' || clock.elapsedTime < interaction.attentionUntil || interaction.mode !== 'wander';
  const w = speaking ? 1.0 : (attentive ? 0.65 : 0.25);

  const target = neutral.lerp(cam, w);
  gazeTarget.position.lerp(target, 1 - Math.exp(-dt * 10));
  vrm.lookAt.target = gazeTarget;
}


// Base pose (hands together, calm)
const BASE = {
  // Calm idle: hands gently together in front (no T-pose, no arm flapping)
  // NOTE: values are tuned for the bundled base_female VRM (many exports start in a T-pose).
  // These are *stronger* than before to ensure arms come down instead of staying horizontal.
  rUpperArm: new THREE.Euler(0.10, -0.10, 0.35),
  rLowerArm: new THREE.Euler(-0.70, 0.05, 0.10),
  rHand: new THREE.Euler(0.02, -0.06, 0.06),
  lUpperArm: new THREE.Euler(0.10, 0.10, -0.35),
  lLowerArm: new THREE.Euler(-0.70, -0.05, -0.10),
  lHand: new THREE.Euler(0.02, 0.06, -0.06),
  chest: new THREE.Euler(0.00, 0.00, 0.00)
};

function slerpToEuler(bone, euler, alpha){
  if (!bone) return;
  const q = new THREE.Quaternion().setFromEuler(euler);
  bone.quaternion.slerp(q, alpha);
}

function applyUpperBodyPose(dt, state, alpha){
  // state: {kind, wave, happy, sad, angry, surprise, shy, think, talk, walk}
  const a = alpha ?? (1 - Math.exp(-dt * 10));

  const wave = state.wave || 0;
  const happy = state.happy || 0;
  const sad = state.sad || 0;
  const angry = state.angry || 0;
  const surprise = state.surprise || 0;
  const shy = state.shy || 0;
  const think = state.think || 0;
  const talk = state.talk || 0;
  const walk = state.walk || 0;

  // When a gesture is active, we reduce walk arm swing
  const gesturePower = Math.max(wave, happy, sad, angry, surprise, shy, think);
  const walkSwing = walk * (1 - gesturePower);

  // Chest breathing + mild nod
  const breathe = Math.sin(clock.elapsedTime * 1.6) * 0.012;
  const nod = talk ? Math.sin(clock.elapsedTime * 2.8) * 0.04 * talk : 0;
  const chestEuler = new THREE.Euler(
    BASE.chest.x + breathe + sad*0.10 - angry*0.03 - shy*0.06 + surprise*0.06,
    0,
    0
  );
  slerpToEuler(bones.chest, chestEuler, a);

  const sWalk = Math.sin(walkPhase);
  const swing = 0.0; // keep hands together even while walking
  // Dynamic arm-down bias: if the model's rest pose has arms raised (T/A pose), gently bring them down.
  const armDownBias = (upper, lower, sign) => {
    if (!upper || !lower) return 0;
    const p0 = new THREE.Vector3();
    const p1 = new THREE.Vector3();
    upper.getWorldPosition(p0);
    lower.getWorldPosition(p1);
    const v = p1.sub(p0);
    if (v.lengthSq() < 1e-6) return 0;
    v.normalize();
    // World-space y: -1 is down, 0 is horizontal, +1 is up
    const y = v.y;
    if (y < -0.25) return 0; // already pointing down enough
    const amt = THREE.MathUtils.clamp((y + 0.25) * 1.4, 0, 1.2);
    return sign * amt;
  };


  // Arms: calm by default, small swing when walking, gestures override
  const rUA = new THREE.Euler(
    BASE.rUpperArm.x - 0.08*happy + 0.05*sad + swing*sWalk,
    BASE.rUpperArm.y,
    BASE.rUpperArm.z + swing*0.6 + armDownBias(bones.rUpperArm, bones.rLowerArm, +1)
  );
  const rLA = new THREE.Euler(
    BASE.rLowerArm.x,
    BASE.rLowerArm.y,
    BASE.rLowerArm.z
  );

  // Greeting wave (override right arm)
  if (wave > 0){
    rUA.set(-0.30, -0.55, 0.85);
    rLA.set(-0.85, 0.18, 0.20);
  }

  // Think: right hand near chin
  if (think > 0){
    rUA.set(0.10, -0.25, 0.75);
    rLA.set(-1.05, 0.22, 0.10);
  }

  // Surprise: arms slightly up
  if (surprise > 0){
    rUA.set(-0.15, -0.35, 0.55);
    rLA.set(-0.55, 0.12, 0.05);
  }

  // Shy: bring right hand in, closer to face
  if (shy > 0){
    rUA.set(0.25, -0.10, 0.65);
    rLA.set(-0.95, 0.18, 0.10);
  }

  slerpToEuler(bones.rUpperArm, rUA, a);
  slerpToEuler(bones.rLowerArm, rLA, a);

  if (bones.rHand){
    const wig = wave > 0 ? Math.sin(clock.elapsedTime * 10) * 0.35 * wave : 0;
    slerpToEuler(bones.rHand, new THREE.Euler(0,0,wig), a * 0.7);
  }

  const lUA = new THREE.Euler(
    BASE.lUpperArm.x - 0.08*happy + 0.05*sad - swing*sWalk,
    BASE.lUpperArm.y,
    BASE.lUpperArm.z - swing*0.6 + armDownBias(bones.lUpperArm, bones.lLowerArm, -1)
  );
  const lLA = new THREE.Euler(BASE.lLowerArm.x, BASE.lLowerArm.y, BASE.lLowerArm.z);

  if (think > 0){
    // left arm supports a bit
    lUA.set(0.30, 0.25, -0.55);
    lLA.set(-0.55, -0.05, -0.10);
  }
  if (surprise > 0){
    lUA.set(-0.10, 0.35, -0.55);
    lLA.set(-0.55, -0.12, -0.05);
  }
  if (shy > 0){
    lUA.set(0.30, 0.15, -0.65);
    lLA.set(-0.85, -0.18, -0.10);
  }
  slerpToEuler(bones.lUpperArm, lUA, a);
  slerpToEuler(bones.lLowerArm, lLA, a);
  slerpToEuler(bones.lHand, BASE.lHand, a);

  // Head nod add (keep small, head lookAt handles most)
  if (bones.neck && nod){
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(nod, 0, 0));
    bones.neck.quaternion.slerp(q, 0.15);
  }
}

// Gesture system
let gesture = { type:'none', t:0, dur:0, intensity:1 };
function startGesture(type, dur, intensity=1){
  gesture = { type, t:0, dur, intensity: THREE.MathUtils.clamp(intensity, 0.15, 1.25) };
}

function env(t, dur, attack=0.18, release=0.28){
  if (dur <= 0) return 0;
  const x = clamp01(t / dur);
  const a = clamp01(attack);
  const r = clamp01(release);
  const holdStart = a;
  const holdEnd = Math.max(holdStart, 1 - r);
  if (x < holdStart){
    const u = x / Math.max(1e-6, holdStart);
    return easeInOut(u);
  }
  if (x > holdEnd){
    const u = (1 - x) / Math.max(1e-6, 1 - holdEnd);
    return easeInOut(u);
  }
  return 1;
}

function gestureWeights(){
  if (gesture.type === 'none' || gesture.dur <= 0) return { wave:0, happy:0, sad:0, angry:0, surprise:0, shy:0, think:0 };
  const k = env(gesture.t, gesture.dur) * (gesture.intensity || 1);
  const z = { wave:0, happy:0, sad:0, angry:0, surprise:0, shy:0, think:0 };
  if (gesture.type in z) z[gesture.type] = k;
  if (gesture.type === 'wave') z.wave = k;
  return z;
}

function updateGesture(dt){
  if (gesture.type === 'none') return;
  gesture.t += dt;
  if (gesture.t >= gesture.dur){
    gesture.type = 'none';
  }
}

function updateBlink(dt){
  // VRM blendshape blink
  if (exprBlink){
    blinkTimer -= dt;
    if (blinkTimer <= 0){
      blinkTimer = rand(2.0, 4.0);
      blinkPhase = 0.12;
    }
    if (blinkPhase > 0){
      blinkPhase -= dt;
      const p = 1 - clamp01(blinkPhase / 0.12);
      const b = Math.sin(p * Math.PI);
      setExpression(exprBlink, b);
    } else {
      setExpression(exprBlink, 0);
    }
    return;
  }

  // Fallback avatar blink (scale eye spheres)
  if (!fallback?.userData?.eyeL) return;
  blinkTimer -= dt;
  if (blinkTimer <= 0){
    blinkTimer = rand(2.0, 4.0);
    blinkPhase = 0.12;
  }
  if (blinkPhase > 0){
    blinkPhase -= dt;
    const p = 1 - clamp01(blinkPhase / 0.12);
    const b = Math.sin(p * Math.PI);
    const sy = 1 - b * 0.92;
    fallback.userData.eyeL.scale.y = sy;
    fallback.userData.eyeR.scale.y = sy;
  } else {
    fallback.userData.eyeL.scale.y = 1;
    fallback.userData.eyeR.scale.y = 1;
  }
}

function setAllVowelsZero(){
  for (const k of Object.keys(exprVowels)){
    if (exprVowels[k]) setExpression(exprVowels[k], 0);
  }
}

function updateMouth(dt){
  // lipPulse gives extra pop on boundary events, then decays
  lipPulse = THREE.MathUtils.lerp(lipPulse, 0, 1 - Math.exp(-dt * 8));
  const base = speaking ? 0.38 + 0.22 * Math.sin(performance.now() * 0.018) : 0;
  const target = speaking ? (base + lipPulse * 0.5) : 0;
  mouth = THREE.MathUtils.lerp(mouth, target, 1 - Math.exp(-dt * 10));

  if (vrm) setAllVowelsZero();
  if (!speaking){
    if (fallback?.userData?.mouth){
      fallback.userData.mouth.scale.set(1,1,1);
    }
    return;
  }

  const key = pickVowelFromPlan();
  if (vrm){
    const expr = exprVowels[key] || exprVowels.a;
    if (expr) setExpression(expr, mouth);
  } else if (fallback?.userData?.mouth){
    // simple open/close by scaling mouth plane
    fallback.userData.mouth.scale.y = 0.6 + mouth * 2.2;
    fallback.userData.mouth.scale.x = 1.0 + mouth * 0.2;
  }
}

// --- Simple Korean-vowel-based lip plan (works even without audio amplitude) ---
function hangulVowelKey(ch){
  const code = ch.charCodeAt(0);
  if (code < 0xAC00 || code > 0xD7A3) return null;
  const vIndex = Math.floor((code - 0xAC00) / 28) % 21;
  // Map Jungseong to 5-ish buckets
  // 0:ㅏ 2:ㅑ 9:ㅘ 10:ㅙ 11:ㅚ 1:ㅐ 3:ㅒ -> 'a/e'
  // 20:ㅣ -> 'i'
  // 8:ㅗ 12:ㅛ -> 'o'
  // 13:ㅜ 17:ㅠ 14:ㅝ 15:ㅞ 16:ㅟ -> 'u'
  // 4:ㅓ 6:ㅕ 7:ㅖ 5:ㅔ 18:ㅡ 19:ㅢ -> 'e/o'
  if ([0,2,9,10].includes(vIndex)) return 'a';
  if ([1,3,5,7].includes(vIndex)) return 'e';
  if ([20].includes(vIndex)) return 'i';
  if ([8,12,11].includes(vIndex)) return 'o';
  if ([13,14,15,16,17].includes(vIndex)) return 'u';
  if ([4,6].includes(vIndex)) return 'o';
  if ([18,19].includes(vIndex)) return 'e';
  return 'a';
}

function buildLipPlan(text){
  const plan = [];
  const t = (text || '').trim();
  for (const ch of t){
    const k = hangulVowelKey(ch);
    if (k) plan.push(k);
    // punctuation adds a tiny pause so mouth closes a bit
    if (/[.!?…]/.test(ch)) plan.push('');
  }
  return plan.length ? plan : null;
}

function pickVowelFromPlan(){
  if (!lipPlan || !speaking) {
    const seq = ['a','i','u','e','o'];
    return seq[Math.floor((performance.now() / 120) % seq.length)];
  }
  const elapsed = performance.now() - (speechStartedAt || performance.now());
  const step = 95; // ms per mouth change
  const idx = Math.floor(elapsed / step) % lipPlan.length;
  const k = lipPlan[idx];
  if (!k) return 'a';
  return k;
}

function updateWander(dt){
  const root = actor();
  if (!root || !wander.active) return;

  const now = clock.elapsedTime;
  if (now > wander.nextSwitchAt){
    wander.nextSwitchAt = now + rand(3.5, 6.0);
    wander.pointIndex = (wander.pointIndex + 1) % wander.points.length;
  }
  const target = wander.points[wander.pointIndex];

  const pos = root.position;
  const dir = new THREE.Vector3().subVectors(target, pos);
  dir.y = 0;
  const dist = dir.length();
  if (dist > 0.03){
    dir.normalize();
    const speed = 0.22;
    const step = Math.min(dist, speed * dt);
    pos.addScaledVector(dir, step);

    // Keep inside the diorama floor
    pos.x = THREE.MathUtils.clamp(pos.x, -2.05, 2.05);
    pos.z = THREE.MathUtils.clamp(pos.z, -2.05, 2.05);

    const yaw = Math.atan2(dir.x, -dir.z);
    root.rotation.y = lerpAngle(root.rotation.y, yaw, 1 - Math.exp(-dt * 4));

    // tiny step bob (subtle)
    const bob = Math.sin(now * 7.2) * 0.004;
    root.position.y = bob;

    // movement amount for walk cycle (0..1)
    moveAmount = THREE.MathUtils.lerp(moveAmount, THREE.MathUtils.clamp(step / (speed * dt + 1e-6), 0, 1), 1 - Math.exp(-dt * 10));
    walkPhase += dt * (6.0 + 4.0 * moveAmount);
  }
}

function applyWalkCycle(dt){
  // Repurposed: walking/locomotion is disabled.
  // Keep the avatar idle, but add a subtle "foot-only" idle motion (tap / weight shift).
  if (!vrm) return;

  const a = 1 - Math.exp(-dt * 10);
  const t = clock.elapsedTime;

  // Subtle alternating phase
  const phase = t * 2.2;
  const l = 0.5 + 0.5 * Math.sin(phase);
  const r = 0.5 + 0.5 * Math.sin(phase + Math.PI);

  // Keep hips stable (no walking bob)
  if (bones.hips){
    // tiny sway only (almost imperceptible)
    const sway = Math.sin(phase) * 0.01;
    slerpToEuler(bones.hips, new THREE.Euler(0, 0, sway), a * 0.35);
  }

  // Feet / knees only (small ranges so it won't look like dancing)
  const knee = 0.16;
  const foot = 0.22;
  const toe  = 0.12;

  // Knee flex when that side "lifts"
  slerpToEuler(bones.lLowerLeg, new THREE.Euler(knee * l, 0, 0), a * 0.85);
  slerpToEuler(bones.rLowerLeg, new THREE.Euler(knee * r, 0, 0), a * 0.85);

  // Foot: heel/toe rock. Sign can vary per export; keep it symmetric and small.
  slerpToEuler(bones.lFoot, new THREE.Euler(-foot * l, 0, 0), a * 0.85);
  slerpToEuler(bones.rFoot, new THREE.Euler(-foot * r, 0, 0), a * 0.85);

  // Toes if available
  slerpToEuler(bones.lToes, new THREE.Euler(toe * l, 0, 0), a * 0.85);
  slerpToEuler(bones.rToes, new THREE.Euler(toe * r, 0, 0), a * 0.85);

  // No locomotion
  moveAmount = THREE.MathUtils.lerp(moveAmount, 0, 1 - Math.exp(-dt * 10));
}

// ---------------- Chat logic ----------------
const RESPONSES = {
  greet: [
    '안녕! 오늘도 반가워 😊',
    '하이~ 여기 있었구나!',
    '안녕하세요! 오늘 어떤 얘기 해볼까?'
  ],
  happy: [
    '와, 그거 너무 좋다! 나도 덩달아 기분 좋아졌어 ✨',
    '헤헤, 신난다! 같이 축하하자!',
    '오늘은 행복이 뿜뿜이네~ 무슨 일 있었어?'
  ],
  sad: [
    '괜찮아… 천천히 말해도 돼. 내가 들어줄게.',
    '마음이 무거웠구나. 여기서는 편하게 쉬어가자.',
    '토닥토닥… 지금 제일 힘든 게 뭐야?'
  ],
  angry: [
    '으응… 화날 만했겠다. 같이 정리해보자!',
    '그럴 땐 숨 크게 한 번! 후—',
    '너무 참지 말고 말해줘. 무슨 일이야?'
  ],
  thanks: [
    '에헤헤~ 고마워! 나도 도움이 되고 싶었어.',
    '별말을~ 여기 있는 동안은 내가 편이야!',
    '고마워라… 오늘 좋은 일 생길 거야 ✨'
  ],
  sorry: [
    '괜찮아! 우리 천천히 다시 해보자.',
    '미안해하지 마~ 누구나 그럴 수 있어.',
    '응응, 이해했어. 다음엔 더 편하게 말해줘!'
  ],
  sleepy: [
    '졸리면 잠깐 스트레칭! 같이 숨 크게~',
    '오늘 많이 피곤했구나. 물 한 잔 마실래?',
    '조금만 쉬었다가 다시 돌아오자. 내가 기다릴게!'
  ],
  surprise: [
    '에?! 진짜?! 😳',
    '헉… 그건 예상 못했어!',
    '와… 잠깐만, 다시 말해줘!'
  ],
  shy: [
    '에헤… 그런 말 하면 나 부끄럽다… 🙈',
    '그, 그런 말 갑자기 하면… 심장이…!',
    '으으… 얼굴 빨개졌어…'
  ],
  think: [
    '음… 잠깐만 생각해볼게…',
    '흠… 그건 이렇게 볼 수도 있을 것 같아.',
    '좋아, 하나씩 정리해보자.'
  ],
  normal: [
    '오케이! 좀 더 자세히 말해줄래?',
    '음~ 그런 느낌이구나. 그 다음은?',
    '좋아, 계속 이야기해보자!'
  ]
};

function pick(arr){ return arr[Math.floor(Math.random()*arr.length)]; }

function classify(text){
  const t = text.trim().toLowerCase();
  const has = (...keys) => keys.some(k => t.includes(k));

  // VRMA motion pack shortcuts
  // Example: "모션3", "vrma 5", "motion_2"
  const m = t.match(/(?:모션|motion|vrma)\s*[_-]?(\d)/);
  if (m){
    const n = Math.max(1, Math.min(7, parseInt(m[1], 10)));
    return `vrma_${n}`;
  }
  if (has('피스','브이','peace')) return 'vrma_3';
  if (has('총','쏴','shoot')) return 'vrma_4';
  if (has('스핀','돌아','spin')) return 'vrma_5';
  if (has('스쿼트','스쿼시','squat')) return 'vrma_7';

  if (has('인사','안녕','하이','hello','hi')) return 'greet';
  if (has('기쁨','행복','좋아','신나','축하','최고')) return 'happy';
  if (has('슬픔','우울','눈물','힘들','속상')) return 'sad';
  if (has('화남','짜증','분노','열받','빡쳐')) return 'angry';
  if (has('고마','감사','thanks','thx')) return 'thanks';
  if (has('미안','sorry','죄송')) return 'sorry';
  if (has('졸려','피곤','잠','sleepy')) return 'sleepy';
  if (has('놀라','헉','대박','진짜?','surprise')) return 'surprise';
  if (has('부끄','귀여','사랑','좋아해','shy')) return 'shy';
  if (has('생각','고민','흠','음…','think')) return 'think';
  return 'normal';
}

function reactTo(kind){
  // When user chats: approach, stop, then react (works even if TTS is off)
  requestAttention(7);
  startApproachToUser(7);

  // Direct VRMA triggers (no need for emotion classification)
  if (kind.startsWith('vrma_')){
    const n = parseInt(kind.split('_')[1] || '0', 10);
    const map = {
      1: 'show',
      2: 'greeting',
      3: 'peace',
      4: 'shoot',
      5: 'spin',
      6: 'pose',
      7: 'squat',
    };
    const key = map[n];
    const ok = key ? playVRMA(key) : false;
    if (!ok){
      addBubble('시스템', '모션팩이 아직 로딩 중이거나, 해당 모션을 못 찾았어요. 잠깐만 기다렸다가 다시...');
    } else {
      addBubble('VTuber', `모션${n} 실행!`);
    }
    return;
  }

  const reply = pick(RESPONSES[kind] || RESPONSES.normal);
  addBubble('VTuber', reply);
  speak(reply);

  // Motion tuning (length + intensity per emotion)
  // Prefer VRMA gestures when available, otherwise use procedural pose.
  if (kind === 'greet'){
    if (!playVRMA('greeting')) startGesture('wave', 1.55, 1.0);
  }
  else if (kind === 'thanks'){
    if (!playVRMA('peace')) startGesture('happy', 1.6, 0.9);
  }
  else if (kind === 'happy') startGesture('happy', 2.10, 1.05);
  else if (kind === 'sad') startGesture('sad', 2.60, 0.95);
  else if (kind === 'angry') startGesture('angry', 1.85, 1.0);
  else if (kind === 'surprise'){
    if (!playVRMA('show')) startGesture('surprise', 1.35, 1.05);
  }
  else if (kind === 'shy') startGesture('shy', 2.05, 0.95);
  else if (kind === 'think') startGesture('think', 2.40, 0.95);
  else startGesture('happy', 1.25, 0.70);

  // Face expression (if available)
  if (kind === 'happy' && exprHappy){ setExpression(exprHappy, 0.9); setTimeout(() => setExpression(exprHappy, 0), 900); }
  if (kind === 'sad' && exprSad){ setExpression(exprSad, 0.9); setTimeout(() => setExpression(exprSad, 0), 1200); }
  if (kind === 'angry' && exprAngry){ setExpression(exprAngry, 0.8); setTimeout(() => setExpression(exprAngry, 0), 1000); }
  if (kind === 'surprise' && exprSurprise){ setExpression(exprSurprise, 0.9); setTimeout(() => setExpression(exprSurprise, 0), 900); }
  if (kind === 'shy' && exprShy){ setExpression(exprShy, 0.9); setTimeout(() => setExpression(exprShy, 0), 1200); }
}

function handleSend(){
  const text = elText.value;
  elText.value = '';
  const trimmed = text.trim();
  if (!trimmed) return;
  addBubble('You', trimmed, true);
  reactTo(classify(trimmed));
}

elSend.addEventListener('click', handleSend);
elText.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') handleSend();
});

// ---------------- Main loop ----------------
(async () => {
  onResize();

  addBubble('VTuber', '교실에 어서 와! 메시지를 보내면 내가 보고, 대답하고, 살짝 리액션도 해줄게 😊');
  addBubble('VTuber', '예: "인사" / "기쁨" / "슬픔" / "화남" / "고마워" / "졸려"');
  if (!ttsEnabled) addBubble('시스템', '모바일은 소리 재생을 위해 오른쪽 위의 “음성 켜기”를 한 번 눌러줘!');

  setLoadingText('아바타/모션 로딩중…', '모션팩까지 준비되면 화면이 열려요.');

  // Android에서 VRM 로딩이 매우 오래 걸리거나 멈춘 것처럼 보이는 경우가 있어,
  // 일정 시간 후에는 간편 아바타를 먼저 준비해두되(배경에서),
  // 모션팩까지 완료된 뒤에만 로딩 오버레이를 해제합니다.
  const fallbackDelay = isMobile() ? 6500 : 20000;
  const fallbackTimer = setTimeout(() => {
    showFallbackIfNeeded();
    setLoadingText('아바타 로딩이 조금 길어지고 있어요…', '네트워크/기기 상황에 따라 더 걸릴 수 있어요.');
  }, fallbackDelay);

  const ok = await loadAvatar();
  clearTimeout(fallbackTimer);

  if (!ok){
    showFallbackIfNeeded();
    hideLoadingOverlay();

    addBubble('시스템', '아바타 로딩에 실패했어요. 모바일이면: 데이터 절약 모드/저전력 모드 해제 후 다시 시도해보세요.');
    addBubble('시스템', '그래도 안 되면 다른 브라우저(Chrome/Edge/Safari)에서 열어봐줘!');
  } else {
    setLoadingText('모션팩 로딩중…', '첫 시작만 조금 걸릴 수 있어요.');

    await loadVRMAMotionPack();
    if (vrmaLoaded){
      // Default: always play Motion 7 as the idle loop (no walking).
      playVRMA('motion7', { loop: 'repeat', fadeIn: 0.0 });
      requestAttention(9999);
    }

    // Now it's safe to show the avatar (no T-pose flash).
    if (vrm?.scene) vrm.scene.visible = true;
    if (fallback && fallback.parent) fallback.parent.remove(fallback);

    hideLoadingOverlay();
    addBubble('VTuber', '로딩 완료! 이제 얘기해보자~');
    addBubble('시스템', '캐릭터를 터치하면 모션이 랜덤으로 나와요!');
    if (!ttsEnabled) addBubble('시스템', '모바일은 소리 재생을 위해 오른쪽 위의 “음성 켜기”를 한 번 눌러줘!');
  }

  function tick(){
    const dt = Math.min(0.033, clock.getDelta());

    controls.update();

    if (vrm) vrm.update(dt);
    if (vrmaMixer) vrmaMixer.update(dt);

    // Interaction & gaze
    updateInteraction(dt);

    // When speaking, make sure she really "looks at you" (head + eyes).
    const attentive = speaking || gesture.type !== 'none' || clock.elapsedTime < interaction.attentionUntil || interaction.mode !== 'wander';
    if (speaking){
      faceCameraYaw(dt, 14);
      lookAtCameraUpperBody(dt, 1.25);
    } else if (attentive){
      faceCameraYaw(dt, 12);
      lookAtCameraUpperBody(dt, 1.0);
    } else {
      // soft casual gaze
      lookAtCameraUpperBody(dt, 0.25);
    }
    updateEyeGaze(dt);

    const vrmaActive = isVRMAActive();

    // Gestures / pose
    // When no VRMA is playing, we do NOT force any arm/hand pose.
    // (Forcing absolute arm rotations caused raised-arm / T-pose issues on different avatars.)
    if (!vrmaActive){
      updateGesture(dt);
      // No procedural walk / no procedural upper-body pose.
    }

    // Happy bounce (subtle)
    const root = actor();
    if (root){
      if (!vrmaActive && gesture.type === 'happy'){
        root.position.y = 0.01 + Math.sin(clock.elapsedTime * 9.0) * 0.012;
      } else if (interaction.mode !== 'wander'){
        root.position.y = 0;
      }
    }

    updateBlink(dt);
    updateMouth(dt);

    composer.render();
    requestAnimationFrame(tick);
  }

  requestAnimationFrame(tick);
})();