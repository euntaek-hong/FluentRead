# FluentRead 开发规则

## 项目定位

- FluentRead 是主要开发目标：一款提供全文双语翻译、划词翻译和多翻译服务支持的浏览器扩展。
- 上级工作区仅用于参考。需求未指名其他项目时，一律在本项目实现。

## 技术基线

- 保持现有技术栈：WXT 0.20、Vue 3、TypeScript、Element Plus 和 pnpm 9。当前锁文件实际使用 WXT 0.20.18；未经明确升级任务，不按新版文档擅自使用仅在更高版本存在的 API。
- 遵循 [架构设计](docs/architecture.md) 的单向模块边界：
  - `entrypoints/`：WXT 文件式入口，只绑定生命周期并组装 `src/app`。
  - `src/app/`：background/content/popup/options/document/offscreen 的静态 composition root；`userscript/` 是独立发布出口。
  - `src/features/`：全文、悬浮、划词、输入框、词书、图片、区域、文档和视频等纵向业务。
  - `src/core/`：翻译候选、快捷键、OCR 等无浏览器副作用的纯算法。
  - `src/services/`：翻译、缓存、配置等跨 feature 编排。
  - `src/providers/` 与 `src/platform/`：供应商适配和浏览器/存储/HTTP/offscreen 边界。
  - `src/shared/` 与 `src/ui/`：无业务语义的小型工具和复用 UI/token。
- 已删除旧 `entrypoints/utils/` 兼容层；生产代码和测试必须直接使用 `src` 公共路径，不得重新创建入口工具目录或兼容壳。
- 新功能应复用现有配置、消息、翻译服务和挂载机制，避免另建一套并行状态或通信体系。
- 内容脚本运行在任意网页中。新增 DOM、样式和事件时使用 FluentRead 专属命名，避免污染宿主页面；卸载、关闭或页面离开时清理监听器、计时器、观察器、挂载节点和未完成请求。
- 浏览器 API 优先使用项目现有的 `browser`/webextension-polyfill 方式，并同时考虑 Chrome、Edge 和 Firefox 的行为差异。
- API 密钥、令牌和用户配置只能按现有本地存储方案处理，不写入日志、源码、测试夹具或提交内容。

## WXT 官方依据

- WXT 是 FluentRead 的浏览器扩展开发框架。涉及入口、manifest、构建、浏览器目标、内容脚本、后台脚本、扩展 UI、存储、消息通信或 WXT 配置时，优先查阅官方资料：
  - 官网与文档：<https://wxt.dev/>
  - WXT API 参考：<https://wxt.dev/api/reference/wxt/>
  - 官方示例：<https://wxt.dev/examples.html>
  - 安装与入门指南：<https://wxt.dev/guide/installation.html>
  - 官方源码：<https://github.com/wxt-dev/wxt>
- 官方文档和源码是 WXT 行为的权威依据；参考项目、博客、搜索结果和既有印象只能作为补充。
- 使用官方文档前先核对 FluentRead 锁定的 WXT 版本。若当前文档描述的是更高版本，应查对应版本的源码、类型定义或变更记录，不能假设 API 向下兼容。
- 遵循 WXT 的文件式入口和构建约定，优先使用 WXT 提供的 `defineBackground`、`defineContentScript`、配置、manifest 与跨浏览器构建能力，不重复搭建框架已经提供的基础设施。
- 新增入口或浏览器能力时，同时检查生成的 manifest、所需权限、Chrome/Edge/Firefox 差异，以及 MV2/MV3 生命周期差异。

## 实现原则

- `src/` 下每个 TypeScript、Vue、CSS 与 Markdown 文件必须从第一个字符开始书写中文长注释，明确 `@file` 路径、文件职责、主要内容和模块边界；职责变化时同步更新，不得复制空泛模板。
- 修复问题时处理根因，并覆盖翻译、恢复原文、重复触发、动态 DOM、页面卸载和失败重试等相关状态。
- 引入新的翻译服务时放入 `src/providers/translation/`，通过 provider registry 与 `src/services/translation` 接入；补齐配置可见性、错误处理和调用路径，不在 UI 组件中直接散落网络请求。
- 从参考项目借鉴功能时，将概念适配为 Vue/TypeScript 实现；不要引入 React 专用依赖或跨仓库运行时耦合。
- 控制改动范围，不顺手重写无关代码；除非任务需要，不升级依赖或改变构建工具。
- 用户可见行为变化同步更新相关文档；版本号和发布产物仅在用户明确要求发布时修改。

