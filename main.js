import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils, VRMHumanBoneName } from '@pixiv/three-vrm';

const $ = (sel) => document.querySelector(sel);
const canvas = $('#c');
const loadingEl = $('#loading');
const audioGate = $('#audioGate');
const logEl = $('#log');
const form = $('#form');
const input = $('#input');

const isMobile = matchMedia('(max-width: 860px)').matches || /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);

// --- Audio gate (mobile autoplay policies) ---
let audioEnabled = localStorage.getItem('vt_audio') === '1';
function updateAudioGate(){
  audioGate.classList.toggle('hidden', audioEnabled);
}
updateAudioGate();
audioGate.addEventListener('click', () => {
  audioEnabled = true;
  localStorage.setItem('vt_audio', '1');
  updateAudioGate();
  addMsg('VTuber','좋아! 이제 말할게 🙂');
});

// --- Scene / Renderer ---
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, isMobile ? 1.5 : 2));
renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x0b1220, 3.5, 14);

const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
camera.position.set(0.0, 1.35, 3.3);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(0, 1.15, 0);
controls.enablePan = false;
controls.minDistance = 2.3;
controls.maxDistance = 4.6;
controls.minPolarAngle = 0.55;
controls.maxPolarAngle = 1.45;

// Lights
scene.add(new THREE.HemisphereLight(0xdce9ff, 0x223344, 0.7));
const key = new THREE.DirectionalLight(0xffffff, 1.25);
key.position.set(2.5, 4.0, 2.2);
key.castShadow = true;
key.shadow.mapSize.set(1024, 1024);
key.shadow.camera.left = -4;
key.shadow.camera.right = 4;
key.shadow.camera.top = 4;
key.shadow.camera.bottom = -4;
scene.add(key);

// --- Classroom corner diorama (open corner) ---
const room = new THREE.Group();
scene.add(room);

const floorMat = new THREE.MeshStandardMaterial({ color: 0x9f8e7a, roughness: 0.95, metalness: 0.0 });
const wallMat  = new THREE.MeshStandardMaterial({ color: 0xe8eef7, roughness: 0.98, metalness: 0.0 });

const floor = new THREE.Mesh(new THREE.PlaneGeometry(6, 6), floorMat);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
room.add(floor);

// Two walls (ceiling missing)
const wall1 = new THREE.Mesh(new THREE.PlaneGeometry(6, 3), wallMat);
wall1.position.set(0, 1.5, -3);
wall1.receiveShadow = true;
room.add(wall1);

const wall2 = new THREE.Mesh(new THREE.PlaneGeometry(6, 3), wallMat);
wall2.rotation.y = Math.PI / 2;
wall2.position.set(-3, 1.5, 0);
wall2.receiveShadow = true;
room.add(wall2);

// Chalkboard
const board = new THREE.Mesh(
  new THREE.PlaneGeometry(2.6, 1.2),
  new THREE.MeshStandardMaterial({ color: 0x143018, roughness: 1.0 })
);
board.position.set(-2.98, 1.55, -0.6);
board.rotation.y = Math.PI / 2;
room.add(board);

// Window frame (simple)
const frameMat = new THREE.MeshStandardMaterial({ color: 0x7a604d, roughness: 0.8 });
const frame = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.9, 0.08), frameMat);
frame.position.set(0.9, 1.8, -2.98);
frame.castShadow = true;
room.add(frame);
const glass = new THREE.Mesh(
  new THREE.PlaneGeometry(1.48, 0.78),
  new THREE.MeshStandardMaterial({ color: 0x9fd2ff, transparent: true, opacity: 0.25, roughness: 0.1 })
);
glass.position.set(0.9, 1.8, -2.94);
room.add(glass);

