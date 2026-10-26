import * as THREE from "three";
import { FilesetResolver, HandLandmarker } from "./vendor/vision_bundle.mjs";

const TAU = Math.PI * 2;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const damp = (current, target, speed, delta) => current + (target - current) * (1 - Math.exp(-speed * delta));

const dom = {
  canvas: document.querySelector("#webglCanvas"),
  bootScreen: document.querySelector("#bootScreen"),
  bootStatus: document.querySelector("#bootStatus"),
  startCameraButton: document.querySelector("#startCameraButton"),
  startDemoButton: document.querySelector("#startDemoButton"),
  cameraCard: document.querySelector("#cameraCard"),
  cameraVideo: document.querySelector("#cameraVideo"),
  landmarkCanvas: document.querySelector("#landmarkCanvas"),
  cameraAction: document.querySelector("#cameraAction"),
  trackingLabel: document.querySelector("#trackingLabel"),
  fingerCount: document.querySelector("#fingerCount"),
  gestureGlyph: document.querySelector("#gestureGlyph"),
  gestureLabel: document.querySelector("#gestureLabel"),
  gestureEnglish: document.querySelector("#gestureEnglish"),
  bloomRing: document.querySelector("#bloomRing"),
  bloomPercent: document.querySelector("#bloomPercent"),
  sessionStatus: document.querySelector("#sessionStatus"),
  systemState: document.querySelector(".system-state"),
  inputMode: document.querySelector("#inputMode"),
  interactionGuide: document.querySelector("#interactionGuide"),
  toast: document.querySelector("#toast"),
};

const state = {
  mode: "idle",
  awake: false,
  bloom: 0.42,
  targetBloom: 0.62,
  pointer: new THREE.Vector2(0.34, 0.12),
  pointerStrength: 0,
  handDetected: false,
  lastHandAt: 0,
  fingerCount: 0,
  gestureState: "searching",
  cameraActive: false,
  cameraStarting: false,
  visionReady: false,
  landmarker: null,
  mediaStream: null,
  demoPressed: false,
  demoPinned: false,
  lastVideoTime: -1,
  toastTimer: null,
  lastUiUpdate: 0,
  lastStatusKey: "",
};

let flowerScene;
let visionPromise;
let detectionFrame = 0;

function setBootStatus(message, isError = false) {
  dom.bootStatus.textContent = message;
  dom.bootStatus.classList.toggle("is-error", isError);
}

function setSessionStatus(message, kind = "") {
  dom.sessionStatus.textContent = message;
  dom.systemState.classList.toggle("is-loading", kind === "loading");
  dom.systemState.classList.toggle("is-demo", kind === "demo");
}

function showToast(message, timeout = 4800) {
  window.clearTimeout(state.toastTimer);
  dom.toast.textContent = message;
  dom.toast.classList.add("is-visible");
  state.toastTimer = window.setTimeout(() => {
    dom.toast.classList.remove("is-visible");
  }, timeout);
}

function finishBoot(mode) {
  state.awake = true;
  state.mode = mode;
  document.body.classList.add("is-awake");
  window.setTimeout(() => {
    dom.bootScreen.setAttribute("aria-hidden", "true");
  }, 1200);
}

function setGestureUi() {
  const bloom = clamp(state.bloom, 0, 1);
  dom.bloomPercent.textContent = String(Math.round(bloom * 100)).padStart(2, "0");
  dom.bloomRing.style.strokeDashoffset = String(169.65 * (1 - bloom));

  let label = "等待手势";
  let english = "AWAITING SIGNAL";
  let glyphState = "searching";

  if (state.mode === "demo") {
    if (state.demoPinned || bloom > 0.78) {
      label = "盛放";
      english = "IN FULL BLOOM";
      glyphState = "open";
    } else if (bloom > 0.38) {
      label = "随光呼吸";
      english = "DEMO MOTION";
      glyphState = "open";
    } else {
      label = "花苞";
      english = "SOFTLY CLOSED";
      glyphState = "closed";
    }
  } else if (state.mode === "camera" && state.handDetected) {
    if (state.gestureState === "bloom") {
      label = "盛放";
      english = "OPEN PALM / BLOOM";
      glyphState = "open";
    } else if (state.gestureState === "emerging") {
      label = "初绽";
      english = "GESTURE EMERGING";
      glyphState = "open";
    } else {
      label = "花苞";
      english = "FIST / CLOSED BUD";
      glyphState = "closed";
    }
  } else if (state.mode === "camera") {
    label = "寻找手部";
    english = "SEARCHING FOR HAND";
    glyphState = "searching";
  }

  const key = `${label}|${english}|${glyphState}`;
  if (key !== state.lastStatusKey) {
    dom.gestureLabel.textContent = label;
    dom.gestureEnglish.textContent = english;
    dom.gestureGlyph.className = `gesture-glyph is-${glyphState}`;
    state.lastStatusKey = key;
  }
}