## 验证

- 测试分组、覆盖率定义和一键回归以 [测试与回归](docs/testing.md) 为准。
- 使用 `pnpm test:audit` 检查测试唯一归类、重复用例、`.only`、无说明 `.skip` 和覆盖率忽略。
- 按改动选择 `pnpm test:architecture`、`pnpm test:unit`、`pnpm test:functional`、`pnpm test:regression`。
- 迁入 `src` 的可执行业务模块使用 `pnpm test:coverage`，statements/branches/functions/lines 四维均须 100%。
- 使用 `pnpm compile` 做 TypeScript/Vue 类型检查。
- 涉及扩展构建或入口行为时同时运行 `pnpm build` 与 `pnpm build:firefox`；共享翻译或平台代码还要运行 `pnpm build:userscript` 和 userscript verifier。
- 涉及文档时运行 `pnpm docs:build`。
- `pnpm test:regression:all` 执行确定性的一键回归。真实浏览器层必须显式开启，使用临时 profile、独立 Win32 desktop object 中的 headful 窗口；不得连接用户日常 profile、切换用户 desktop、最小化窗口或调用 `bringToFront()`。
- 自动化按键名称使用标准 `Control`，不要使用 `CTRL`；浏览器报告必须说明 launch mode、focus policy、window placement、执行范围与证据目录。
- 不把参考项目自身的测试通过视为 FluentRead 的验证结果。

## 개인 Firefox fork 운영

- 이 fork의 개인 사용 대상은 Firefox입니다. Windows 빌드 호환 패치와 개인 패키징을 유지합니다. 번역 성능은 Trancy와 같은 조건으로 비교하고, 측정으로 확인한 병목만 수정합니다. 기본 `viewport`와 기존 `all` 의미를 유지합니다. 공유 코드 변경은 Chrome/Firefox/userscript 빌드도 검사합니다. 웹사이트 문서 빌드는 웹사이트를 변경한 경우에만 요구합니다.
- `origin`은 `euntaek-hong/FluentRead`, `upstream`은 `FluentRead/FluentRead`입니다. `main`은 업스트림을 따라가고 개인 수정은 `codex/firefox-local`에서 관리합니다. 업스트림 PR이나 정기 자동 업데이트는 만들지 않습니다.
- 프로젝트 명령은 `npx --yes pnpm@9.12.1 <명령>`으로 실행할 수 있습니다. pnpm 전역 설치나 의존성 업그레이드는 필요하지 않습니다.
- 브라우저와 GUI 자동화는 기존 실행기를 재사용해 별도 Win32 desktop object에서 실행합니다. 그 안에서 브라우저는 `headful`을 유지합니다. 숨기기 위해 `headless`로 변경하지 않습니다. 사용자 desktop으로 전환하지 않습니다. 사용자 화면과 작업 표시줄에 자동화 창이 나타나거나 깜빡이지 않게 합니다. 포커스를 가져오지 않습니다. CDP/Marionette로 페이지를 조작하며 전역 키보드 입력은 사용하지 않습니다.
- Windows 확장 전용 설치에서 문서용 이미지 바이너리 설치가 실패하면 `install --frozen-lockfile --ignore-scripts`를 사용합니다. 이후 `node node_modules/esbuild/install.js`와 `exec wxt prepare`를 실행합니다. TLS 검사를 완화하지 않습니다.

### 업데이트 요청 시 체크리스트

1. `git status --short`로 사용자 변경을 확인합니다. 작업 내용을 덮어쓰지 않고 `git fetch upstream`을 실행합니다.
2. `scripts/firefox/maintenance.json`의 마지막 업스트림 커밋 이후 변경을 확인합니다. 검사 대상은 아래 동작입니다. 단순 문자열 검색으로 해결 여부를 판단하지 않습니다.
   - `scripts/testing/run-resource-safe.mjs`: Windows에서 `shell:false`로 로컬 Node CLI를 실행해야 합니다. `wxt`, `vitest`, `vue-tsc`가 성공해야 하고 인수와 종료 코드가 보존되어야 합니다.
   - `wxt.config.ts`의 `build:publicAssets`: WXT가 `/` 또는 `\\` 구분자로 제공하는 OCR core/worker를 모두 찾아야 합니다. 실제 리소스가 없으면 오류를 유지해야 합니다.
   - `userscript/vite.config.ts`: Windows 경로에서도 중국어 catalog 압축 대상과 TypeScript checker의 browser/chrome lexical binding을 정확하게 판별해야 합니다. personal correction 모듈의 격리 경계도 유지해야 합니다. `userscriptViteConfig.test.ts`와 userscript 빌드 verifier로 검사합니다. 이 호환 패치는 확장 빌드 공유 검증 과정에서 추가로 발견했습니다.
