import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils, VRMHumanBoneName } from '@pixiv/three-vrm';

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

// ---------------- Helpers ----------------
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const rand = (a,b) => a + Math.random()*(b-a);
const easeInOut = (t) => (t < 0.5 ? 2*t*t : 1 - Math.pow(-2*t+2,2)/2);

function isMobile(){
  return matchMedia('(max-width: 879px)').matches || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

// ---------------- TTS (Web Speech API) ----------------
let ttsEnabled = localStorage.getItem('ttsEnabled') === '1';
let speaking = false;
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

function speak(text){
  if (!ttsEnabled || !('speechSynthesis' in window)) return;
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
      u.onstart = () => { speaking = true; };
      u.onend = () => { speaking = false; };
      u.onerror = () => { speaking = false; };
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
  alpha: false,
  powerPreference: 'high-performance'
});
renderer.setClearColor(0x0b1220, 1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x0b1220, 6, 18);

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

function onResize(){
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const dprCap = isMobile() ? 1.25 : 2;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, dprCap));
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', onResize);
window.addEventListener('orientationchange', () => setTimeout(onResize, 200));

// Lights
scene.add(new THREE.AmbientLight(0xffffff, 0.55));
const key = new THREE.DirectionalLight(0xffffff, 1.15);
key.position.set(2.5, 4.0, 2.0);
scene.add(key);
const rim = new THREE.DirectionalLight(0xffffff, 0.35);
rim.position.set(-2.5, 2.2, -2.8);
scene.add(rim);

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

  // Chair
  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.06, 0.55), new THREE.MeshStandardMaterial({ color: 0x6d7f97, roughness: 0.9 }));
  seat.position.set(0.35, 0.45, -1.25);
  room.add(seat);
  const back = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.5, 0.06), new THREE.MeshStandardMaterial({ color: 0x6d7f97, roughness: 0.9 }));
  back.position.set(0.35, 0.74, -1.5);
  room.add(back);
  const chairLegGeo = new THREE.BoxGeometry(0.05, 0.45, 0.05);
  [[-0.22,-0.22],[0.22,-0.22],[-0.22,0.22],[0.22,0.22]].forEach(([x,z])=>{
    const leg = new THREE.Mesh(chairLegGeo, legMat);
    leg.position.set(0.35 + x, 0.225, -1.25 + z);
    room.add(leg);
  });

  // Small lamp (emissive)
  const lamp = new THREE.Mesh(
    new THREE.SphereGeometry(0.085, 20, 20),
    new THREE.MeshStandardMaterial({ color: 0xfff2bf, emissive: 0xffe3a0, emissiveIntensity: 0.55 })
  );
  lamp.position.set(0.55, 1.02, -1.65);
  room.add(lamp);
}

buildRoom();

// ---------------- Avatar (VRM) ----------------
const vrmLoader = new GLTFLoader();
vrmLoader.register((parser) => new VRMLoaderPlugin(parser, { autoUpdateHumanBones: true }));

let vrm = null;
let avatarRoot = null;
let bones = {};

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

  // Mouth shapes differ by model
  const a = pickFirstAvailable(['aa','A']);
  const i = pickFirstAvailable(['ih','I']);
  const u = pickFirstAvailable(['ou','U']);
  const e = pickFirstAvailable(['ee','E']);
  const o = pickFirstAvailable(['oh','O']);
  exprVowels = { a,i,u,e,o };
}