function normalizeHandLandmarks(landmarks) {
  const distance = (a, b) => Math.hypot(
    landmarks[a].x - landmarks[b].x,
    landmarks[a].y - landmarks[b].y,
    (landmarks[a].z || 0) - (landmarks[b].z || 0),
  );

  const angleCos = (a, b, c) => {
    const ax = landmarks[b].x - landmarks[a].x;
    const ay = landmarks[b].y - landmarks[a].y;
    const bx = landmarks[c].x - landmarks[b].x;
    const by = landmarks[c].y - landmarks[b].y;
    return (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by) + 1e-6);
  };

  const chainExtension = (mcp, pip, tip) => {
    const straightness = angleCos(mcp, pip, tip);
    const reach = distance(tip, 0) / Math.max(distance(pip, 0), 0.001);
    return straightness > 0.12 && reach > 1.035 ? 1 : 0;
  };

  const fingerStates = [
    distance(4, 0) / Math.max(distance(2, 0), 0.001) > 1.11 ? 1 : 0,
    chainExtension(5, 6, 8),
    chainExtension(9, 10, 12),
    chainExtension(13, 14, 16),
    chainExtension(17, 18, 20),
  ];

  const count = fingerStates.reduce((sum, item) => sum + item, 0);
  const handScale = Math.max(distance(0, 9), 0.035);
  const palmSpread = distance(4, 20) / handScale;
  const scoreByCount = [0.025, 0.045, 0.17, 0.47, 0.79, 1];
  let targetBloom = scoreByCount[count];

  if (count === 3) targetBloom = palmSpread > 1.18 ? 0.54 : 0.39;
  if (count >= 4) targetBloom = Math.max(targetBloom, clamp(0.68 + palmSpread * 0.08, 0.68, 0.96));
  if (count <= 1 && palmSpread > 1.45) targetBloom = Math.max(targetBloom, 0.18);

  return {
    count,
    targetBloom: clamp(targetBloom, 0.02, 1),
    gestureState: count >= 4 ? "bloom" : count >= 2 ? "emerging" : "bud",
    pointerX: clamp((0.5 - landmarks[9].x) * 2, -1.15, 1.15),
    pointerY: clamp((0.5 - landmarks[9].y) * 2, -1, 1),
  };
}

function drawHandOverlay(landmarks) {
  const canvas = dom.landmarkCanvas;
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);

  if (!landmarks) {
    ctx.strokeStyle = "rgba(255, 199, 125, 0.24)";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 8]);
    ctx.beginPath();
    ctx.moveTo(rect.width * 0.5, rect.height * 0.5 - 12);
    ctx.lineTo(rect.width * 0.5, rect.height * 0.5 + 12);
    ctx.moveTo(rect.width * 0.5 - 12, rect.height * 0.5);
    ctx.lineTo(rect.width * 0.5 + 12, rect.height * 0.5);
    ctx.stroke();
    ctx.setLineDash([]);
    return;
  }

  const points = landmarks.map((point) => ({
    x: (1 - point.x) * rect.width,
    y: point.y * rect.height,
  }));

  const connections = [
    [0, 1], [1, 2], [2, 3], [3, 4],
    [0, 5], [5, 6], [6, 7], [7, 8],
    [5, 9], [9, 10], [10, 11], [11, 12],
    [9, 13], [13, 14], [14, 15], [15, 16],
    [13, 17], [17, 18], [18, 19], [19, 20],
    [0, 17],
  ];

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  [1, 5, 9, 13, 17].forEach((index) => ctx.lineTo(points[index].x, points[index].y));
  ctx.closePath();
  ctx.fillStyle = "rgba(255, 89, 132, 0.075)";
  ctx.fill();
  ctx.restore();

  ctx.strokeStyle = "rgba(255, 226, 211, 0.58)";
  ctx.lineWidth = 1.15;
  ctx.shadowColor = "rgba(255, 87, 133, 0.7)";
  ctx.shadowBlur = 5;
  ctx.beginPath();
  connections.forEach(([start, end]) => {
    ctx.moveTo(points[start].x, points[start].y);
    ctx.lineTo(points[end].x, points[end].y);
  });
  ctx.stroke();

  ctx.shadowBlur = 0;
  points.forEach((point, index) => {
    const isTip = [4, 8, 12, 16, 20].includes(index);
    ctx.beginPath();
    ctx.arc(point.x, point.y, isTip ? 3.2 : 1.8, 0, TAU);
    ctx.fillStyle = isTip ? "rgba(255, 111, 151, 0.96)" : "rgba(255, 238, 220, 0.72)";
    ctx.fill();
  });

  const fingertip = points[8];
  const pulse = 7 + Math.sin(performance.now() * 0.006) * 2.2;
  ctx.beginPath();
  ctx.arc(fingertip.x, fingertip.y, pulse, 0, TAU);
  ctx.strokeStyle = "rgba(255, 111, 151, 0.42)";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}

