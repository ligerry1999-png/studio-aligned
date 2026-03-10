# Canvas workflow adjustments (2026-03-04)

- [x] Add local draft persistence for canvas graph
- [x] Default graph to single start node on first open
- [x] Restore unsaved last canvas state on reopen
- [x] Allow input node to accept up to 2 incoming edges
- [x] Keep start/end/merge edge constraints coherent
- [x] Run frontend build verification
- [x] Summarize behavior and user test steps

## Review
- Implemented browser-side draft persistence via `localStorage` with key `studio_aligned_workflow_canvas_draft_v1`.
- First entry now defaults to one `start` node only; reopening canvas restores last unsaved graph.
- Edge rule updated: `input` supports up to 2 incoming edges, `merge/end` support multi-incoming, `start` still rejects incoming.
- Verification: `npm --prefix frontend run build` passed.

# Backend live integration smoke test (2026-03-04)

- [x] Verify backend/frontend services are reachable (8899/5174)
- [x] Run real text model streaming test via backend API
- [x] Diagnose image generation failure (401 invalid token)
- [x] Align image API key with working text key for live testing
- [x] Re-run real image generation test successfully

# Parallel branch failure fix (2026-03-04)

- [x] Inspect failure logs for `Failed to fetch` in workflow run
- [x] Identify backend root cause: concurrent `.tmp` file collision in `_write_json`
- [x] Patch backend JSON write path to use unique temp file per write
- [x] Reproduce parallel text branch execution (same workspace) without 500 errors
- [x] Reproduce mixed text+image and parallel image branches without request failures
- [x] Verify backend syntax (`py_compile`) and frontend build

# Transient EOF stabilization (2026-03-04)

- [x] Capture latest failing branch evidence (`EOF ... _ssl.c:1129`) from logs/sessions
- [x] Add unified transient upstream error classifier (text+image shared)
- [x] Harden text-stream retry policy for no-token transient failures
- [x] Harden image generation retry policy for transient transport failures only
- [x] Re-run parallel workflow smoke tests (text/text, image/image, text/image)
- [x] Document verification outcome + residual risk

## Review
- 新增统一瞬时错误识别（`_is_transient_upstream_error`），覆盖 `EOF`、连接重置、broken pipe、超时、上游 5xx。
- 文本流节点重试由 1 次提升到 2 次（仅“无 token 输出”时触发，避免重复输出）。
- 生图节点新增瞬时错误重试（最多 3 次，仅瞬时错误重试；4xx 参数/鉴权错误不重试）。
- 回归验证结果：
  - 文本并发 6 路：`TOTAL_FAIL=0`
  - 文本+生图并发：均成功
  - 生图并发 2 路：均成功
- 残余风险：上游服务若持续不可用（非瞬时）仍会失败，此时会保留失败原因并需要人工接管。

# Workflow run API M1 (2026-03-05)

- [x] Add backend request models for workflow preview/run/retry
- [x] Add run snapshot persistence files and service helpers
- [x] Implement `/api/v1/workflow/runs/preview` expansion + limit validation
- [x] Implement `/api/v1/workflow/runs` create/run minimal execution path
- [x] Implement `/api/v1/workflow/runs/{run_id}` and `/tasks/{task_id}/retry`
- [x] Verify with curl smoke tests and `py_compile`

## Review
- 新增后端接口：`GET /workflow/runs`、`POST /workflow/runs/preview`、`POST /workflow/runs`、`GET /workflow/runs/{run_id}`、`POST /workflow/runs/{run_id}/tasks/{task_id}/retry`。
- 新增运行持久化：`backend/data/workflow_runs/` 与 `workflow_runs_index.json`。
- 任务展开支持：`broadcast` / `pairwise` / `cartesian`，并实现 50 任务上限校验。
- 运行调度支持：后台线程执行、并发控制、失败暂停（停止派发新任务）、已启动任务继续、单任务重试。
- 接口验证：
  - `preview_total=1`（预估成功）
  - `run_id` 成功返回，1s 后 `status=running` 且 `summary.running=1`
  - `pairwise` 数量不一致返回 400
  - 对已完成任务调用 retry 返回 400（仅失败任务可重试）