// A few props from Kenney (CC0)
const gltfLoader = new GLTFLoader();
function loadProp(url, onLoad){
  return new Promise((resolve, reject) => {
    gltfLoader.load(url, (gltf) => {
      const obj = gltf.scene;
      obj.traverse((o) => {
        if (o.isMesh) {
          o.castShadow = true;
          o.receiveShadow = true;
          // Kenney models can be a bit shiny; tone it down
          if (o.material) {
            o.material.roughness = 0.95;
            o.material.metalness = 0.0;
          }
        }
      });
      onLoad?.(obj);
      room.add(obj);
      resolve(obj);
    }, undefined, reject);
  });
}

let deskObj = null;
let chairObj = null;

// Place desk + chair to look like a classroom corner
const propsPromise = Promise.all([
  loadProp('./assets/room/desk.glb', (o) => {
    deskObj = o;
    o.position.set(-1.9, 0.0, -1.3);
    o.rotation.y = Math.PI * 0.18;
    o.scale.setScalar(1.4);
  }),
  loadProp('./assets/room/chair.glb', (o) => {
    chairObj = o;
    o.position.set(-1.35, 0.0, -0.65);
    o.rotation.y = Math.PI * 0.95;
    o.scale.setScalar(1.4);
  }),
]);

// --- VTuber (VRM) ---
let vrm = null;
let vrmScene = null;
let head = null;
let hips = null;

// Simple gesture state
let gesture = { name: 'idle', t: 0, dur: 1.0 };
let speakingUntil = 0;

// Wander state
let wander = {
  enabled: true,
  target: new THREE.Vector3(0.5, 0, -0.2),
  nextPickAt: 0,
};

function addMsg(who, text){
  const row = document.createElement('div');
  row.className = 'msg';
  const badge = document.createElement('div');
  badge.className = 'badge';
  badge.textContent = who;
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  row.appendChild(badge);
  row.appendChild(bubble);
  logEl.appendChild(row);
  logEl.scrollTop = logEl.scrollHeight;
}

function chooseCuteVoice(){
  const voices = speechSynthesis.getVoices?.() ?? [];
  if (!voices.length) return null;

  // Prefer Korean + female-ish voices first
  const ko = voices.filter(v => (v.lang || '').toLowerCase().startsWith('ko'));
  const prefer = (arr) => arr.find(v => /female|woman|heami|sunhi|yuna|아리|유나/i.test(v.name)) || arr[0];
  return prefer(ko) || prefer(voices);
}

function speak(text){
  if (!audioEnabled) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const v = chooseCuteVoice();
    if (v) u.voice = v;
    // “귀엽게” 기본값
    u.pitch = 1.22;
    u.rate = 1.05;
    u.volume = 1.0;

    const now = performance.now();
    speakingUntil = now + Math.min(9000, 900 + text.length * 110);

    speechSynthesis.speak(u);
  } catch (e) {
    // ignore
  }
}

function setExpression(name, value){
  if (!vrm?.expressionManager) return;
  vrm.expressionManager.setValue(name, value);
}

function clamp01(x){
  return Math.max(0, Math.min(1, x));
}

// Simple easing
function easeInOut(t){
  return t < 0.5 ? 2*t*t : 1 - Math.pow(-2*t+2,2)/2;
}

function rotEuler(node, x, y, z, alpha=1){
  if (!node) return;
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(x,y,z,'XYZ'));
  node.quaternion.slerp(q, alpha);
}

function applyCalmHandsPose(alpha=1){
  if (!vrm) return;
  const hum = vrm.humanoid;
  const lu = hum.getRawBoneNode(VRMHumanBoneName.LeftUpperArm);
  const ru = hum.getRawBoneNode(VRMHumanBoneName.RightUpperArm);
  const ll = hum.getRawBoneNode(VRMHumanBoneName.LeftLowerArm);
  const rl = hum.getRawBoneNode(VRMHumanBoneName.RightLowerArm);
  const lh = hum.getRawBoneNode(VRMHumanBoneName.LeftHand);
  const rh = hum.getRawBoneNode(VRMHumanBoneName.RightHand);

  // Arms down, slightly inward; hands together near belly
  rotEuler(lu, -0.35,  0.20,  0.15, alpha);
  rotEuler(ru, -0.35, -0.20, -0.15, alpha);
  rotEuler(ll, -0.55,  0.05,  0.10, alpha);
  rotEuler(rl, -0.55, -0.05, -0.10, alpha);
  rotEuler(lh,  0.15,  0.25,  0.10, alpha);
  rotEuler(rh,  0.15, -0.25, -0.10, alpha);
}