async function loadAvatar(){
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      setLoadingText('로딩이 조금 오래 걸려요…', '모바일은 네트워크/메모리 상태에 따라 시간이 더 걸릴 수 있어요.');
    }, 8000);

    const onProgress = (xhr) => {
      if (!xhr?.total) return;
      const p = Math.round((xhr.loaded / xhr.total) * 100);
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
      avatarRoot.rotation.y = Math.PI * 0.15;
      scene.add(avatarRoot);

      // 모바일 안정성: MToon 셰이더 대신 표준 머티리얼로 변환
      toStandardMaterials(avatarRoot);

      // Remove unnecessary stuff to speed up
      try{ VRMUtils.removeUnnecessaryJoints(avatarRoot); }catch{}

      // Cache bone refs
      const h = vrm.humanoid;
      bones = {
        head: h.getRawBoneNode(VRMHumanBoneName.Head),
        neck: h.getRawBoneNode(VRMHumanBoneName.Neck),
        chest: h.getRawBoneNode(VRMHumanBoneName.Chest),
        spine: h.getRawBoneNode(VRMHumanBoneName.Spine),
        hips: h.getRawBoneNode(VRMHumanBoneName.Hips),
        rUpperArm: h.getRawBoneNode(VRMHumanBoneName.RightUpperArm),
        rLowerArm: h.getRawBoneNode(VRMHumanBoneName.RightLowerArm),
        rHand: h.getRawBoneNode(VRMHumanBoneName.RightHand),
        lUpperArm: h.getRawBoneNode(VRMHumanBoneName.LeftUpperArm),
        lLowerArm: h.getRawBoneNode(VRMHumanBoneName.LeftLowerArm),
        lHand: h.getRawBoneNode(VRMHumanBoneName.LeftHand)
      };

      detectExpressions();

      // Calm base pose
      applyUpperBodyPose(0, { kind:'idle', wave:0, happy:0, sad:0, angry:0, talk:0 }, 1);
      resolve(true);
    }, onProgress, (err) => {
      clearTimeout(timeout);
      console.error('VRM load failed', err);
      resolve(false);
    });
  });
}

// ---------------- Procedural animation ----------------
const clock = new THREE.Clock();

let blinkTimer = rand(2.2, 4.2);
let blinkPhase = 0;
let mouth = 0;

// Wandering around the diorama
const wander = {
  active: true,
  pointIndex: 0,
  nextSwitchAt: 0,
  points: [
    new THREE.Vector3(0.4, 0, -0.4),
    new THREE.Vector3(1.15, 0, -0.9),
    new THREE.Vector3(0.2, 0, 0.25),
    new THREE.Vector3(0.95, 0, 0.15)
  ]
};

function stopWanderFor(seconds){
  wander.active = false;
  const resumeAt = clock.elapsedTime + seconds;
  const check = () => {
    if (clock.elapsedTime >= resumeAt){
      wander.active = true;
    } else {
      requestAnimationFrame(check);
    }
  };
  requestAnimationFrame(check);
}

function faceCameraYaw(dt){
  if (!avatarRoot) return;
  const p = new THREE.Vector3();
  avatarRoot.getWorldPosition(p);
  const toCam = new THREE.Vector3().subVectors(camera.position, p);
  toCam.y = 0;
  if (toCam.lengthSq() < 1e-6) return;
  toCam.normalize();
  const targetYaw = Math.atan2(toCam.x, toCam.z);
  avatarRoot.rotation.y = THREE.MathUtils.lerpAngle(avatarRoot.rotation.y, targetYaw, 1 - Math.exp(-dt * 7));
}

function lookAtCameraHead(dt){
  if (!bones.head || !avatarRoot) return;
  const headPos = new THREE.Vector3();
  bones.head.getWorldPosition(headPos);
  const toCam = new THREE.Vector3().subVectors(camera.position, headPos);

  // Convert to avatar local space
  const inv = new THREE.Matrix4().copy(avatarRoot.matrixWorld).invert();
  toCam.applyMatrix4(inv);
  // Limit angles
  const yaw = Math.atan2(toCam.x, toCam.z);
  const pitch = Math.atan2(-toCam.y, Math.sqrt(toCam.x*toCam.x + toCam.z*toCam.z));
  const yawLim = THREE.MathUtils.clamp(yaw, -0.45, 0.45);
  const pitchLim = THREE.MathUtils.clamp(pitch, -0.25, 0.35);

  const targetQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitchLim, yawLim * 0.7, 0, 'YXZ'));
  bones.head.quaternion.slerp(targetQ, 1 - Math.exp(-dt * 6));
}

// Base pose (hands together, calm)
const BASE = {
  rUpperArm: new THREE.Euler(0.18, -0.35, 0.40),
  rLowerArm: new THREE.Euler(-0.25, 0.06, 0.10),
  rHand: new THREE.Euler(0.00, 0.00, 0.00),
  lUpperArm: new THREE.Euler(0.18, 0.35, -0.40),
  lLowerArm: new THREE.Euler(-0.25, -0.06, -0.10),
  lHand: new THREE.Euler(0.00, 0.00, 0.00),
  chest: new THREE.Euler(0.00, 0.00, 0.00)
};