- 编译验证：
  - `python3 -m py_compile backend/service.py backend/main.py`
  - `npm --prefix frontend run build`

# Workflow run UI M2 (2026-03-05)

- [x] Add frontend workflow run API and type definitions (`preview/create/get/retry/list`)
- [x] Add batch-run config panel in WorkflowCanvasPage (assets/prompts/mode/recipe/concurrency)
- [x] Add preview/start actions and backend run polling (2s)
- [x] Add backend run observability list + failed task retry button in right panel
- [x] Verify frontend build + backend py_compile

## Review
- 画布页新增“批量运行（M2）”配置区：支持选择本地素材、输入多提示词、选择组合模式、设置每图产出/并发、设置配方模板/模型/比例/质量/参考素材。
- 新增“预估任务”与“启动批运行”按钮，接入 `/api/v1/workflow/runs/preview` 与 `/api/v1/workflow/runs`。
- 新增后端批运行轮询（2s）与右侧“后端批运行（M2）”可观测区，展示 run 汇总、任务状态、错误信息与单任务重试入口。
- 任务重试接入 `/api/v1/workflow/runs/{run_id}/tasks/{task_id}/retry`。
- 验证：
- `npm --prefix frontend run build` 通过
- `python3 -m py_compile backend/service.py backend/main.py` 通过

# Workflow run UX hardening M2.1 (2026-03-08)

- [x] 支持 `@主素材`（兼容 `@input_asset`）并接入批量模板选择器
- [x] 固化内置槽位 `sofa_ref/style_ref` 为必填且不可删除
- [x] 启动前增加“预估锁定”校验，配置变更后强制重新预估
- [x] 后端 preview 返回完整任务展开清单（非仅样例）
- [x] 前端预览清单展示每条任务主素材/槽位/最终提示词
- [x] 完成前后端编译验证

## Review
- 批量模板输入框的 `@` 菜单新增 `@主素材`，保留 `@input_asset` 作为兼容别名。
- 批量槽位区调整为“参考槽位绑定（固定）”，内置 `sofa_ref/style_ref` 强制必填并禁止删除；引用未绑定槽位会在启动前直接阻断。
- 启动批运行前新增“预估签名”机制：预估后任一配置变更都会让预估失效，必须重新点击“预估任务”。
- 后端 `preview` 响应新增 `expanded_tasks`（全量展开），前端改为“任务展开预览清单”，可逐条核对主素材、槽位映射和最终提示词。
- 验证结果：
  - `npm --prefix frontend run build` 通过
  - `PYTHONPYCACHEPREFIX=/tmp/codex-pycache python3 -m py_compile backend/service.py backend/main.py` 通过

# Workflow batch UX simplification M2.2 (2026-03-08)

- [x] 批量区加入“3步使用顺序”提示，降低首次上手成本
- [x] 术语收敛：组合模式文案从技术词改为操作词
- [x] 增加“本地实时任务预演”（主图-规则配对与任务总量）
- [x] 增强 `@` 引用菜单稳定性（避免弹出后焦点抢占导致闪退）
- [x] 构建验证

## Review
- 批量配置区新增步骤型引导，入口默认给出“先选图-再配规则-后预估启动”。
- 新增本地实时预演：在不请求后端的情况下，实时展示“主图×规则”的配对清单与任务总量估算。
- 组合模式改为业务可理解文案：`多图同规则 / 单图多规则`、`图词一一配对`、`全组合探索`。
- `@` 引用菜单加入 `disableEnforceFocus/disableRestoreFocus/disableAutoFocusItem` 等设置，减少输入中弹层闪退。
- 验证结果：
  - `npm --prefix frontend run build` 通过

# Workflow batch grouped output M2.3 (2026-03-08)

- [x] 预估任务清单改为按主素材分组展示
- [x] 后端批运行看板改为按主素材分组展示
- [x] 增加“存储结果”按钮，将批运行完成任务保存到统一存储（按主素材分组）
- [x] 保存逻辑增加 run_id+source 去重，避免重复保存
- [x] 构建验证

