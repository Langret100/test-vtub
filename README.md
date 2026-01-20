# VTuber Chat Demo (Three.js + VRM)

## 실행
- 로컬에서: VSCode Live Server 같은 정적 서버로 `vtuber_chat_site/` 폴더를 열어 실행하세요.
- GitHub Pages: 이 폴더 내용을 그대로 Pages에 올리면 됩니다.

> 브라우저가 **Web Speech API(TTS)** 를 지원해야 음성이 나옵니다.

## GitHub Pages에서 캐릭터가 안 뜨고 채팅이 안 먹는 경우
콘솔에 아래와 비슷한 에러가 나오면:

```
Failed to resolve module specifier "three"
```

원인은 **three-vrm이 내부적으로 `three`를 bare import로 가져오는데, 브라우저가 그 경로를 모르는 것**입니다.
이 프로젝트는 `index.html`에 importmap을 포함해 해결해둔 버전입니다.
만약 파일을 일부만 복사해 갔다면 `index.html`의 importmap 부분이 함께 올라갔는지 확인하세요.

## “보이스 파일만으로 의미 없나?”
맞아요. **TTS는 (1) 글→음성으로 바꾸는 ‘추론 엔진’ + (2) 목소리(보이스/스피커/모델 데이터)** 가 함께 있어야 소리가 납니다.
- OS/브라우저 내장 음성 사용: 이 데모처럼 간단하고 가벼움
- 모델을 웹에 내장(ONNX/WASM 등): GitHub Pages에서도 가능하지만 모델 파일(수십 MB)과 실행 코드가 추가로 필요

## 아바타
- `assets/Base_Female.vrm`
- 출처: VRoid Studio 샘플 모델(여성) / CC0

## 라이선스/출처(요약)
- Avatar: VRoid Studio sample models are CC0 (copyright waived).
- This demo uses Three.js and @pixiv/three-vrm via CDN.

