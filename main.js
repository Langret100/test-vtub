// GitHub Pages fix:
// three-vrm imports 'three' as a bare module specifier.
// We provide an importmap in index.html, so we can import from 'three' here too.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from 'https://cdn.jsdelivr.net/npm/@pixiv/three-vrm@2.0.0/lib/three-vrm.module.js';

const canvas = document.getElementById('c');
const logEl = document.getElementById('log');
const form = document.getElementById('form');
const msgInput = document.getElementById('msg');
const voiceSelect = document.getElementById('voiceSelect');
const pitchEl = document.getElementById('pitch');
const rateEl = document.getElementById('rate');
const stopBtn = document.getElementById('stopBtn');

// ---------------------------
// Chat helpers
// ---------------------------
function addMessage(who, text) {
  const el = document.createElement('div');
  el.className = `msg ${who}`;
  const whoLabel = document.createElement('span');
  whoLabel.className = 'who';
  whoLabel.textContent = who === 'user' ? 'You' : 'VTuber';
  const body = document.createElement('div');
  body.textContent = text;
  el.appendChild(whoLabel);
  el.appendChild(body);
  logEl.appendChild(el);
  logEl.scrollTop = logEl.scrollHeight;
}

// Very simple “VTuber-like” reply (demo).
function makeReply(userText) {
  const t = userText.trim();
  if (!t) return '…?';
  if (/[?？]$/.test(t)) return '음… 그건 이렇게 생각해볼 수 있을 것 같아!';
  if (t.length < 8) return '오케이!';
  return `응응, ${t} 라고 했지? 나도 그렇게 생각해~`; 
}

// ---------------------------
// Web Speech (built-in TTS)
// ---------------------------
let voices = [];
let speaking = false;
let mouthTimer = null;

function refreshVoices() {
  voices = window.speechSynthesis?.getVoices?.() ?? [];
  voiceSelect.innerHTML = '';

  const preferred = (v) => {
    const lang = (v.lang || '').toLowerCase();
    const name = (v.name || '').toLowerCase();
    // Prefer Korean/Japanese and “female-ish” branded voices if any.
    const langScore = lang.startsWith('ko') ? 3 : (lang.startsWith('ja') ? 2 : 0);
    const nameScore = /(female|woman|girl|kyoko|haruka|yuri|sora|karen|nana|moe)/.test(name) ? 1 : 0;
    return langScore * 10 + nameScore;
  };

  const sorted = [...voices].sort((a,b) => preferred(b) - preferred(a));
  sorted.forEach((v, idx) => {
    const opt = document.createElement('option');
    opt.value = String(idx);
    opt.textContent = `${v.name} (${v.lang})`;
    voiceSelect.appendChild(opt);
  });
}

function stopSpeaking() {
  if (window.speechSynthesis) {
    window.speechSynthesis.cancel();
  }
  speaking = false;
  stopMouth();
}

stopBtn.addEventListener('click', stopSpeaking);

function startMouth() {
  // When using SpeechSynthesis, we don't have audio amplitude.
  // So we do a simple “talking” wobble.
  if (!currentVrm?.expressionManager) return;
  stopMouth();
  const start = performance.now();
  mouthTimer = setInterval(() => {
    const t = (performance.now() - start) / 1000;
    const v = 0.25 + 0.35 * (0.5 + 0.5 * Math.sin(t * 18));
    setMouth(v);
  }, 33);
}

function stopMouth() {
  if (mouthTimer) {
    clearInterval(mouthTimer);
    mouthTimer = null;
  }
  setMouth(0);
}

function speak(text) {
  if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) {
    addMessage('bot', '이 브라우저는 Web Speech TTS를 지원하지 않아…');
    return;
  }

  stopSpeaking();

  const u = new SpeechSynthesisUtterance(text);
  const idx = Number(voiceSelect.value || 0);
  u.voice = voices[idx] || voices[0] || null;
  u.pitch = Number(pitchEl.value || 1.0);
  u.rate = Number(rateEl.value || 1.0);

  u.onstart = () => {
    speaking = true;
    startMouth();
    // Trigger a cute, natural reaction gesture/expression based on the sentence.
    triggerReactionForText(text, { isBot: true });
  };
  u.onend = () => { speaking = false; stopMouth(); };
  u.onerror = () => { speaking = false; stopMouth(); };

  window.speechSynthesis.speak(u);
}

