// GitHub Pages fix:
// three-vrm imports 'three' as a bare module specifier.
// We provide an importmap in index.html, so we can import from 'three' here too.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
// IMPORTANT: three-vrm v2 can be incompatible with newer Three.js shader chunks (r157+),
// and may cause MToon shader compile errors (e.g. "GeometricContext").
// Use a recent three-vrm v3.x build that tracks newer Three.js revisions.
import { VRMLoaderPlugin, VRMUtils } from 'https://cdn.jsdelivr.net/npm/@pixiv/three-vrm@3.4.5/lib/three-vrm.module.js';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from 'https://cdn.jsdelivr.net/npm/@pixiv/three-vrm-animation@3.4.5/lib/three-vrm-animation.module.js';

const canvas = document.getElementById('c');
const logEl = document.getElementById('log');
const form = document.getElementById('form');
const msgInput = document.getElementById('msg');
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
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function norm(s) {
  return (s || '').trim();
}

function makeReply(userText) {
  const t = norm(userText);
  if (!t) return '응? 다시 한 번 말해줄래?';

  // Greetings / small talk
  if (/^(안녕|ㅎㅇ|하이|hello|hi)\b/i.test(t)) {
    return pick([
      '안녕! 오늘 기분 어때? 😊',
      '하이하이~ 나 왔어! 뭐 할까?',
      '안뇽! 만나서 반가워~',
    ]);
  }
  if (/(고마워|thanks|thx)/i.test(t)) {
    return pick(['에헤헤~ 천만에!', '별말을~ 도움이 되면 나도 좋아!', '언제든지 불러줘!']);
  }
  if (/(미안|sorry)/i.test(t)) {
    return pick(['괜찮아 괜찮아~', '에이 괜찮지!', '신경 쓰지 마~']);
  }
  if (/(피곤|졸려|잠|sleep)/i.test(t)) {
    return pick(['으앙… 나도 살짝 졸려… 같이 쉬었다 할까?', '따뜻한 물 한 잔 어때?', '잠깐 스트레칭하고 올래?']);
  }

  // Identity / playful
  if (/(이름|누구|정체|누구야|who are you)/i.test(t)) {
    return pick([
      '나는 데모 VTuber야! 아직은 간단한 규칙 기반이지만, 점점 똑똑해질지도? 😚',
      '나는 교실에 사는(?) 작은 VTuber~ 편하게 불러줘!',
    ]);
  }
  if (/(사랑|좋아해|보고싶|love you)/i.test(t)) {
    return pick([
      '에엣… 갑자기 그런 말 하면 부끄럽잖아… 😳',
      '나도 너 좋아~! (소곤소곤) 🤍',
      '으아아… 심장 두근…!',
    ]);
  }
  if (/(배고|밥|먹을|간식|치킨|떡볶이)/i.test(t)) {
    return pick([
      '간식 타임! 뭐 먹고 싶어? 난 달달한 거 땡겨~',
      '배고프면 집중 안 돼! 같이 뭐 주워먹자 😋',
      '치킨…? 나도 한 입만…!',
    ]);
  }
  if (/(공부|숙제|시험|과제)/i.test(t)) {
    return pick([
      '공부는 싫지만… 같이 하면 할 만해! 25분 집중하고 5분 쉬자!',
      '오케이, 오늘 목표 딱 하나만 정해볼래?',
      '시험이면 컨디션이 제일 중요해. 물 마시고! 😤',
    ]);
  }

  // Simple “opinions”
  if (/[?？]$/.test(t) || /(왜|어떻게|뭐야|어떤)/.test(t)) {
    return pick([
      '음… 내 생각엔 이렇게 해보는 게 좋을 것 같아!',
      '그거 좋은 질문이야. 한 번 같이 정리해볼까?',
      '잠깐만… 머리 굴리는 중… 😳',
    ]);
  }

  if (/(ㅋㅋ|ㅎㅎ|lol|귀엽|웃겨)/i.test(t)) {
    return pick(['ㅋㅋㅋ 그치? 나도 웃겨!', '에헤헤~ 나도 빵 터졌어!', '앗 부끄럽다…']);
  }

  // Fallback
  const echo = t.length > 24 ? t.slice(0, 24) + '…' : t;
  return pick([
    `응응, “${echo}” 맞지? 나도 그렇게 느껴! 그럼 너는 어떤 점이 제일 마음에 들어?`,
    `오케이! “${echo}” 메모해둘게~ 다음으로 뭐부터 해볼까?`,
    `좋아! 그럼 다음은 뭐 해볼까? 갑자기 궁금한 거 있어?`,
  ]);
}