function startGesture(name, dur=1.0){
  gesture = { name, t: 0, dur };
}

function updateGesture(dt){
  if (!vrm) return;
  gesture.t += dt;
  const t = clamp01(gesture.t / gesture.dur);
  const e = easeInOut(t);
  const hum = vrm.humanoid;

  const lu = hum.getRawBoneNode(VRMHumanBoneName.LeftUpperArm);
  const ru = hum.getRawBoneNode(VRMHumanBoneName.RightUpperArm);
  const ll = hum.getRawBoneNode(VRMHumanBoneName.LeftLowerArm);
  const rl = hum.getRawBoneNode(VRMHumanBoneName.RightLowerArm);
  const spine = hum.getRawBoneNode(VRMHumanBoneName.Spine);

  // Base calm pose each frame (keeps arms from flapping)
  applyCalmHandsPose(0.7);

  if (gesture.name === 'wave'){
    // Right arm up + wave
    rotEuler(ru, -1.2, -0.2, -0.4, 0.9);
    rotEuler(rl, -0.25, 0.0,  0.9*Math.sin(e*Math.PI*2.0), 0.9);
  }
  else if (gesture.name === 'happy'){
    // Small cheer: both arms a bit up + body bounce
    rotEuler(lu, -0.9, 0.35, 0.25, 0.8);
    rotEuler(ru, -0.9,-0.35,-0.25, 0.8);
    rotEuler(ll, -0.6, 0.0, 0.2, 0.7);
    rotEuler(rl, -0.6, 0.0,-0.2, 0.7);
    if (spine) spine.position.y = 0.02 * Math.sin(e*Math.PI*2.0);
  }
  else if (gesture.name === 'sad'){
    // Slump
    rotEuler(spine, 0.25, 0, 0, 0.7);
    rotEuler(lu, -0.15, 0.15, 0.10, 0.8);
    rotEuler(ru, -0.15,-0.15,-0.10, 0.8);
  }
  else if (gesture.name === 'angry'){
    // Shake fist (right)
    rotEuler(ru, -0.7, -0.3, -0.3, 0.9);
    rotEuler(rl, -1.0,  0.0,  0.35*Math.sin(e*Math.PI*6.0), 0.9);
    rotEuler(spine, -0.1, 0, 0, 0.5);
  }
  else if (gesture.name === 'surprise'){
    // Quick arms out
    rotEuler(lu, -0.75, 0.9, 0.2, 0.8);
    rotEuler(ru, -0.75,-0.9,-0.2, 0.8);
  }

  // End gesture
  if (gesture.t >= gesture.dur){
    gesture.name = 'idle';
    gesture.t = 0;
    gesture.dur = 1.0;
  }
}

function updateFace(now){
  if (!vrm?.expressionManager) return;

  // Blink
  const blink = 0.5 + 0.5*Math.sin(now*0.003);
  const blink2 = (Math.sin(now*0.0017) > 0.985) ? 1 : 0; // occasional blink spike
  setExpression('blink', clamp01(blink2));

  // Mouth while speaking
  const talking = now < speakingUntil;
  const mouth = talking ? (0.35 + 0.35*Math.sin(now*0.02) + 0.2*Math.sin(now*0.033)) : 0.0;
  setExpression('aa', clamp01(mouth));
}