class FlowerExperience {
  constructor(canvas) {
    this.canvas = canvas;
    this.clock = new THREE.Clock();
    this.pointerSmooth = new THREE.Vector2(0.34, 0.12);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 80);
    this.camera.position.set(0, 0, 8.65);
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: false,
      powerPreference: "high-performance",
    });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;

    this.root = new THREE.Group();
    this.flowerGroup = new THREE.Group();
    this.root.add(this.flowerGroup);
    this.scene.add(this.root);
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, 1.8);
    this.renderer.setPixelRatio(this.pixelRatio);

    this.createFlower();
    this.createDust();
    this.createBotanicalGeometry();
    this.baseX = 2.1;
    this.baseY = 0.12;
    this.baseScale = 0.95;
    this.resize();
  }
  createFlower() {
    const compact = window.innerWidth < 760;
    const quality = compact ? 0.52 : window.innerWidth < 1180 ? 0.78 : 1;
    const configs = [
      { petals: 9, count: 4700, length: 1.77, width: 0.48, offset: -0.11, layer: 0, colorA: "#8f0c45", colorB: "#ff5f8c", tip: "#ffc49e", size: 1.05 },
      { petals: 8, count: 3450, length: 1.36, width: 0.44, offset: 0.36, layer: 1, colorA: "#b71455", colorB: "#ff7898", tip: "#ffe0bb", size: 0.98 },
      { petals: 7, count: 2550, length: 0.96, width: 0.39, offset: 0.92, layer: 2, colorA: "#720632", colorB: "#f13d76", tip: "#ffd4b0", size: 0.9 },
    ];

    const budPositions = [];
    const bloomPositions = [];
    const colors = [];
    const sizes = [];
    const seeds = [];
    const sparks = [];
    const tmpColor = new THREE.Color();
    const baseColor = new THREE.Color();
    const midColor = new THREE.Color();
    const tipColor = new THREE.Color();

    const addParticle = (bud, bloom, color, size, seed, spark) => {
      budPositions.push(bud.x, bud.y, bud.z);
      bloomPositions.push(bloom.x, bloom.y, bloom.z);
      colors.push(color.r, color.g, color.b);
      sizes.push(size);
      seeds.push(seed);
      sparks.push(spark);
    };

    configs.forEach((config) => {
      baseColor.set(config.colorA);
      midColor.set(config.colorB);
      tipColor.set(config.tip);
      const petalCount = Math.max(1, Math.round(config.count * quality / config.petals));

      for (let petal = 0; petal < config.petals; petal += 1) {
        const baseAngle = (petal / config.petals) * TAU + config.offset + (Math.random() - 0.5) * 0.035;
        const petalRandom = Math.random();

        for (let index = 0; index < petalCount; index += 1) {
          const u = Math.pow(Math.random(), 0.62);
          const across = Math.random() * 2 - 1;
          const edge = Math.pow(Math.sin(Math.PI * u), 0.68);
          const width = config.width * edge * (0.82 + Math.random() * 0.22);
          const localX = across * width;
          const localY = 0.045 + u * config.length * (0.92 + petalRandom * 0.13);
          const angle = baseAngle + (Math.random() - 0.5) * 0.025;
          const cos = Math.cos(angle);
          const sin = Math.sin(angle);

          const bloomX = cos * localY - sin * localX;
          const bloomY = sin * localY + cos * localX;
          const cup = Math.sin(u * Math.PI) * 0.16 * (1 - Math.abs(across) * 0.35);
          const bloomZ = 0.06 + config.layer * 0.045 + cup + across * 0.045 + (Math.random() - 0.5) * 0.045;

          const wrap = baseAngle * 0.78 + u * (2.15 + config.layer * 0.16) + across * 0.32;
          const budRadius = 0.115 + u * 0.125;
          const budX = Math.cos(wrap) * budRadius * 0.78 + localX * 0.055;
          const budY = -0.37 + u * 0.92 + across * 0.035;
          const budZ = 0.08 + Math.sin(wrap) * budRadius * 0.7 + Math.sin(u * Math.PI * 1.6) * 0.035;

          const colorMix = 0.17 + Math.pow(u, 1.75) * 0.62 + Math.random() * 0.12;
          if (colorMix < 0.56) {
            tmpColor.copy(baseColor).lerp(midColor, colorMix / 0.56);
          } else {
            tmpColor.copy(midColor).lerp(tipColor, (colorMix - 0.56) / 0.44);
          }
          if (Math.abs(across) > 0.9 && u > 0.5) tmpColor.lerp(tipColor, 0.24);

          const spark = Math.random() < 0.012 ? 1 : 0;
          const size = (0.58 + Math.random() * 0.8) * config.size * (spark ? 1.85 : 1);

          addParticle(
            { x: budX, y: budY, z: budZ },
            { x: bloomX, y: bloomY, z: bloomZ },
            tmpColor,
            size,
            Math.random(),
            spark,
          );
        }
      }
    });

    const coreCount = Math.round(1750 * quality);
    const goldA = new THREE.Color("#ad3a25");
    const goldB = new THREE.Color("#ffac56");
    const goldC = new THREE.Color("#fff0b0");

    for (let index = 0; index < coreCount; index += 1) {
      const theta = Math.random() * TAU;
      const radius = Math.sqrt(Math.random()) * 0.55;
      const colorT = Math.random();
      if (colorT < 0.55) tmpColor.copy(goldA).lerp(goldB, colorT / 0.55);
      else tmpColor.copy(goldB).lerp(goldC, (colorT - 0.55) / 0.45);

      addParticle(
        {
          x: Math.cos(theta) * radius * 0.82,
          y: Math.sin(theta) * radius * 0.72,
          z: 0.02 + (Math.random() - 0.5) * 0.28,
        },
        {
          x: Math.cos(theta) * radius * 0.75,
          y: Math.sin(theta) * radius * 0.6,
          z: 0.25 + Math.random() * 0.22,
        },
        tmpColor,
        0.68 + Math.random() * 0.9,
        Math.random(),
        Math.random() < 0.22 ? 1 : 0,
      );
    }

    const pollenCount = Math.round(460 * quality);
    for (let index = 0; index < pollenCount; index += 1) {
      const theta = Math.random() * TAU;
      const radius = 0.16 + Math.pow(Math.random(), 0.55) * 0.95;
      const budRadius = 0.12 + Math.random() * 0.16;
      tmpColor.copy(goldB).lerp(goldC, Math.random() * 0.82);

      addParticle(
        {
          x: Math.cos(theta) * budRadius,
          y: -0.1 + Math.sin(theta) * budRadius + Math.random() * 0.45,
          z: 0.12 + Math.random() * 0.16,
        },
        {
          x: Math.cos(theta) * radius,
          y: Math.sin(theta) * radius * 0.75,
          z: 0.3 + Math.random() * 0.38,
        },
        tmpColor,
        0.6 + Math.random() * 1.45,
        Math.random(),
        1,
      );
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(budPositions, 3));
    geometry.setAttribute("aBloomPosition", new THREE.Float32BufferAttribute(bloomPositions, 3));
    geometry.setAttribute("aColor", new THREE.Float32BufferAttribute(colors, 3));
    geometry.setAttribute("aSize", new THREE.Float32BufferAttribute(sizes, 1));
    geometry.setAttribute("aSeed", new THREE.Float32BufferAttribute(seeds, 1));
    geometry.setAttribute("aSpark", new THREE.Float32BufferAttribute(sparks, 1));
    geometry.computeBoundingSphere();

    this.flowerUniforms = {
      uTime: { value: 0 },
      uBloom: { value: state.bloom },
      uPixelRatio: { value: this.pixelRatio },
      uPointer: { value: new THREE.Vector2(0.2, 0) },
      uPointerStrength: { value: 0 },
    };

    const material = new THREE.ShaderMaterial({
      uniforms: this.flowerUniforms,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      vertexShader: `
        uniform float uTime;
        uniform float uBloom;
        uniform float uPixelRatio;
        uniform vec2 uPointer;
        uniform float uPointerStrength;

        attribute vec3 aBloomPosition;
        attribute vec3 aColor;
        attribute float aSize;
        attribute float aSeed;
        attribute float aSpark;

        varying vec3 vColor;
        varying float vAlpha;
        varying float vSpark;

        void main() {
          float bloom = clamp(uBloom, 0.0, 1.0);
          float delayed = clamp((bloom - aSeed * 0.2) / 0.8, 0.0, 1.0);
          float morph = delayed * delayed * (3.0 - 2.0 * delayed);
          vec3 pos = mix(position, aBloomPosition, morph);

          float flutter = sin(uTime * 0.78 + aSeed * 31.0);
          pos.x += cos(uTime * 0.52 + aSeed * 19.0) * 0.012;
          pos.y += flutter * (0.009 + morph * 0.012);
          pos.z += sin(uTime * 0.91 + aSeed * 13.0) * 0.008;

          float pointerDistance = length(pos.xy - uPointer);
          float pointerField = exp(-pointerDistance * 1.05) * uPointerStrength;
          vec2 away = normalize(pos.xy - uPointer + vec2(0.0001));
          pos.xy += away * pointerField * (0.035 + 0.02 * sin(uTime * 1.8 + aSeed * 7.0));

          vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
          gl_Position = projectionMatrix * mvPosition;

          float sizePulse = 0.92 + 0.08 * flutter;
          gl_PointSize = aSize * uPixelRatio * (31.0 / max(2.0, -mvPosition.z)) * sizePulse;
          gl_PointSize *= mix(0.72, 1.0, morph);
          gl_PointSize *= 1.0 + aSpark * 1.2;

          vColor = aColor * mix(vec3(0.48, 0.35, 0.4), vec3(1.0), morph);
          vColor += aSpark * vec3(0.22, 0.12, 0.045);
          vAlpha = mix(0.42, 0.92, morph) * (0.82 + 0.18 * flutter);
          vSpark = aSpark;
        }
      `,
      fragmentShader: `
        varying vec3 vColor;
        varying float vAlpha;
        varying float vSpark;

        void main() {
          vec2 centered = gl_PointCoord - vec2(0.5);
          float radius = length(centered) * 2.0;
          if (radius > 1.0) discard;

          float softEdge = pow(max(0.0, 1.0 - radius), 1.7);
          float core = smoothstep(0.42, 0.0, radius);
          vec3 color = vColor * (0.9 + core * 1.25 + vSpark * 0.18);
          float alpha = vAlpha * (softEdge * 0.62 + core * 0.72);
          gl_FragColor = vec4(color, alpha);
        }
      `,
    });

    this.flowerPoints = new THREE.Points(geometry, material);
    this.flowerPoints.frustumCulled = false;
    this.flowerGroup.add(this.flowerPoints);
  }
  createDust() {
    const count = window.innerWidth < 760 ? 440 : 900;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    const seeds = new Float32Array(count);
    const palette = ["#ffd3b5", "#f7ead7", "#ff8da8", "#b5c7a1"].map((color) => new THREE.Color(color));

    for (let index = 0; index < count; index += 1) {
      const i3 = index * 3;
      positions[i3] = (Math.random() - 0.5) * 18;
      positions[i3 + 1] = (Math.random() - 0.5) * 10;
      positions[i3 + 2] = -5.5 + Math.random() * 7.5;
      const color = palette[Math.floor(Math.random() * palette.length)];
      colors[i3] = color.r;
      colors[i3 + 1] = color.g;
      colors[i3 + 2] = color.b;
      sizes[index] = 0.28 + Math.random() * 1.05;
      seeds[index] = Math.random();
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("aColor", new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));

    this.dustUniforms = {
      uTime: { value: 0 },
      uPixelRatio: { value: this.pixelRatio },
      uBloom: { value: state.bloom },
    };

    const material = new THREE.ShaderMaterial({
      uniforms: this.dustUniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: `
        uniform float uTime;
        uniform float uPixelRatio;
        uniform float uBloom;
        attribute vec3 aColor;
        attribute float aSize;
        attribute float aSeed;
        varying vec3 vColor;
        varying float vAlpha;

        void main() {
          vec3 pos = position;
          pos.x += sin(uTime * 0.15 + aSeed * 29.0) * 0.16;
          pos.y += sin(uTime * 0.2 + aSeed * 41.0) * 0.12;
          vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          gl_PointSize = aSize * uPixelRatio * (18.0 / max(2.0, -mvPosition.z));
          gl_PointSize *= 0.75 + uBloom * 0.35;
          vColor = aColor;
          vAlpha = 0.18 + 0.5 * (0.5 + 0.5 * sin(uTime * 0.8 + aSeed * 53.0));
        }
      `,
      fragmentShader: `
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          float radius = length(gl_PointCoord - vec2(0.5)) * 2.0;
          if (radius > 1.0) discard;
          float alpha = pow(1.0 - radius, 2.2) * vAlpha;
          gl_FragColor = vec4(vColor, alpha);
        }
      `,
    });

    this.dust = new THREE.Points(geometry, material);
    this.root.add(this.dust);
  }

  createBotanicalGeometry() {
    const stemMaterial = new THREE.MeshBasicMaterial({
      color: 0x8da083,
      transparent: true,
      opacity: 0.16,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const stemGroup = new THREE.Group();

    const stems = [
      [
        new THREE.Vector3(-1.55, -2.85, -0.75),
        new THREE.Vector3(-1.9, -1.45, -0.55),
        new THREE.Vector3(-0.85, -0.2, -0.35),
        new THREE.Vector3(-0.28, 0.35, -0.25),
      ],
      [
        new THREE.Vector3(-0.65, -3.15, -0.95),
        new THREE.Vector3(-0.2, -1.75, -0.7),
        new THREE.Vector3(0.52, -0.62, -0.42),
        new THREE.Vector3(0.34, 0.2, -0.22),
      ],
      [
        new THREE.Vector3(1.15, -2.9, -0.8),
        new THREE.Vector3(0.82, -1.5, -0.6),
        new THREE.Vector3(1.22, -0.3, -0.35),
        new THREE.Vector3(0.88, 0.38, -0.25),
      ],
    ];

    stems.forEach((points, index) => {
      const curve = new THREE.CatmullRomCurve3(points);
      const geometry = new THREE.TubeGeometry(curve, 72, index === 1 ? 0.006 : 0.004, 3, false);
      stemGroup.add(new THREE.Mesh(geometry, stemMaterial));
    });

    const ringMaterial = new THREE.MeshBasicMaterial({
      color: 0xff9aa8,
      transparent: true,
      opacity: 0.12,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.ringA = new THREE.Mesh(new THREE.TorusGeometry(2.05, 0.0035, 3, 220), ringMaterial);
    this.ringA.rotation.set(1.08, 0.2, -0.12);
    this.ringA.position.z = -0.45;

    const ringMaterialB = ringMaterial.clone();
    ringMaterialB.color.set(0xffc98c);
    ringMaterialB.opacity = 0.1;
    this.ringB = new THREE.Mesh(new THREE.TorusGeometry(2.42, 0.0025, 3, 220), ringMaterialB);
    this.ringB.rotation.set(0.72, -0.45, 0.56);
    this.ringB.position.z = -0.6;

    this.flowerGroup.add(stemGroup, this.ringA, this.ringB);
  }

  resize() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.camera.aspect = width / Math.max(height, 1);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);

    const compact = width < 760;
    const tablet = width < 1180;
    this.baseX = compact ? 0.02 : tablet ? 1.35 : 2.14;
    this.baseY = compact ? 0.68 : tablet ? 0.2 : 0.13;
    this.baseScale = compact ? 0.64 : tablet ? 0.79 : 0.96;
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, compact ? 1.45 : 1.8);
    this.renderer.setPixelRatio(this.pixelRatio);

    if (this.flowerUniforms) this.flowerUniforms.uPixelRatio.value = this.pixelRatio;
    if (this.dustUniforms) this.dustUniforms.uPixelRatio.value = this.pixelRatio;
  }

  animate(delta, time) {
    this.pointerSmooth.lerp(state.pointer, 1 - Math.exp(-3.4 * delta));
    const bloom = state.bloom;
    const strength = state.pointerStrength;

    this.flowerUniforms.uTime.value = time;
    this.flowerUniforms.uBloom.value = bloom;
    this.flowerUniforms.uPointerStrength.value = strength;
    this.flowerUniforms.uPointer.value.set(this.pointerSmooth.x * 2.8, this.pointerSmooth.y * 1.9);

    this.dustUniforms.uTime.value = time;
    this.dustUniforms.uBloom.value = bloom;

    const targetX = this.baseX + this.pointerSmooth.x * 0.28;
    const targetY = this.baseY + this.pointerSmooth.y * 0.17;
    this.flowerGroup.position.x = damp(this.flowerGroup.position.x, targetX, 4.2, delta);
    this.flowerGroup.position.y = damp(this.flowerGroup.position.y, targetY, 4.2, delta);
    this.flowerGroup.rotation.x = damp(this.flowerGroup.rotation.x, -this.pointerSmooth.y * 0.055, 3.0, delta);
    this.flowerGroup.rotation.y = damp(this.flowerGroup.rotation.y, 0.1 + this.pointerSmooth.x * 0.085, 3.0, delta);
    this.flowerGroup.rotation.z = -0.055 + Math.sin(time * 0.17) * 0.018;

    const scale = this.baseScale * (0.93 + bloom * 0.075);
    this.flowerGroup.scale.setScalar(damp(this.flowerGroup.scale.x, scale, 3.5, delta));

    this.ringA.rotation.z += delta * 0.022;
    this.ringB.rotation.y -= delta * 0.016;
    this.dust.rotation.z = Math.sin(time * 0.05) * 0.035;
    this.renderer.render(this.scene, this.camera);
  }
}

