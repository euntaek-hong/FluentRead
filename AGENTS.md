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
- `pnpm test:regression:all` 执行确定性的一键回归。真实浏览器层必须显式开启，使用临时 profile、屏幕外正常尺寸窗口和 focus-safe helper；不得连接用户日常 profile、最小化窗口或调用 `bringToFront()`。
- 自动化按键名称使用标准 `Control`，不要使用 `CTRL`；浏览器报告必须说明 launch mode、focus policy、window placement、执行范围与证据目录。
- 不把参考项目自身的测试通过视为 FluentRead 的验证结果。

## 개인 Firefox fork 운영

- 이 fork의 개인 사용 대상은 Firefox입니다. 현재 작업은 Windows 빌드 오류 두 곳과 개인 패키징입니다. 번역 로직은 업스트림 그대로 유지합니다. 이 범위에서는 Chrome/userscript 빌드와 웹사이트 문서 빌드를 요구하지 않습니다.
- `origin`은 `euntaek-hong/FluentRead`, `upstream`은 `FluentRead/FluentRead`입니다. `main`은 업스트림을 따라가고 개인 수정은 `codex/firefox-local`에서 관리합니다. 업스트림 PR이나 정기 자동 업데이트는 만들지 않습니다.
- 프로젝트 명령은 `npx --yes pnpm@9.12.1 <명령>`으로 실행할 수 있습니다. pnpm 전역 설치나 의존성 업그레이드는 필요하지 않습니다.
- Windows 확장 전용 설치에서 문서용 이미지 바이너리 설치가 실패하면 `install --frozen-lockfile --ignore-scripts`를 사용합니다. 이후 `node node_modules/esbuild/install.js`와 `exec wxt prepare`를 실행합니다. TLS 검사를 완화하지 않습니다.

### 업데이트 요청 시 체크리스트

1. `git status --short`로 사용자 변경을 확인합니다. 작업 내용을 덮어쓰지 않고 `git fetch upstream`을 실행합니다.
2. `scripts/firefox/maintenance.json`의 마지막 업스트림 커밋 이후 변경을 확인합니다. 검사 대상은 아래 두 동작입니다. 단순 문자열 검색으로 해결 여부를 판단하지 않습니다.
   - `scripts/testing/run-resource-safe.mjs`: Windows에서 `shell:false`로 로컬 Node CLI를 실행해야 합니다. `wxt`, `vitest`, `vue-tsc`가 성공해야 하고 인수와 종료 코드가 보존되어야 합니다.
   - `wxt.config.ts`의 `build:publicAssets`: WXT가 `/` 또는 `\\` 구분자로 제공하는 OCR core/worker를 모두 찾아야 합니다. 실제 리소스가 없으면 오류를 유지해야 합니다.
3. 업스트림에서 해결된 패치는 회귀 테스트로 확인한 후 개인 브랜치에서 제거합니다. 커밋 제목은 `fix: execute local Node CLIs directly on Windows`, `fix: normalize OCR public asset paths on Windows`입니다. 같은 방식으로 해결하지 않았어도 동작이 맞으면 로컬 패치를 유지할 이유가 없습니다.
4. `main`을 업스트림 기본 브랜치로 fast-forward합니다. 개인 브랜치를 갱신된 `main` 위로 rebase합니다. 개인 fork origin에만 반영합니다. 충돌은 변경 의도와 회귀 테스트를 기준으로 해결합니다.
5. `firefox:check`를 실행합니다. 업스트림 커밋과 남은 패치를 `scripts/firefox/maintenance.json`에 기록합니다. 개인 배포 버전을 `scripts/firefox/release.config.json`에서 증가시키고 소스 변경을 커밋합니다.
6. `firefox:package`, `firefox:sign`을 순서대로 실행합니다. 산출물은 `.output/firefox-private/<개인 버전>/`에 저장됩니다. `release.json`에 원본 버전과 소스/upstream 커밋, 해시와 제출 상태가 기록됩니다.

### 개인 서명과 설치

- 개인 ID는 `fluent-read@euntaek-hong`, 이름은 `FluentRead Personal`입니다. 원본 Firefox manifest는 유지하고 서명용 staging 복사본만 변경합니다. 개인 버전은 `1.0.1`부터 단조 증가합니다. 업스트림 package 버전은 수정하지 않습니다.
- 인증정보 우선순위는 `WEB_EXT_API_KEY`/`WEB_EXT_API_SECRET` 환경변수, Git 제외 파일 `.env.signing.local`, 기존 `~/OneDrive/archive/settings/firefox/mozilla-api.json`의 `issuer`/`secret`입니다. 공유 JSON 경로는 `FLUENTREAD_AMO_CREDENTIAL_FILE`로 변경할 수 있습니다. 비밀값을 출력하거나 소스 ZIP에 넣지 않습니다.
- 고정된 `web-ext@10.7.0`을 npm 임시 실행으로 사용합니다. 채널은 `unlisted`입니다. 재현 명령을 포함한 소스 ZIP을 함께 제출합니다.
- 서명 대기/시간 초과 후에는 `firefox:sign -- --resume`으로 기존 제출건을 조회합니다. `submitting`, `pending`, `signed` 상태인 버전을 다시 패키징하거나 중복 제출하지 않습니다. 실패한 제출은 AMO에서 상태를 확인하고, 새 소스가 필요하면 개인 버전을 증가시킵니다.
- `.output`을 정리하기 전에 배포별 `release.json`과 ZIP/XPI를 보존합니다. 이 기록은 업스트림 업데이트를 위한 Git 재작성과 독립적으로 유지합니다.
- 서명된 XPI를 일반 Firefox의 파일에서 부가 기능 설치 메뉴로 설치합니다. 같은 개인 ID의 새 버전은 기존 설정을 유지합니다. 최종 확인은 Firefox 재시작 후 확장 활성화와 설정 유지입니다.