// ---------------------------
// Web Speech (built-in TTS)
// ---------------------------
let voices = [];
let speaking = false;
let selectedVoice = null;
let mouthPulse = 0;
let mouthShape = 'aa';

function scoreVoice(v) {
  const lang = (v.lang || '').toLowerCase();
  const name = (v.name || '').toLowerCase();
  // We can't guarantee a "cute" voice across OSes, so we pick the best
  // available Korean voice, then slightly raise pitch/rate.
  const langScore = lang.startsWith('ko') ? 30 : (lang.startsWith('ja') ? 10 : 0);
  const nameScore = /(heami|sunhi|seoyeon|yuna|kyoko|haruka|yuri|sora|karen|nana|moe|female|woman|girl)/.test(name) ? 3 : 0;
  const localScore = v.localService ? 1 : 0;
  return langScore + nameScore + localScore;
}

function refreshVoices() {
  voices = window.speechSynthesis?.getVoices?.() ?? [];
  selectedVoice = [...voices].sort((a, b) => scoreVoice(b) - scoreVoice(a))[0] || null;
}

function stopSpeaking() {
  if (window.speechSynthesis) {
    window.speechSynthesis.cancel();
  }
  speaking = false;
  mouthPulse = 0;
}

stopBtn.addEventListener('click', stopSpeaking);

function pulseMouth() {
  // Short "open" envelope. We'll decay it in the render loop.
  mouthPulse = Math.min(1, mouthPulse + 0.75);
  mouthShape = pick(['aa', 'ih', 'ou', 'ee', 'oh']);
}

function speak(text) {
  if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) {
    addMessage('bot', '이 브라우저는 Web Speech TTS를 지원하지 않아…');
    return;
  }

  stopSpeaking();

  const u = new SpeechSynthesisUtterance(text);
  u.voice = selectedVoice || voices[0] || null;
  // Default to a slightly "cute" tone.
  u.pitch = Number(pitchEl.value || 1.35);
  u.rate = Number(rateEl.value || 1.15);

  // Approximate lip sync: boundary events (if supported) + lightweight fallback.
  u.onboundary = () => pulseMouth();

  u.onstart = () => {
    speaking = true;
    // Trigger a cute, natural reaction gesture/expression based on the sentence.
    triggerReactionForText(text, { isBot: true });
  };
  u.onend = () => { speaking = false; mouthPulse = 0; };
  u.onerror = () => { speaking = false; mouthPulse = 0; };

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
let mixer = null;
let idleAction = null;
let currentAction = null;
const vrmaCache = new Map(); // fileName -> AnimationClip

const VRMA_BASE_URL = 'https://raw.githubusercontent.com/tk256ailab/vrm-viewer/main/VRMA/';
const MOTIONS = {
  idle: 'Relax.vrma',
  greeting: 'Goodbye.vrma',
  happy: 'Blush.vrma',
  clap: 'Clapping.vrma',
  sad: 'Sad.vrma',
  surprised: 'Surprised.vrma',
  thinking: 'Thinking.vrma',
  sleepy: 'Sleepy.vrma',
  jump: 'Jump.vrma',
  look: 'LookAround.vrma',
  angry: 'Angry.vrma',
};

const vrmaLoader = new GLTFLoader();
vrmaLoader.register((parser) => new VRMAnimationLoaderPlugin(parser));

function setExpressionSafe(name, v) {
  const em = currentVrm?.expressionManager;
  if (!em) return;
  try {
    em.setValue(name, v);
  } catch {
    // Ignore missing expressions
  }
}

async function loadMotionClip(fileName) {
  if (vrmaCache.has(fileName)) return vrmaCache.get(fileName);
  const gltf = await vrmaLoader.loadAsync(VRMA_BASE_URL + fileName);
  const vrmAnim = gltf.userData.vrmAnimations?.[0];
  if (!vrmAnim) throw new Error('VRMA has no vrmAnimations');
  const clip = createVRMAnimationClip(vrmAnim, currentVrm);
  vrmaCache.set(fileName, clip);
  return clip;
}