3. 업스트림에서 해결된 패치는 회귀 테스트로 확인한 후 개인 브랜치에서 제거합니다. 기존 CLI와 OCR 패치 제목은 `fix: execute local Node CLIs directly on Windows`, `fix: normalize OCR public asset paths on Windows`입니다. userscript 패치 제목은 `fix: normalize userscript build module paths on Windows`입니다. 같은 방식으로 해결하지 않았어도 동작이 맞으면 로컬 패치를 유지할 이유가 없습니다.
4. `main`을 업스트림 기본 브랜치로 fast-forward합니다. 개인 브랜치를 갱신된 `main` 위로 rebase합니다. 개인 fork origin에만 반영합니다. 충돌은 변경 의도와 회귀 테스트를 기준으로 해결합니다.
5. `firefox:check`를 실행합니다. 업스트림 커밋과 남은 패치를 `scripts/firefox/maintenance.json`에 기록합니다. 개인 배포 버전을 `scripts/firefox/release.config.json`에서 증가시키고 소스 변경을 커밋합니다.
6. `firefox:package`, `firefox:sign`을 순서대로 실행합니다. 산출물은 `.output/firefox-private/<개인 버전>/`에 저장됩니다. `release.json`에 원본 버전과 소스/upstream 커밋, 해시와 제출 상태가 기록됩니다.

### 번역 성능 패치 점검

- Google의 `translation-only` 경로는 실제 native provider와 기존 원문 복원 기능을 사용합니다. 서비스 이름만 보고 시작을 거부하거나 quick profile을 강제로 bilingual로 바꾸지 않습니다. 업스트림에서도 이 동작을 지원하면 개인 호환 패치를 제거합니다.
- Google native HTTP는 escaped HTML 기준 32 text slots와 10,000자 경계를 따릅니다. 화면의 원문 입력을 하나의 문자열로 합치지 않습니다. 준비 작업은 최대 네 묶음인 128 slots와 40,000자로 제한합니다. AI의 4 slots와 2,000자 정책은 유지합니다. 실제 Google HTTP는 4개 동시 요청과 150ms 시작 간격을 사용합니다. 429의 전체 queue 중단과 단일 회복 probe를 유지합니다.
- `viewport`의 요청 준비와 DOM lifecycle을 분리합니다. 기존 IO pending plan만 사용하며 준비 중인 요청과 아직 소비하지 않은 결과에 상한을 둡니다. 먼 영역에는 wrapper나 spinner를 만들지 않습니다. 후보가 prefetch 범위를 벗어나면 소비하지 않은 준비를 취소합니다. 공유 요청의 다른 소유자는 유지합니다.
- 원문 변경과 SPA 전환을 기준으로 요청 유효성을 검사합니다. Google native 요청은 provider가 사용하지 않는 제목 때문에 중복 요청하지 않습니다. AI와 다른 서비스의 context identity는 유지합니다. 원문 복원은 기존 text node와 inline 구조를 보존해야 합니다.
- `viewport`는 현재 화면의 고정 그룹을 결산한 뒤 유효한 결과를 한 DOM transaction으로 반영합니다. 개별 full-page spinner는 표시하지 않습니다. staging은 요청 준비 점유만 반환합니다. DOM에 반영하기 전에는 완료로 기록하거나 후보를 삭제하지 않습니다. 반복 IO가 staged 후보를 다시 dispatch하지 않아야 합니다. 취소한 그룹의 결과는 이후 DOM에 반영하지 않습니다.
- 개인 ID의 업데이트에서 기존 공통 기본값 10개와 초당 10개를 한 번 20개와 초당 40개로 갱신합니다. 기존 `all` 설정은 이번 개선 대상인 `viewport`로 선택합니다. 사용자가 별도로 정한 요청 값과 서비스/모델 override는 유지합니다. 적용 marker를 기록하므로 이후 사용자 설정을 다시 변경하지 않습니다.
- 업스트림 업데이트 시 아래 회귀 명령을 실행합니다. 구현 문자열보다 요청 묶음과 취소 동작을 기준으로 개인 패치의 필요성을 판단합니다.