function faceUser(dt){
  if (!vrmScene) return;
  const target = new THREE.Vector3(camera.position.x, vrmScene.position.y, camera.position.z);
  const dir = target.clone().sub(vrmScene.position);
  dir.y = 0;
  if (dir.lengthSq() < 0.0001) return;
  dir.normalize();
  const targetYaw = Math.atan2(dir.x, dir.z);
  const currentYaw = vrmScene.rotation.y;
  // shortest angle
  let d = targetYaw - currentYaw;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  vrmScene.rotation.y += d * Math.min(1, dt * 3.2);
}

function updateWander(dt, now){
  if (!vrmScene || !wander.enabled) return;

  // pick new target every few seconds
  if (now > wander.nextPickAt){
    wander.nextPickAt = now + 2500 + Math.random()*2500;
    // Within the visible open corner (keep away from walls)
    const x = THREE.MathUtils.lerp(-0.3, 1.6, Math.random());
    const z = THREE.MathUtils.lerp(-1.2, 0.6, Math.random());
    wander.target.set(x, 0, z);
  }

  const pos = vrmScene.position;
  const to = wander.target.clone().sub(pos);
  to.y = 0;

  const dist = to.length();
  if (dist < 0.08) return;
  to.normalize();

  // Small "walk" glide + bob
  const speed = isMobile ? 0.25 : 0.32;
  pos.addScaledVector(to, dt * speed);
  pos.y = 0;

  // Face where going a bit
  const yaw = Math.atan2(to.x, to.z);
  let d = yaw - vrmScene.rotation.y;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  vrmScene.rotation.y += d * Math.min(1, dt * 2.0);
}

async function loadVRM(){
  const loader = new GLTFLoader();
  loader.crossOrigin = 'anonymous';
  loader.register((parser) => new VRMLoaderPlugin(parser));

  // VRM is big; keep things responsive
  const gltf = await new Promise((resolve, reject) => {
    loader.load('./assets/avatar.vrm', resolve, undefined, reject);
  });

  const loadedVrm = gltf.userData.vrm;

  // Cleanup + performance helpers
  VRMUtils.removeUnnecessaryVertices(gltf.scene);
  VRMUtils.removeUnnecessaryJoints(gltf.scene);

  // Make materials mobile-safe: replace heavy custom shaders with standard material.
  // (This avoids "GeometricContext" shader compile issues on some devices.)
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const newMats = mats.map((m) => {
      const std = new THREE.MeshStandardMaterial({
        map: m?.map ?? null,
        color: m?.color ? m.color.clone() : new THREE.Color(0xffffff),
        roughness: 0.95,
        metalness: 0.0,
        transparent: !!m?.transparent,
        opacity: m?.opacity ?? 1,
        side: m?.side ?? THREE.FrontSide,
      });
      if (m?.emissiveMap) std.emissiveMap = m.emissiveMap;
      if (m?.emissive) std.emissive = m.emissive.clone();
      return std;
    });
    o.material = Array.isArray(o.material) ? newMats : newMats[0];
    o.castShadow = true;
    o.receiveShadow = true;
  });

  loadedVrm.scene.scale.setScalar(1.0);
  loadedVrm.scene.position.set(0.65, 0, -0.25);

  scene.add(loadedVrm.scene);

  vrm = loadedVrm;
  vrmScene = loadedVrm.scene;
  head = vrm.humanoid.getRawBoneNode(VRMHumanBoneName.Head);
  hips = vrm.humanoid.getRawBoneNode(VRMHumanBoneName.Hips);

  // Initial calm pose
  applyCalmHandsPose(1.0);

  return loadedVrm;
}