function mapDemoPointer(event) {
  state.pointer.x = clamp((event.clientX / window.innerWidth - 0.5) * 2, -1, 1);
  state.pointer.y = clamp((0.5 - event.clientY / window.innerHeight) * 2, -1, 1);
}
async function initializeHandLandmarker() {
  if (state.landmarker) return state.landmarker;
  if (visionPromise) return visionPromise;

  visionPromise = (async () => {
    const wasmPath = new URL("./vendor/wasm/", window.location.href).href;
    const modelPath = new URL("./models/hand_landmarker.task", window.location.href).href;
    const vision = await FilesetResolver.forVisionTasks(wasmPath);
    const options = {
      baseOptions: { modelAssetPath: modelPath, delegate: "GPU" },
      runningMode: "VIDEO",
      numHands: 1,
      minHandDetectionConfidence: 0.55,
      minHandPresenceConfidence: 0.55,
      minTrackingConfidence: 0.55,
    };

    try {
      state.landmarker = await HandLandmarker.createFromOptions(vision, options);
    } catch (gpuError) {
      console.warn("GPU delegate unavailable, falling back to CPU.", gpuError);
      state.landmarker = await HandLandmarker.createFromOptions(vision, {
        ...options,
        baseOptions: { ...options.baseOptions, delegate: "CPU" },
      });
    }

    state.visionReady = true;
    return state.landmarker;
  })();

  visionPromise = visionPromise.catch((error) => {
    visionPromise = null;
    throw error;
  });
  return visionPromise;
}