// Some browsers load voices async
if (window.speechSynthesis) {
  window.speechSynthesis.onvoiceschanged = refreshVoices;
  refreshVoices();
}

// ---------------------------
// Three.js + VRM
// ---------------------------
let currentVrm = null;
let rig = null;
let basePose = null;
let idleT = 0;
let activeGesture = null;

function getBone(name) {
  try {
    return currentVrm?.humanoid?.getNormalizedBoneNode?.(name) ?? null;
  } catch {
    return null;
  }
}

function captureRigAndBasePose() {
  rig = {
    hips: getBone('hips'),
    spine: getBone('spine'),
    chest: getBone('chest'),
    neck: getBone('neck'),
    head: getBone('head'),
    leftUpperArm: getBone('leftUpperArm'),
    leftLowerArm: getBone('leftLowerArm'),
    rightUpperArm: getBone('rightUpperArm'),
    rightLowerArm: getBone('rightLowerArm'),
  };
  // Store base rotations so we can layer animations on top.
  basePose = {};
  for (const [k, node] of Object.entries(rig)) {
    if (!node) continue;
    basePose[k] = {
      rx: node.rotation.x,
      ry: node.rotation.y,
      rz: node.rotation.z,
    };
  }
}

function setExpressionSafe(name, v) {
  const em = currentVrm?.expressionManager;
  if (!em) return;
  try {
    em.setValue(name, v);
  } catch {
    // Ignore missing expressions
  }
}

function startGesture(type, duration = 0.8) {
  activeGesture = { type, t: 0, duration };
}

function chooseEmotionFromText(text) {
  const t = (text || '').toLowerCase();
  if (/[!！]{1,}/.test(text)) return 'happy';
  if (/[?？]{1,}/.test(text)) return 'thinking';
  if (/(미안|sorry|슬프|힘들|우울|싫어|짜증|화나)/.test(t)) return 'sad';
  if (/(ㅋㅋ|ㅎㅎ|lol|cute|귀엽)/.test(t)) return 'happy';
  return 'neutral';
}

function triggerReactionForText(text, { isBot = true } = {}) {
  const emo = chooseEmotionFromText(text);
  // Expressions (if the model has them)
  setExpressionSafe('happy', emo === 'happy' ? 0.45 : 0.0);
  setExpressionSafe('sad', emo === 'sad' ? 0.5 : 0.0);
  setExpressionSafe('angry', 0.0);
  setExpressionSafe('surprised', /[!！]/.test(text) ? 0.25 : 0.0);

  // After a moment, return to a mild baseline.
  const token = Symbol('expr');
  triggerReactionForText._lastToken = token;
  setTimeout(() => {
    if (triggerReactionForText._lastToken !== token) return;
    setExpressionSafe('sad', 0.0);
    setExpressionSafe('surprised', 0.0);
    // Keep a slight "cute" happy baseline.
    setExpressionSafe('happy', 0.25);
  }, 1600);

  // Gestures
  if (emo === 'happy') {
    startGesture(Math.random() < 0.5 ? 'wave' : 'bounce', 0.9);
  } else if (emo === 'thinking') {
    startGesture('tilt', 0.9);
  } else if (emo === 'sad') {
    startGesture('slump', 1.1);
  } else {
    startGesture(isBot ? 'nod' : 'ack', 0.6);
  }
}

function applyIdle(dt) {
  if (!rig || !basePose) return;
  idleT += dt;

  // Gentle sway & breathing
  const sway = Math.sin(idleT * 1.2) * 0.06;
  const breathe = Math.sin(idleT * 2.0) * 0.04;

  if (rig.spine && basePose.spine) {
    rig.spine.rotation.y = basePose.spine.ry + sway * 0.35;
    rig.spine.rotation.x = basePose.spine.rx + breathe * 0.25;
  }
  if (rig.chest && basePose.chest) {
    rig.chest.rotation.y = basePose.chest.ry + sway * 0.5;
    rig.chest.rotation.x = basePose.chest.rx + breathe * 0.35;
  }
  if (rig.head && basePose.head) {
    rig.head.rotation.y = basePose.head.ry + sway * 0.8;
    rig.head.rotation.x = basePose.head.rx + Math.sin(idleT * 1.6) * 0.03;
  }
}