## Review
- 左侧“任务展开预览清单”按 `source_asset` 分组，先显示主素材分组头，再显示组内任务。
- 右侧“后端批运行（M2）”按主素材分组，便于对照同一主图下的多任务状态。
- 新增“存储结果”操作：从已完成任务提取结果并写入“统一存储页-流程产出”，分组粒度与主素材一致。
- 重复点击存储时使用 `run_id + node_id(batch-source-*)` 去重，仅保存新增分组。
- 验证结果：
  - `npm --prefix frontend run build` 通过

# Workflow batch task-card mode M2.4 (2026-03-08)

- [x] 新增“任务卡片编排”开关（每卡 = 选图 + 绑定模板）
- [x] 支持任务卡片增删改复制与启停
- [x] 任务卡片模式下联动本地实时预演
- [x] 任务卡片模式接入真实 payload（自动使用 pairwise）
- [x] 组合模式选择器在任务卡片模式下禁用并给出提示
- [x] 构建验证

## Review
- 批量区新增“任务卡片编排”入口，可按卡片粒度直接配置“主图素材 + 模板绑定”，减少用户在两块区域来回映射。
- 任务卡片模式下，实时预演与启动前校验都改为基于卡片展开。
- 启动时自动将组合模式固定为 `pairwise`，保持“每卡一条任务规则”的心智一致。
- 受后端素材去重约束，当前卡片模式暂不支持同一主图重复出现在多卡片；前端已在预演和启动校验阶段阻断并给出说明。
- 验证结果：
  - `npm --prefix frontend run build` 通过

# Workflow batch-in-canvas node M2.5 (2026-03-08)

- [x] 新增节点类型：批量节点（可在画布中拖入）
- [x] 批量节点执行时接入后端批运行 API（create + poll）
- [x] 批量节点产出接回画布上下文，可供下游节点继续处理
- [x] 节点检查器增加批量节点说明
- [x] 构建验证

## Review
- 批量能力从“独立面板运行”扩展为“画布节点执行链的一环”：流程运行到批量节点时自动触发后端批运行并等待完成。
- 批量节点使用左侧批量配置构建 payload；执行成功后输出摘要文本与生成素材列表，下游节点可继续引用。
- 执行过程中会同步右侧“后端批运行（M2）”看板状态；若批运行 paused/failed，会直接让流程失败并提示去任务面板重试。
- 兼容保留原“独立批运行”入口，不影响现有测试链路。
- 验证结果：
  - `npm --prefix frontend run build` 通过

# Workflow batch sub-canvas dialog M2.6 (2026-03-08)

- [x] 从批量节点入口打开“批量编排器（子画布）”弹窗
- [x] 子画布布局：左侧步骤导航 + 中央流程画布 + 右侧配置编辑区
- [x] 子画布内按分区编辑批量配置（主图/模板/任务卡片/执行参数/槽位/预演运行）
- [x] 子画布画布节点点击可切换右侧编辑分区
- [x] 构建验证

## Review
- 新增批量编排弹窗（约 `92vw x 88vh`），满足“从批量节点进入、独立大界面编辑”的操作路径。
- 弹窗中部采用 ReactFlow 子画布表达批量流程阶段（主图素材 -> 模板池 -> 任务卡片 -> 执行参数 -> 槽位映射 -> 预演运行）。
- 左侧可直接切分区，右侧分区编辑与现有批量状态完全联动，保存即生效到批量节点运行。
- 批量节点检查器新增“打开批量编排器”按钮，左侧批量区也保留快捷入口。
- 验证结果：
  - `npm --prefix frontend run build` 通过

# Workflow batch decoupled entry M2.7 (2026-03-08)

- [x] 左侧“批量运行（M2）”从完整表单改为“摘要 + 入口”
- [x] 将批量配置编辑统一收敛到“批量编排器（子画布）”
- [x] 子画布内补齐 `@` 槽位引用弹窗（模板区 + 固定规则区）
- [x] 批量节点报错/说明文案由“左侧配置”改为“批量编排器”
- [x] 构建验证