async function requestCameraStream() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("当前浏览器不支持摄像头访问");
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: "user",
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30, max: 30 },
    },
  });

  dom.cameraVideo.srcObject = stream;
  await dom.cameraVideo.play();
  return stream;
}

function markHandLost() {
  if (!state.handDetected) return;
  state.handDetected = false;
  state.fingerCount = 0;
  state.gestureState = "searching";
  state.targetBloom = 0.19;
  dom.trackingLabel.textContent = "SCANNING";
  dom.fingerCount.textContent = "00 / 05 FINGERS";
  setSessionStatus("SCANNING", "loading");
  drawHandOverlay(null);
}

function processHandResults(results, now) {
  const landmarks = results?.landmarks?.[0];
  if (!landmarks || landmarks.length < 21) {
    if (now - state.lastHandAt > 170) markHandLost();
    return;
  }

  const hand = normalizeHandLandmarks(landmarks);
  state.handDetected = true;
  state.lastHandAt = now;
  state.fingerCount = hand.count;
  state.gestureState = hand.gestureState;
  state.targetBloom = hand.targetBloom;
  state.pointer.x = damp(state.pointer.x, hand.pointerX, 0.34, 1);
  state.pointer.y = damp(state.pointer.y, hand.pointerY, 0.34, 1);
  dom.trackingLabel.textContent = "HAND LOCKED";
  dom.fingerCount.textContent = `${String(hand.count).padStart(2, "0")} / 05 FINGERS`;
  setSessionStatus("HAND LOCKED");
  drawHandOverlay(landmarks);
}