function pickResponse(userText){
  const t = (userText || '').trim();
  const lower = t.toLowerCase();

  const has = (...keys) => keys.some(k => lower.includes(k));

  if (has('인사','안녕','hi','hello')){
    return { tag:'greet', gesture:'wave', say: sample([
      '안녕! 오늘도 만나서 반가워 😊',
      '어서 와! 여기 앉아볼래?',
      '안녕안녕~ 오늘은 어떤 이야기 할까?'
    ])};
  }
  if (has('기쁨','행복','좋아','신나')){
    return { tag:'happy', gesture:'happy', say: sample([
      '우와! 나도 기분 좋아졌어 ✨',
      '좋다좋다! 같이 축하하자!',
      '헤헤, 너무 좋아 🙂'
    ])};
  }
  if (has('슬픔','우울','힘들','눈물')){
    return { tag:'sad', gesture:'sad', say: sample([
      '괜찮아… 여기서 잠깐 쉬어가도 돼.',
      '마음이 무거울 땐 천천히 숨 쉬어보자.',
      '내가 옆에 있을게. 무슨 일 있었어?'
    ])};
  }
  if (has('화남','짜증','빡침','angry')){
    return { tag:'angry', gesture:'angry', say: sample([
      '으으… 그건 좀 너무했네!',
      '일단 진정…! 나랑 같이 정리해보자.',
      '그 마음 이해해. 어디가 제일 화났어?'
    ])};
  }
  if (has('놀람','대박','헉','surprise')){
    return { tag:'surprise', gesture:'surprise', say: sample([
      '헉! 진짜?',
      '우와… 그건 예상 못 했다!',
      '헉, 잠깐만… 다시 말해줘!'
    ])};
  }
  if (has('감사','고마','thx','thanks')){
    return { tag:'thanks', gesture:'wave', say: sample([
      '에이~ 고마워! 나도 고마워 😊',
      '별말씀을! 언제든지!',
      '헤헤, 나도 도움이 돼서 기뻐.'
    ])};
  }
  if (has('?','질문','궁금')){
    return { tag:'question', gesture:'idle', say: sample([
      '좋아, 같이 생각해보자. 무엇이 궁금해?',
      '음… 질문 좋아! 조금 더 자세히 말해줄래?',
      '좋아. 내가 아는 범위에서 정리해볼게.'
    ])};
  }

  // default small talk
  return { tag:'chat', gesture:'idle', say: sample([
    '응응, 계속 이야기해줘 🙂',
    '그렇구나…! 더 들어보고 싶어.',
    '오케이. 그럼 다음은?',
    '음~ 흥미로운데?'
  ])};
}

function sample(arr){
  return arr[Math.floor(Math.random()*arr.length)];
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = '';

  addMsg('You', text);

  // Behavior: stop wandering, face user
  wander.enabled = false;
  setTimeout(() => { wander.enabled = true; }, 1800);

  const res = pickResponse(text);
  addMsg('VTuber', res.say);
  speak(res.say);

  if (res.gesture && res.gesture !== 'idle') startGesture(res.gesture, 1.2);
});

// Demo starter lines
addMsg('VTuber', '교실 구석에 놀러왔어! 메시지 보내면 내가 돌아볼게 🙂');
addMsg('VTuber', '예: “인사”, “기쁨”, “슬픔”, “화남”, “놀람”');

// Resize
function resize(){
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

// Main
(async function boot(){
  try {
    await propsPromise;
    await loadVRM();
    loadingEl.classList.add('hidden');

    // place camera for nice framing
    controls.target.set(0.55, 1.12, -0.2);
    controls.update();

  } catch (e) {
    console.error(e);
    loadingEl.querySelector('.title').textContent = '로딩 실패 😵';
    loadingEl.querySelector('.sub').textContent = 'GitHub Pages에 업로드한 파일 경로/대소문자, 또는 모바일 WebGL 호환성 확인이 필요해요.';
  }
})();

// Render loop
let last = performance.now();
function tick(now){
  const dt = Math.min(0.033, (now - last) / 1000);
  last = now;

  resize();

  controls.update();

  if (vrm){
    // Wander around unless user just talked
    updateWander(dt, now);

    // When user chatted recently or is speaking, face camera
    if (now < speakingUntil + 250){
      faceUser(dt);
    }

    // Head look (small)
    if (head){
      head.rotation.y *= 0.92;
      head.rotation.x *= 0.92;
    }

    updateGesture(dt);
    updateFace(now);

    vrm.update(dt);
  }

  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