## Review
- 左侧栏不再承载批量配置字段，避免与普通节点设置混杂，改为“状态摘要 + 打开编排器”。
- 批量配置入口明确为独立 UI：从批量节点或左侧入口进入同一子画布弹窗完成编辑。
- 在子画布中恢复并统一 `@` 引用交互：模板卡片和固定规则输入都支持弹出槽位菜单选择。
- 批量节点执行时缺少配置的错误提示改为指向“批量编排器（子画布）”，心智一致。
- 验证结果：
  - `npm --prefix frontend run build` 通过

# Workflow batch asset modal picker M2.8 (2026-03-09)

- [x] 子画布主素材改为“点击打开素材弹窗”交互
- [x] 弹窗内支持来源 Tab 分类（上传/生成/素材库/Bridge）
- [x] 素材卡片展示缩略图 + 名称，不再仅文字混排
- [x] 弹窗支持搜索与多选回填主素材
- [x] 弹窗支持直接上传素材并自动加入选择
- [x] Bridge 素材支持“入库到本地”后自动勾选
- [x] 构建验证

## Review
- 子画布“主图素材”分区只保留已选结果和入口按钮，素材浏览与选择迁移到独立大弹窗，认知路径更清晰。
- 新增素材弹窗顶部来源 Tab：`上传 / 生成 / 素材库 / Bridge`，并显示各来源数量。
- 列表改为卡片网格，每个卡片显示缩略图、标题、来源标签；本地素材可点击多选，Bridge 素材可一键入库。
- 上传入口放在弹窗内，支持多文件上传；上传成功后自动刷新并加入当前勾选集。
- 验证结果：
  - `npm --prefix frontend run build` 通过

# Workflow prompt card global library M2.9 (2026-03-09)

- [x] 模板池“新增指令模板卡片”改为打开独立弹窗
- [x] 弹窗支持从全局卡片库搜索并多选加入当前流程
- [x] 弹窗支持新建指令卡片并保存到全局通用库
- [x] 弹窗支持删除全局卡片（移除库内卡片）
- [x] 新建卡片支持“仅保存到库 / 保存并加入当前流程”
- [x] 后端新增全局卡片库 API 与持久化文件
- [x] 前后端编译验证

## Review
- 将模板池入口从“直接加空卡片”升级为“卡片库弹窗”，并把“复用已有 + 新建保存”放到同一交互里。
- 全局卡片库通过后端 `workflow_prompt_cards.json` 持久化，满足“跨流程通用”需求。
- 卡片库支持搜索、选择加入、删除；新建卡片可直接写入全局库并可选加入当前流程。
- 验证结果：
  - `PYTHONPYCACHEPREFIX=/tmp/codex-pycache python3 -m py_compile backend/service.py backend/main.py` 通过
  - `npm --prefix frontend run build` 通过

# Text五提示词+文字模板来源 (2026-03-09)

- [x] 扩展 mention settings 数据结构：静态来源支持图片/文字两种内容类型
- [x] 设置弹窗支持创建“文字模板来源”并管理文字条目
- [x] `@` 弹窗支持选择文字条目并插入输入框
- [x] Text 模式增加“5条提示词”开关并传递到文本流式请求
- [x] 文本结果卡片化渲染（5条提示词）并支持“一键生图”
- [x] 前后端编译验证并补充 review

## Review
- 后端 `mention-settings` 新增 `content_type`（source）与 `item_type/content`（item）兼容，静态来源可声明为 `image/text`；文字来源不允许走图片上传接口。
- 设置弹窗中静态来源支持“图片条目 / 文字条目”切换；文字条目可新增、改名、编辑内容、排序、删除。
- 输入框 `@` 弹窗中，静态文字来源改为模板列表，点击后直接把模板内容插入输入框（替换当前 `@query`）。
- Text 模式新增“5条生图词”开关；开启后文本请求会带 `prompt_pack_mode=five_image_prompts`，后端自动追加结构化输出约束并回传参数标记。
- 聊天区文本结果支持解析结构化 JSON 并渲染为 5 条方案卡片，每条都有“生图”按钮，点击后直接触发图像生成任务。
- 验证结果：
  - `PYTHONPYCACHEPREFIX=/tmp/codex-pycache python3 -m py_compile backend/service.py backend/main.py` 通过
  - `npm --prefix frontend run build` 通过