function applyGesture(dt) {
  if (!activeGesture || !rig || !basePose) return;
  activeGesture.t += dt;
  const p = Math.min(1, activeGesture.t / activeGesture.duration);

  // Smooth step
  const s = p * p * (3 - 2 * p);
  const w = Math.sin(Math.PI * s);

  const head = rig.head;
  const neck = rig.neck;
  const rUA = rig.rightUpperArm;
  const rLA = rig.rightLowerArm;
  const lUA = rig.leftUpperArm;
  const lLA = rig.leftLowerArm;
  const chest = rig.chest;

  switch (activeGesture.type) {
    case 'nod':
      if (head && basePose.head) head.rotation.x = basePose.head.rx + 0.35 * w;
      if (neck && basePose.neck) neck.rotation.x = basePose.neck.rx + 0.18 * w;
      break;
    case 'ack':
      if (head && basePose.head) head.rotation.y = basePose.head.ry + 0.25 * Math.sin(Math.PI * 2 * s) * (1 - p);
      break;
    case 'tilt':
      if (head && basePose.head) head.rotation.z = basePose.head.rz + 0.25 * w;
      if (neck && basePose.neck) neck.rotation.z = basePose.neck.rz + 0.12 * w;
      break;
    case 'bounce':
      if (chest && basePose.chest) chest.rotation.x = basePose.chest.rx - 0.22 * w;
      if (head && basePose.head) head.rotation.x = basePose.head.rx - 0.18 * w;
      break;
    case 'slump':
      if (chest && basePose.chest) chest.rotation.x = basePose.chest.rx + 0.28 * w;
      if (head && basePose.head) head.rotation.x = basePose.head.rx + 0.25 * w;
      if (head && basePose.head) head.rotation.z = basePose.head.rz + 0.08 * Math.sin(Math.PI * s);
      break;
    case 'wave':
      // Simple wave with right arm
      if (rUA && basePose.rightUpperArm) {
        rUA.rotation.z = basePose.rightUpperArm.rz - 0.9 * w;
        rUA.rotation.x = basePose.rightUpperArm.rx - 0.4 * w;
      }
      if (rLA && basePose.rightLowerArm) {
        rLA.rotation.z = basePose.rightLowerArm.rz - 0.4 * w;
        rLA.rotation.y = basePose.rightLowerArm.ry + 0.6 * Math.sin(Math.PI * 4 * s) * (1 - p);
      }
      if (head && basePose.head) head.rotation.x = basePose.head.rx - 0.08 * w;
      break;
    default:
      break;
  }

  if (p >= 1) {
    // Return arm rotations to base (idle will keep subtle motion)
    activeGesture = null;
  }
}

// WebGL2 check: three-vrm MToon shaders use GLSL3 features.
// If the device/browser falls back to WebGL1, MToon may fail to compile.
const gl2 = canvas.getContext('webgl2', { antialias: true, alpha: true });
const supportsWebGL2 = !!gl2;
if (!supportsWebGL2) {
  console.warn('[VTuber] WebGL2 not available. Falling back to basic materials (no MToon).');
  addMessage('bot', '⚠️ 이 기기에서는 WebGL2가 꺼져있거나 지원되지 않아, 간단한 재질로 표시할게.');
}

const renderer = new THREE.WebGLRenderer({
  canvas,
  context: gl2 || undefined,
  antialias: true,
  alpha: true,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0f14);

const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
camera.position.set(0, 1.35, 2.4);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.25, 0);
controls.enableDamping = true;

scene.add(new THREE.HemisphereLight(0xffffff, 0x223344, 1.1));
const dir = new THREE.DirectionalLight(0xffffff, 1.1);
dir.position.set(1.5, 2.5, 2.0);
scene.add(dir);