function slerpToEuler(bone, euler, alpha){
  if (!bone) return;
  const q = new THREE.Quaternion().setFromEuler(euler);
  bone.quaternion.slerp(q, alpha);
}

function applyUpperBodyPose(dt, state, alpha){
  // state: {kind, wave, happy, sad, angry, talk}
  const a = alpha ?? (1 - Math.exp(-dt * 10));

  const wave = state.wave || 0;
  const happy = state.happy || 0;
  const sad = state.sad || 0;
  const angry = state.angry || 0;
  const talk = state.talk || 0;

  // Chest breathing + mild nod
  const breathe = Math.sin(clock.elapsedTime * 1.6) * 0.012;
  const nod = talk ? Math.sin(clock.elapsedTime * 2.8) * 0.04 * talk : 0;
  const chestEuler = new THREE.Euler(
    BASE.chest.x + breathe + sad*0.10 - angry*0.03,
    0,
    0
  );
  slerpToEuler(bones.chest, chestEuler, a);

  // Arms: calm by default, wave uses right arm
  const rUA = new THREE.Euler(
    BASE.rUpperArm.x - 0.08*happy + 0.05*sad,
    BASE.rUpperArm.y,
    BASE.rUpperArm.z
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

  slerpToEuler(bones.rUpperArm, rUA, a);
  slerpToEuler(bones.rLowerArm, rLA, a);

  if (bones.rHand){
    const wig = wave > 0 ? Math.sin(clock.elapsedTime * 10) * 0.35 * wave : 0;
    slerpToEuler(bones.rHand, new THREE.Euler(0,0,wig), a * 0.7);
  }

  const lUA = new THREE.Euler(
    BASE.lUpperArm.x - 0.08*happy + 0.05*sad,
    BASE.lUpperArm.y,
    BASE.lUpperArm.z
  );
  const lLA = new THREE.Euler(BASE.lLowerArm.x, BASE.lLowerArm.y, BASE.lLowerArm.z);
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
let gesture = { type:'none', t:0, dur:0 };
function startGesture(type, dur){ gesture = { type, t:0, dur }; }

function gestureWeights(){
  if (gesture.type === 'none' || gesture.dur <= 0) return { wave:0, happy:0, sad:0, angry:0 };
  const t = clamp01(gesture.t / gesture.dur);
  const k = easeInOut(t);
  if (gesture.type === 'wave') return { wave:k, happy:0, sad:0, angry:0 };
  if (gesture.type === 'happy') return { wave:0, happy:k, sad:0, angry:0 };
  if (gesture.type === 'sad') return { wave:0, happy:0, sad:k, angry:0 };
  if (gesture.type === 'angry') return { wave:0, happy:0, sad:0, angry:k };
  return { wave:0, happy:0, sad:0, angry:0 };
}

function updateGesture(dt){
  if (gesture.type === 'none') return;
  gesture.t += dt;
  if (gesture.t >= gesture.dur){
    gesture.type = 'none';
  }
}

function updateBlink(dt){
  if (!exprBlink) return;
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
}

function setAllVowelsZero(){
  for (const k of Object.keys(exprVowels)){
    if (exprVowels[k]) setExpression(exprVowels[k], 0);
  }
}

function updateMouth(dt){
  const target = speaking ? 0.55 + 0.25 * Math.sin(performance.now() * 0.016) : 0;
  mouth = THREE.MathUtils.lerp(mouth, target, 1 - Math.exp(-dt * 10));

  setAllVowelsZero();
  if (!speaking) return;

  const seq = ['a','i','u','e','o'];
  const idx = Math.floor((performance.now() / 110) % seq.length);
  const key = seq[idx];
  const expr = exprVowels[key] || exprVowels.a;
  if (expr) setExpression(expr, mouth);
}

function updateWander(dt){
  if (!avatarRoot || !wander.active || speaking || gesture.type !== 'none') return;

  const now = clock.elapsedTime;
  if (now > wander.nextSwitchAt){
    wander.nextSwitchAt = now + rand(3.5, 6.0);
    wander.pointIndex = (wander.pointIndex + 1) % wander.points.length;
  }
  const target = wander.points[wander.pointIndex];

  const pos = avatarRoot.position;
  const dir = new THREE.Vector3().subVectors(target, pos);
  dir.y = 0;
  const dist = dir.length();
  if (dist > 0.03){
    dir.normalize();
    const speed = 0.16;
    pos.addScaledVector(dir, Math.min(dist, speed * dt));

    const yaw = Math.atan2(dir.x, dir.z);
    avatarRoot.rotation.y = THREE.MathUtils.lerpAngle(avatarRoot.rotation.y, yaw, 1 - Math.exp(-dt * 4));

    // tiny step bob (very subtle)
    const bob = Math.sin(now * 6.0) * 0.006;
    avatarRoot.position.y = bob;
  }
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

  if (has('인사','안녕','하이','hello','hi')) return 'greet';
  if (has('기쁨','행복','좋아','신나','축하','최고')) return 'happy';
  if (has('슬픔','우울','눈물','힘들','속상')) return 'sad';
  if (has('화남','짜증','분노','열받','빡쳐')) return 'angry';
  if (has('고마','감사','thanks','thx')) return 'thanks';
  if (has('미안','sorry','죄송')) return 'sorry';
  if (has('졸려','피곤','잠','sleepy')) return 'sleepy';
  return 'normal';
}

function reactTo(kind){
  stopWanderFor(2.8);

  const reply = pick(RESPONSES[kind] || RESPONSES.normal);
  addBubble('VTuber', reply);
  speak(reply);

  // Motion
  if (kind === 'greet') startGesture('wave', 1.2);
  else if (kind === 'happy') startGesture('happy', 1.4);
  else if (kind === 'sad') startGesture('sad', 1.7);
  else if (kind === 'angry') startGesture('angry', 1.2);
  else startGesture('happy', 0.9);

  // Face expression (if available)
  if (kind === 'happy' && exprHappy){ setExpression(exprHappy, 0.9); setTimeout(() => setExpression(exprHappy, 0), 900); }
  if (kind === 'sad' && exprSad){ setExpression(exprSad, 0.9); setTimeout(() => setExpression(exprSad, 0), 1200); }
  if (kind === 'angry' && exprAngry){ setExpression(exprAngry, 0.8); setTimeout(() => setExpression(exprAngry, 0), 1000); }
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

  setLoadingText('아바타 로딩중…', '모바일은 처음 한 번만 조금 더 걸릴 수 있어요.');
  const ok = await loadAvatar();
  if (elLoading) elLoading.style.display = 'none';

  if (!ok){
    addBubble('시스템', '아바타 로딩에 실패했어요. 모바일이면: 데이터 절약 모드/저전력 모드 해제 후 다시 시도해보세요.');
    addBubble('시스템', '그래도 안 되면 다른 브라우저(Chrome/Edge/Safari)에서 열어봐줘!');
  } else {
    addBubble('VTuber', '로딩 완료! 이제 얘기해보자~');
  }

  function tick(){
    const dt = Math.min(0.033, clock.getDelta());

    controls.update();

    if (vrm) vrm.update(dt);

    // Wander or engage
    if (speaking || gesture.type !== 'none'){
      faceCameraYaw(dt);
      lookAtCameraHead(dt);
    } else {
      updateWander(dt);
      // soft casual gaze
      lookAtCameraHead(dt * 0.35);
    }

    // Gestures / pose
    updateGesture(dt);
    const w = gestureWeights();
    const talk = speaking ? 1 : 0;
    applyUpperBodyPose(dt, { kind:'idle', talk, ...w }, 1 - Math.exp(-dt * 9));

    // Happy bounce (subtle)
    if (avatarRoot){
      if (gesture.type === 'happy'){
        avatarRoot.position.y = 0.01 + Math.sin(clock.elapsedTime * 9.0) * 0.012;
      } else if (!wander.active){
        avatarRoot.position.y = 0;
      }
    }

    updateBlink(dt);
    updateMouth(dt);

    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  }

  requestAnimationFrame(tick);
})();