function detectionLoop(now) {
  if (!state.cameraActive || !state.landmarker) return;

  const video = dom.cameraVideo;
  if (video.readyState >= 2 && video.currentTime !== state.lastVideoTime) {
    state.lastVideoTime = video.currentTime;
    try {
      const results = state.landmarker.detectForVideo(video, now);
      processHandResults(results, now);
    } catch (error) {
      console.error("Hand tracking error:", error);
      showToast("手部追踪暂时中断，请检查浏览器硬件加速后刷新。", 6500);
      markHandLost();
    }
  }

  detectionFrame = requestAnimationFrame(detectionLoop);
}

function stopCamera() {
  state.cameraActive = false;
  cancelAnimationFrame(detectionFrame);
  if (state.mediaStream) {
    state.mediaStream.getTracks().forEach((track) => track.stop());
    state.mediaStream = null;
  }
  dom.cameraVideo.srcObject = null;
  dom.cameraCard.classList.remove("is-live");
}

async function startCamera() {
  if (state.cameraStarting) return;
  state.cameraStarting = true;
  dom.startCameraButton.disabled = true;
  dom.startDemoButton.disabled = true;
  dom.startCameraButton.querySelector("span").textContent = "正在连接镜头";
  setBootStatus("正在加载 21 点手部模型并请求摄像头权限…");
  setSessionStatus("CALIBRATING", "loading");

  try {
    const [landmarker, stream] = await Promise.all([
      initializeHandLandmarker(),
      requestCameraStream(),
    ]);

    state.landmarker = landmarker;
    state.mediaStream = stream;
    state.cameraActive = true;
    state.lastVideoTime = -1;
    state.mode = "camera";
    dom.cameraCard.classList.remove("is-demo");
    dom.cameraCard.classList.add("is-live");
    dom.cameraAction.textContent = "摄像头已连接";
    dom.trackingLabel.textContent = "SCANNING";
    dom.fingerCount.textContent = "00 / 05 FINGERS";
    dom.inputMode.textContent = "LIVE / 21 PT";
    setSessionStatus("SCANNING", "loading");
    finishBoot("camera");
    setBootStatus("手部识别已就绪");
    showToast("把手放进画面，握拳收拢花苞，张开手掌让花绽放。", 5600);
    detectionFrame = requestAnimationFrame(detectionLoop);
  } catch (error) {
    console.error("Unable to start camera mode:", error);
    const pendingStream = dom.cameraVideo.srcObject;
    pendingStream?.getTracks?.().forEach((track) => track.stop());
    dom.cameraVideo.srcObject = null;
    const secureHint = !window.isSecureContext && window.location.hostname !== "localhost"
      ? "摄像头需要 localhost 或 HTTPS 环境。"
      : "请允许摄像头权限，或检查设备是否可用。";
    startDemo(`${secureHint} 已切换到无摄像头演示。`);
  } finally {
    state.cameraStarting = false;
    dom.startCameraButton.disabled = false;
    dom.startDemoButton.disabled = false;
    dom.startCameraButton.querySelector("span").textContent = "开启手势识别";
  }
}