function cloneBasicMaterial(src, isSkinned) {
  // Replace MToon (custom toon shader) with a standard PBR material to keep WebGL1 compatibility.
  const dst = new THREE.MeshStandardMaterial();
  if (src.color) dst.color.copy(src.color);
  if (src.map) dst.map = src.map;
  if (src.normalMap) dst.normalMap = src.normalMap;
  if (src.emissive) dst.emissive.copy(src.emissive);
  if (src.emissiveMap) dst.emissiveMap = src.emissiveMap;
  if (src.roughness != null) dst.roughness = src.roughness;
  if (src.metalness != null) dst.metalness = src.metalness;

  // Transparency / cutout
  dst.transparent = !!src.transparent;
  dst.opacity = src.opacity != null ? src.opacity : 1;
  dst.alphaTest = src.alphaTest != null ? src.alphaTest : 0;
  dst.depthWrite = src.depthWrite != null ? src.depthWrite : true;
  dst.side = src.side != null ? src.side : THREE.FrontSide;

  // Skinning
  dst.skinning = !!isSkinned;

  dst.needsUpdate = true;
  return dst;
}

function downgradeMaterialsForWebGL1(root) {
  root.traverse((obj) => {
    if (!obj.isMesh) return;
    const isSkinned = !!obj.isSkinnedMesh;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    const newMats = mats.map((m) => {
      if (!m) return m;
      // Avoid cloning if it's already a standard material
      const type = (m.type || '').toLowerCase();
      if (type.includes('standard') || type.includes('phong') || type.includes('lambert')) {
        if (isSkinned && m.skinning !== true) {
          m.skinning = true;
          m.needsUpdate = true;
        }
        return m;
      }
      return cloneBasicMaterial(m, isSkinned);
    });
    obj.material = Array.isArray(obj.material) ? newMats : newMats[0];
  });
}

const loader = new GLTFLoader();
loader.register((parser) => new VRMLoaderPlugin(parser));

async function loadVrm() {
  addMessage('bot', '아바타 로딩중…');
  return new Promise((resolve, reject) => {
    loader.load(
      './assets/Base_Female.vrm',
      (gltf) => {
        const vrm = gltf.userData.vrm;
        VRMUtils.removeUnnecessaryVertices(gltf.scene);
        VRMUtils.removeUnnecessaryJoints(gltf.scene);

        if (currentVrm) {
          scene.remove(currentVrm.scene);
        }
        currentVrm = vrm;

        if (!supportsWebGL2) {
          // Make the avatar visible on WebGL1 by replacing MToon materials.
          downgradeMaterialsForWebGL1(vrm.scene);
        }


        // Nice default pose/position
        vrm.scene.rotation.y = Math.PI; // face camera
        scene.add(vrm.scene);

        // Slightly “cute” expression baseline
        setExpressionSafe('happy', 0.25);
        // Prepare bones for gestures
        captureRigAndBasePose();

        addMessage('bot', '로딩 완료! 메시지를 보내면 읽어줄게 🙂');
        resolve(vrm);
      },
      undefined,
      (err) => {
        console.error(err);
        addMessage('bot', '아바타 로딩에 실패했어…');
        reject(err);
      }
    );
  });
}

function setMouth(v) {
  if (!currentVrm?.expressionManager) return;
  // VRM 1.0 expressions: 'aa','ih','ou','ee','oh'
  currentVrm.expressionManager.setValue('aa', v);
}

function resize() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

window.addEventListener('resize', resize);

let last = performance.now();
function tick(now) {
  const dt = (now - last) / 1000;
  last = now;

  resize();
  controls.update();

  if (currentVrm) {
    currentVrm.update(dt);
    // Layer cute idle + gesture animations on top of VRM's internal update.
    applyIdle(dt);
    applyGesture(dt);
  }

  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

await loadVrm();
requestAnimationFrame(tick);

// ---------------------------
// Chat flow
// ---------------------------
form.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = msgInput.value.trim();
  if (!text) return;
  msgInput.value = '';

  addMessage('user', text);
  // A small acknowledgement gesture when you talk to her.
  triggerReactionForText(text, { isBot: false });
  const reply = makeReply(text);

  // Give a tiny delay for “chat-like” feel
  setTimeout(() => {
    addMessage('bot', reply);
    speak(reply);
  }, 250);
});