async function ensureIdle() {
  if (!currentVrm) return;
  if (!mixer) mixer = new THREE.AnimationMixer(currentVrm.scene);
  if (idleAction) return;
  const clip = await loadMotionClip(MOTIONS.idle);
  idleAction = mixer.clipAction(clip);
  idleAction.setLoop(THREE.LoopRepeat, Infinity);
  idleAction.enabled = true;
  idleAction.play();
  currentAction = idleAction;
}

function crossFadeTo(nextAction, fade = 0.25) {
  if (!nextAction) return;
  if (currentAction && currentAction !== nextAction) {
    nextAction.reset();
    nextAction.enabled = true;
    nextAction.play();
    currentAction.crossFadeTo(nextAction, fade, false);
  } else {
    nextAction.reset();
    nextAction.enabled = true;
    nextAction.play();
  }
  currentAction = nextAction;
}

async function playOneShot(fileName, { fade = 0.2, strength = 1.0 } = {}) {
  if (!currentVrm) return;
  await ensureIdle();
  const clip = await loadMotionClip(fileName);
  const a = mixer.clipAction(clip);
  a.setEffectiveWeight(strength);
  a.setLoop(THREE.LoopOnce, 1);
  a.clampWhenFinished = true;

  // Fade out any non-idle action quickly.
  if (currentAction && currentAction !== idleAction) {
    currentAction.fadeOut(0.12);
  }
  crossFadeTo(a, fade);

  // Return to idle when finished.
  const onFinished = (e) => {
    if (e.action !== a) return;
    mixer.removeEventListener('finished', onFinished);
    if (idleAction) {
      idleAction.reset();
      idleAction.enabled = true;
      idleAction.play();
      a.crossFadeTo(idleAction, 0.25, false);
      currentAction = idleAction;
    }
  };
  mixer.addEventListener('finished', onFinished);
}

function chooseEmotionFromText(text) {
  const t = (text || '').toLowerCase();
  if (/(피곤|졸려|잠|sleep)/.test(t)) return 'sleepy';
  if (/[!！]{1,}/.test(text)) return 'surprised';
  if (/[?？]{1,}/.test(text)) return 'thinking';
  if (/(미안|sorry|슬프|힘들|우울|싫어)/.test(t)) return 'sad';
  if (/(짜증|화나|angry)/.test(t)) return 'angry';
  if (/(ㅋㅋ|ㅎㅎ|lol|귀엽|좋아|최고)/.test(t)) return 'happy';
  return 'neutral';
}

function triggerReactionForText(text, { isBot = true } = {}) {
  const emo = chooseEmotionFromText(text);
  // Expressions (if the model has them)
  setExpressionSafe('happy', emo === 'happy' ? 0.55 : 0.18);
  setExpressionSafe('sad', emo === 'sad' ? 0.55 : 0.0);
  setExpressionSafe('angry', emo === 'angry' ? 0.45 : 0.0);
  setExpressionSafe('surprised', emo === 'surprised' ? 0.35 : 0.0);
  setExpressionSafe('relaxed', 0.15);

  // After a moment, return to a mild baseline.
  const token = Symbol('expr');
  triggerReactionForText._lastToken = token;
  setTimeout(() => {
    if (triggerReactionForText._lastToken !== token) return;
    setExpressionSafe('sad', 0.0);
    setExpressionSafe('surprised', 0.0);
    // Keep a slight "cute" happy baseline.
    setExpressionSafe('angry', 0.0);
    setExpressionSafe('happy', 0.18);
  }, 1600);
  // Motions (VRMA one-shots). If it fails to load (network blocked), expressions still work.
  const looksLikeGreeting = /^(안녕|ㅎㅇ|하이|hello|hi)\\b/i.test((text || '').trim());
  if (looksLikeGreeting && isBot) {
    playOneShot(MOTIONS.greeting).catch(() => {});
    return;
  }

  const map = {
    happy: () => playOneShot(Math.random() < 0.45 ? MOTIONS.happy : MOTIONS.clap),
    sad: () => playOneShot(MOTIONS.sad),
    surprised: () => playOneShot(MOTIONS.surprised),
    thinking: () => playOneShot(MOTIONS.thinking),
    sleepy: () => playOneShot(MOTIONS.sleepy, { strength: 0.95 }),
    angry: () => playOneShot(MOTIONS.angry, { strength: 0.95 }),
    neutral: () => (Math.random() < 0.22 ? playOneShot(MOTIONS.look, { strength: 0.9 }) : Promise.resolve()),
  };
  (map[emo] || map.neutral)().catch(() => {});
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
// Classroom-like background (free photo).
// NOTE: We load from a free CDN-friendly host to keep this repo small.
const BG_URL = 'https://images.pexels.com/photos/289740/pexels-photo-289740.jpeg?auto=compress&cs=tinysrgb&w=1600';
{
  const texLoader = new THREE.TextureLoader();
  texLoader.setCrossOrigin('anonymous');
  texLoader.load(
    BG_URL,
    (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      scene.background = tex;
    },
    undefined,
    () => {
      // fallback
      scene.background = new THREE.Color(0x0b0f14);
    }
  );
}
scene.fog = new THREE.Fog(0x0b0f14, 2.2, 7.0);

const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
camera.position.set(0, 1.35, 2.4);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.25, 0);
controls.enableDamping = true;

