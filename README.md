# 指尖绽放 · Gesture Bloom

一个由手势控制的实时粒子花朵。摄像头识别到 21 个手部关键点后：

- **握拳**：花瓣粒子收拢为花苞
- **张开手掌**：花瓣向四周层层绽放
- **移动手掌**：花朵产生轻微位移、视差和局部粒子排斥
- 无摄像头时也可使用鼠标 / 空格键体验演示模式

视觉层使用 Three.js 自定义 GLSL 点精灵着色器；手部识别使用 MediaPipe Tasks Vision 的 `HandLandmarker`，输出标准 21 点手部骨架，并完全在本机处理视频帧。

## 启动

项目不依赖 CDN，Three.js、MediaPipe WASM 和手部模型均已放在 `vendor/` 与 `models/` 中。

```bash
cd outputs
npm start
```

打开：`http://localhost:4173`

也可以使用 Python：

```bash
cd outputs
python -m http.server 8080
```

打开：`http://localhost:8080`

> 摄像头 API 只会在 `localhost` 或 HTTPS 页面中开放。直接双击 `index.html` 使用 `file://` 协议无法启用摄像头，但可以进入演示模式。

## 使用

1. 点击「开启手势识别」并允许浏览器摄像头权限。
2. 将一只手完整放入右下角预览框。
3. 握拳收拢花苞，张开手掌使其绽放。
4. 点击「无摄像头体验」可用鼠标移动花朵，按住鼠标或空格键让其绽放。

## 文件结构

```text
outputs/
├── index.html          # 页面结构与交互提示
├── styles.css          # 响应式视觉系统、摄像头面板与动效
├── app.js              # Three.js 粒子花朵、GLSL、手势逻辑
├── server.mjs          # 零依赖本地静态服务器
├── package.json
├── models/
│   └── hand_landmarker.task
└── vendor/
    ├── three.module.min.js
    ├── vision_bundle.mjs
    └── wasm/           # MediaPipe Tasks Vision WASM
```

## 可调参数

- 花瓣层数、粒子数量、颜色和形状：`app.js` 中的 `createFlower()`
- 绽放阻尼和手势映射：`normalizeHandLandmarks()` 与主循环中的 `damp(...)`
- 花朵基准位置/缩放：`FlowerExperience.resize()`
- 摄像头预览尺寸和摄像样式：`styles.css` 中的 `.camera-card`

## 浏览器建议

Chrome / Edge 最新版。建议开启硬件加速；如果设备无法使用 GPU delegate，程序会自动回退至 CPU 推理。

Three.js 版本：0.170.0（MIT，见 `vendor/THREE-LICENSE.txt`）。MediaPipe Tasks Vision：0.10.22-rc.20250304。

