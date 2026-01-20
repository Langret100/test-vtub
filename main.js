import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
import { OrbitControls } from 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/loaders/GLTFLoader.js';
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

  u.onstart = () => { speaking = true; startMouth(); };
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

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
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

        // Nice default pose/position
        vrm.scene.rotation.y = Math.PI; // face camera
        scene.add(vrm.scene);

        // Slightly “cute” expression baseline
        if (vrm.expressionManager) {
          vrm.expressionManager.setValue('happy', 0.25);
        }

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
  const reply = makeReply(text);

  // Give a tiny delay for “chat-like” feel
  setTimeout(() => {
    addMessage('bot', reply);
    speak(reply);
  }, 250);
});