scene.add(new THREE.HemisphereLight(0xffffff, 0x223344, 1.1));
const dir = new THREE.DirectionalLight(0xffffff, 1.1);
dir.position.set(1.5, 2.5, 2.0);
scene.add(dir);

// Simple floor to ground the avatar.
{
  const g = new THREE.PlaneGeometry(10, 10);
  const m = new THREE.MeshStandardMaterial({ color: 0x0f1722, roughness: 1.0, metalness: 0.0 });
  const floor = new THREE.Mesh(g, m);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = 0;
  floor.receiveShadow = false;
  scene.add(floor);
}

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
        setExpressionSafe('happy', 0.18);
        setExpressionSafe('relaxed', 0.15);

        // Start the default idle VRMA motion to avoid T-pose.
        ensureIdle()
          .then(() => {
            // Preload a few common one-shots in the background (best effort).
            [MOTIONS.greeting, MOTIONS.happy, MOTIONS.thinking, MOTIONS.surprised].forEach((m) => {
              loadMotionClip(m).catch(() => {});
            });
          })
          .catch(() => {
            // If VRMA fails to load (offline/CORS), we still show the model.
          });

        addMessage('bot', '로딩 완료! (교실 배경 + 기본 모션 적용)');
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

const VISEMES = ['aa', 'ih', 'ou', 'ee', 'oh'];
function setMouthShape(shape, amount) {
  const em = currentVrm?.expressionManager;
  if (!em) return;
  for (const k of VISEMES) {
    em.setValue(k, k === shape ? amount : 0);
  }
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
let blinkCooldown = 1.8 + Math.random() * 2.8;
let blinkPhase = 0; // 0 = idle, >0 = blinking seconds

function updateBlink(dt) {
  if (!currentVrm) return;

  if (blinkPhase > 0) {
    blinkPhase += dt;
    // A quick smooth blink
    const dur = 0.12;
    const x = Math.min(1, blinkPhase / dur);
    const v = Math.sin(x * Math.PI); // 0->1->0
    setExpressionSafe('blink', v);
    if (blinkPhase >= dur) {
      blinkPhase = 0;
      setExpressionSafe('blink', 0);
      blinkCooldown = 1.6 + Math.random() * 3.6;
    }
    return;
  }

  blinkCooldown -= dt;
  if (blinkCooldown <= 0) {
    blinkPhase = 0.0001;
  }
}

function tick(now) {
  const dt = (now - last) / 1000;
  last = now;

  resize();
  controls.update();

  if (currentVrm) {
    // Animations
    mixer?.update(dt);
    currentVrm.update(dt);

    // Blink
    updateBlink(dt);

    // Lip sync (very rough): decay the pulse, and occasionally pulse while speaking.
    if (speaking && mouthPulse < 0.15 && Math.random() < dt * 10) pulseMouth();
    mouthPulse = Math.max(0, mouthPulse - dt * 5.5);
    setMouthShape(mouthShape, mouthPulse * 0.85);
  }

  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

await loadVrm();

// Seed a few random greeting lines so you can immediately see reactions.
{
  const greet = pick([
    '안녕~ 오늘도 만나서 반가워! 😊',
    '하이하이! 교실에 놀러왔어? ✨',
    '안뇽! 뭐 얘기해볼까? 😳',
  ]);
  addMessage('bot', greet);
  // Don't auto-speak immediately (some people hate autoplay). Click Send to hear.
  addMessage('bot', '예시: "안녕" / "오늘 뭐해?" / "ㅋㅋ" / "피곤해" 같은 말도 좋아!');
  triggerReactionForText(greet, { isBot: true });
}
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