function startDemo(message = "") {
  stopCamera();
  state.mode = "demo";
  state.targetBloom = 0.62;
  state.pointerStrength = 0.36;
  dom.cameraCard.classList.add("is-demo");
  dom.trackingLabel.textContent = "DEMO SIGNAL";
  dom.fingerCount.textContent = "SYNTH / 05 FINGERS";
  dom.cameraAction.textContent = "启用摄像头";
  dom.inputMode.textContent = "DEMO SIGNAL";
  dom.interactionGuide.innerHTML = `
    <div><kbd>移动光标</kbd><span>牵引花朵 · MOVE</span></div>
    <i aria-hidden="true"></i>
    <div><kbd>按住 / 空格</kbd><span>让它绽放 · BLOOM</span></div>
  `;
  setSessionStatus("DEMO SIGNAL", "demo");
  finishBoot("demo");
  if (message) showToast(message, 6200);
}

function bootExperience() {
  try {
    flowerScene = new FlowerExperience(dom.canvas);
  } catch (error) {
    console.error("WebGL initialization failed:", error);
    setBootStatus("无法创建 WebGL 场景，请确认浏览器已启用硬件加速。", true);
  }

  if (!window.isSecureContext && window.location.hostname !== "localhost") {
    setBootStatus("提示：摄像头仅在 localhost 或 HTTPS 下可用，也可进入演示模式。", true);
  } else {
    setBootStatus("粒子花园已就绪 · 点击开启互动");
  }

  dom.startCameraButton.addEventListener("click", startCamera);
  dom.startDemoButton.addEventListener("click", () => startDemo("演示模式：移动光标，按住鼠标或空格让花朵绽放。"));
  dom.cameraAction.addEventListener("click", startCamera);

  window.addEventListener("resize", () => {
    flowerScene?.resize();
    drawHandOverlay(null);
  });

  window.addEventListener("pointermove", (event) => {
    if (state.mode === "idle" || state.mode === "demo") mapDemoPointer(event);
  });

  window.addEventListener("pointerdown", (event) => {
    if (state.mode === "demo") {
      state.demoPressed = true;
      mapDemoPointer(event);
    }
  });

  window.addEventListener("pointerup", () => {
    state.demoPressed = false;
  });

  window.addEventListener("pointercancel", () => {
    state.demoPressed = false;
  });

  window.addEventListener("keydown", (event) => {
    if (event.code === "Space" && state.awake && (state.mode === "demo" || state.mode === "idle")) {
      event.preventDefault();
      state.demoPinned = !state.demoPinned;
      showToast(state.demoPinned ? "花朵正在盛放。" : "花朵正在收拢。", 1800);
    }
  });

  const clock = new THREE.Clock();
  const animate = () => {
    requestAnimationFrame(animate);
    const delta = Math.min(clock.getDelta(), 0.05);
    const time = clock.elapsedTime;

    if (state.mode === "idle") {
      state.targetBloom = 0.56 + Math.sin(time * 0.8) * 0.15;
      state.pointerStrength = damp(state.pointerStrength, 0.18, 2.2, delta);
    } else if (state.mode === "demo") {
      const breathing = 0.5 + Math.sin(time * 0.78) * 0.3;
      state.targetBloom = state.demoPressed || state.demoPinned ? 1 : 0.48 + breathing * 0.25;
      state.pointerStrength = damp(state.pointerStrength, state.demoPressed ? 1 : 0.48, 2.8, delta);
    } else if (state.mode === "camera") {
      if (state.handDetected) {
        state.pointerStrength = damp(state.pointerStrength, 0.88, 3.3, delta);
        if (performance.now() - state.lastHandAt > 400) markHandLost();
      } else {
        state.pointerStrength = damp(state.pointerStrength, 0, 2.8, delta);
        state.targetBloom = damp(state.targetBloom, 0.14, 1.8, delta);
      }
    }

    state.bloom = damp(state.bloom, state.targetBloom, state.mode === "camera" ? 5.2 : 3.2, delta);
    flowerScene?.animate(delta, time);

    if (performance.now() - state.lastUiUpdate > 54) {
      setGestureUi();
      state.lastUiUpdate = performance.now();
    }
  };

  animate();

  window.__GESTURE_BLOOM__ = {
    state,
    startDemo,
    startCamera,
    analyzeHand: normalizeHandLandmarks,
    processHandResults,
    get scene() { return flowerScene; },
  };
}

bootExperience();