```bash
npx --yes pnpm@9.12.1 test -- tests/fullPageVisibilityScheduling.test.ts tests/viewportCommitGroup.test.ts tests/fullPageTranslationIndicators.test.ts tests/liveTextTranslation.test.ts tests/google.test.ts tests/googleRequestGate.test.ts tests/translationRequestScheduler.test.ts tests/backgroundTranslationHandler.test.ts tests/viewportStability.test.ts tests/personalPerformancePreset.test.ts tests/personalPerformanceRuntime.test.ts tests/translationConfigCheck.test.ts tests/quickTranslation.test.ts tests/quickProfileSettingsLifecycle.test.ts
npx --yes pnpm@9.12.1 test:audit
npx --yes pnpm@9.12.1 compile
```

- 성능 비교는 같은 fixture, viewport, 표시 방식과 응답 지연을 사용합니다. 번역용 host 생성은 완료가 아닙니다. 처음 화면에 보인 원문별로 실제 응답이 DOM에 반영됐는지 검사합니다. cold trial은 새 background/cache를 사용합니다. warm trial은 같은 background worker에서 같은 원문을 다시 번역합니다.
- 원본 trace와 실행 환경은 `C:/Users/ifiha/zelley/free/research/translation-performance`에 보관합니다. coverage를 켠 실행의 시간은 속도 비교에 사용하지 않습니다. 측정 중에는 빌드나 테스트를 동시에 실행하지 않습니다.
- 일반 기사에서 baseline, 화면 일괄 전환, 요청 예산 증가, 둘의 조합을 구분해 비교합니다. 일부 문단이 먼저 보이는 프레임이 없는지 검사합니다. 캐시 없는 경우와 캐시 있는 경우를 나눠 기록합니다. 100만 자라는 문서 길이는 목표나 배포 기준으로 사용하지 않습니다.
- 업스트림에서는 구현 형태보다 동작으로 패치 필요성을 확인합니다. cap1/group3 완료와 staged 취소를 확인합니다. 스크롤 이탈 후 재진입, 원문 변경, SPA 전환도 확인합니다. 반복 IO admission이 이미 도착한 결과를 버리면 안 됩니다. 한 요청이 실패해도 성공한 문단은 반영하고 실패한 문단의 재시도 상태는 유지해야 합니다.
- 공유 코드 변경을 배포하기 전에 Chrome, Firefox, userscript를 빌드합니다. `verify:extension-manifests`와 `scripts/verify-userscript-build.mjs`도 실행합니다. Firefox 개인 버전만 올리며 원본 package 버전과 lockfile은 유지합니다.

### 개인 서명과 설치

- 개인 ID는 `fluent-read@euntaek-hong`, 이름은 `FluentRead Personal`입니다. 원본 Firefox manifest는 유지하고 서명용 staging 복사본만 변경합니다. 개인 버전은 `1.0.1`부터 단조 증가합니다. 업스트림 package 버전은 수정하지 않습니다.
- 인증정보 우선순위는 `WEB_EXT_API_KEY`/`WEB_EXT_API_SECRET` 환경변수, Git 제외 파일 `.env.signing.local`, 기존 `~/OneDrive/archive/settings/firefox/mozilla-api.json`의 `issuer`/`secret`입니다. 공유 JSON 경로는 `FLUENTREAD_AMO_CREDENTIAL_FILE`로 변경할 수 있습니다. 비밀값을 출력하거나 소스 ZIP에 넣지 않습니다.
- 고정된 `web-ext@10.7.0`을 npm 임시 실행으로 사용합니다. 채널은 `unlisted`입니다. 재현 명령을 포함한 소스 ZIP을 함께 제출합니다.
- 서명 대기/시간 초과 후에는 `firefox:sign -- --resume`으로 기존 제출건을 조회합니다. `submitting`, `pending`, `signed` 상태인 버전을 다시 패키징하거나 중복 제출하지 않습니다. 실패한 제출은 AMO에서 상태를 확인하고, 새 소스가 필요하면 개인 버전을 증가시킵니다.
- `.output`을 정리하기 전에 배포별 `release.json`과 ZIP/XPI를 보존합니다. 이 기록은 업스트림 업데이트를 위한 Git 재작성과 독립적으로 유지합니다.
- 서명된 XPI를 일반 Firefox의 파일에서 부가 기능 설치 메뉴로 설치합니다. 같은 개인 ID의 새 버전은 기존 설정을 유지합니다. 최종 확인은 Firefox 재시작 후 확장 활성화와 설정 유지입니다.
