# feature/harness-improvement — brief

給實作 session 的任務說明。這是 brief，不是 checklist：每個 slice 開工前先跑 `/spec-with-test` 產出 checklist，等 Henry APPROVED 再實作。

v3（2026-10-04）：對照 Codex 與 Claude Code 的 harness 後改寫，並納入 Henry 當天的決定。與 v1 的差異列在文末。

## 目標

讓 `&run` 成為通用的 coding / task 工具，並強化 coding 與 review。現況太偏「修壞掉的測試」：做一個簡單網頁或一個小改動都不順。

## 為什麼現在做不了一般任務（已讀程式碼查證）

| # | 原因 | 位置 |
|---|---|---|
| R1 | system prompt 的流程是「跑測試 → 修 → 再跑」，並規定不改測試 | `src/core/prompts.ts` |
| R2 | 沒有計畫機制；人看不到 agent 打算做什麼 | — |
| R3 | `read_file` 超過 8 KB 只回頭尾，中段讀不到，也沒有行範圍參數 | `tools.ts:192`、`context.ts:8` |
| R4 | 指令 allowlist 只有測試與唯讀指令；`mkdir`、`node x.js`、`npm run build`、任何 pipe 都要逐次核准 | `policy.ts:6` |
| R5 | agent 對 repo 一無所知就開工（沒有 `AGENTS.md`、scripts、目錄概況） | `agent.ts:37` |
| R6 | 步數上限 30 會直接終止；token 預算是整個 session 累計，用完後 session 無法再用，已做的改動也發不了 PR | `agent.ts:151,210`、`limits.md` C2 |
| R7 | 沙箱沒有網路：不能查資料，不能 `npm install`（`node_modules` 一律是空的，`limits.md` L1） | ADR A13 |
| R8 | 沒有 repo 就不能開 session：`getProfile("task")` 是 `throw` | `modes.ts:31` |
| R9 | `profile.onFinish` 執行期沒人讀；收尾由 `engine.ts` 用 `state.mode` 硬分支 | `engine.ts:248` |
| R10 | eval 的 6 個案例全是修測試或找一個 bug | `eval/cases/` |

## 研究結論：Codex 與 Claude Code 怎麼做

來源都實際讀過：Codex 的 `codex-rs/models-manager/prompt.md`、`core/gpt_5_codex_prompt.md`、`core/src/tools/handlers/plan.rs`、`plan_spec.rs`、`prompts/templates/compact/prompt.md`；Claude Code 的官方文件（agent loop、todo tracking、cloud sessions、cloud environments）；Codex cloud 的 internet access 文件。

| 主題 | Codex | Claude Code | 對 `&run` 的結論 |
|---|---|---|---|
| 計畫 | `update_plan`：`plan: [{step, status}]`，整份取代，工具回 `Plan updated`，另送 `PlanUpdate` 事件給 UI。prompt 規定簡單任務不用、不做單步計畫、做完一步就更新 | `TodoWrite` / Task 工具：清單在 tool call 參數，UI 從訊息流讀。久未更新時 harness 在 user 訊息位置插提醒。新模型預設不給這組工具（它們不靠清單也能追蹤） | 採 `update_plan` + `plan_updated` 事件。`&run` 預設用小模型（deepseek-v4-flash），計畫工具有價值 |
| 計畫怎麼不被忘記 | 留在歷史裡；壓縮是 LLM 摘要 | 壓縮後重新附上清單與 `CLAUDE.md` | `&run` 的壓縮只把舊 tool 結果換成 stub，不動 assistant 訊息，所以計畫不會掉。不需要每輪注入 |
| Repo 概況 | `AGENTS.md` 與環境資訊在 session 開頭注入，不用模型自己去讀 | `CLAUDE.md`、git 狀態在第一批訊息的 user 位置注入 | 開頭注入一則 user 訊息 |
| 驗證 | 「codebase 有測試或能 build 就用來驗證」；先跑離改動最近的；沒測試的 repo 不要加測試；不修不相關的壞測試 | 同方向 | prompt 改成條件式 |
| 新專案 vs 既有 codebase | 「Ambition vs. precision」：從零開始可以大膽；既有 codebase 精準、不越界 | 同方向 | 寫進通用 prompt |
| 讀大檔 | 用 shell（`sed -n`、`rg`） | `Read` 有 `offset` / `limit` | `read_file` 加行範圍 |
| 指令核准 | 沙箱是安全邊界；沙箱內的指令不逐次核准，要跨出沙箱才問 | permission mode；隔離環境可用 `acceptEdits` / `bypassPermissions` | `&run` 的沙箱無網路、無密鑰、用完即丟，產出要人核准才發 PR。逐次核准幾乎沒有保護效果 |
| Review | 「findings 為主，依嚴重度排序附檔案行號；摘要其次；沒有發現要明說並指出殘餘風險」 | 多輪審查 + 逐項驗證後才回報 | 強化 review prompt |
| 發 PR 之後 | 同一個 task 可以繼續追問、更新 PR | 「The session doesn't close when the branch is pushed」；可繼續貼 CI 失敗或 review 意見讓它修 | **不要**在 approve 後結束 code session |
| 步數與預算 | 無步數上限 | `maxTurns` 與 `maxBudgetUsd` 預設都是無上限；文件建議 production 設 budget | 預算是主要限制，步數只是資訊 |
| 網路 | agent 階段預設關；setup 階段有網路裝相依套件；可開 allowlist（Common dependencies 預設清單），可限制只允許 GET/HEAD/OPTIONS | 預設 Trusted：只通 package registries、GitHub 等 allowlist；另有 None / Full / Custom。Web 搜尋與抓網頁是 harness 的工具，不從沙箱出去 | 分兩層開，不全開。見第 6 項 |

---

## 兩個 mode 的定義

- **Code mode**：在特定 repo 裡做事，任務類型不限（修 bug、加功能、重構、加測試、寫文件、加一個頁面）。
- **Task mode**：沒有 repo，從零開始做一個任務，例如「做一個簡單的網頁」「做 xxx 研究，給我一份 .html 報告」。

---

## 1. Plan：`update_plan` 工具 + `plan_updated` 事件

- 新增工具 `update_plan`，加進 `ToolName`、`SPECS` 與 code / task 的 `profile.tools`。review 不加。
- 參數：`plan: [{ step: string, status: "pending" | "in_progress" | "completed" }]`，每次帶**完整清單**（整份取代）。
- 「同時最多一項 `in_progress`」寫進工具描述，不在 harness 強制。模型違反時 UI 照樣顯示。
- 工具結果只回 `Plan updated`。**計畫本體留在 assistant 的 tool_call arguments**，不會被 `compactForRequest` 壓掉。
- 發 `plan_updated` 事件（加進 `src/core/events.ts`），UI 吃這個事件，重連靠 `lastSeq` replay。
- **不要**在 `AgentState` 加 `plan` 欄位，**不做**每輪注入計畫的合成訊息，不加 `activeForm`。
- prompt 寫清楚何時用：多步驟任務先列計畫、做完一步就更新；簡單任務不用；不做單步計畫。
- UI：session 頁顯示最新一份計畫。finish gate 上若計畫還有未完成步驟，顯示「N 步未完成」讓人核准前看得到。這是 UI 從事件算的，harness 不擋。

## 2. `onFinish`：依 profile 分派；code session 發 PR 後**繼續可用**

- 把 `engine.ts` 的 finish 處理從 `if (state.mode === ...)` 改成依 `profile.onFinish` 分派：`open_pr`、`draft_review`、`answer` 各一個 handler。
- 「session 是否結束」是每個 handler 自己的性質，不是共同規則：
  - `open_pr`：發 PR 後 session 仍可追問，下一次 approve 在同一個 PR 加 commit（現有行為，`limits.md` G9）。
  - `draft_review`：post 之後不再接受訊息（現有行為）。
  - `answer`：交付後仍可追問，產出新版 artifact。
- **已定案（Henry，2026-10-04）**：code session 發 PR 後維持可追問，只做分派重構。v1 的方向是「approve 之後就結束」，研究結果相反（Codex、Claude Code 都在發 PR 後繼續同一個 session），`&run` 也已經做好第二輪加 commit。Session 的 messages、events、changes 存在 SessionDO 的 SQLite，沒有過期機制，使用者刪除才清掉。

## 3. Code mode 通用化

- **Prompt**：`CODE_SYSTEM_PROMPT` 改成通用原則：先讀再改；既有 codebase 精準小改、照周圍風格；從零開始的檔案可以完整一點；repo 有驗證方式（測試、build、lint）就用它驗證自己的改動，先跑離改動最近的；任務沒要求就不動測試、不替沒有測試的 repo 加測試框架；不修不相關的問題，在摘要裡提；相對路徑；finish 要摘要與 PR 標題。不寫任何特定檔名或函式名。
- **Repo 概況**：第一次啟動沙箱後，把 `AGENTS.md`（若有，設上限）、`package.json` 的 scripts、頂層目錄放進一則 user 訊息。放 user 訊息，不放 tool 結果（tool 結果會被壓成 stub）。code 與 review 都用。這段邏輯放在 `src/core`，engine 與 eval 共用。注意：`publishChanges` 用「第一則 user 訊息」當 PR body 的 Task，概況訊息要排在任務之後，或改掉那個查找。
- **`read_file` 行範圍**：加選用的 `offset`（起始行）與 `limit`（行數）。超過上限被截斷時，回傳要說明總行數與怎麼讀下一段。
- **Eval**：加入非修測試的案例（加功能、重構、加測試、在 repo 裡加一個靜態頁）。`check` 不一定是 `npm test`。跑真實模型前先問 Henry。
- **放寬 code mode 的指令核准（已定案，Henry，2026-10-04）**：code mode 在沙箱內的指令一律放行，只保留 `finish`（發 PR）與刪檔 patch 的核准；review 維持唯讀 allowlist。理由見研究表「指令核准」。auto mode 之後再看。

## 4. Review 強化

- `REVIEW_SYSTEM_PROMPT` 加上：只回報這個 PR 引入的問題；回報前先驗證（讀周圍程式碼，可以的話跑測試），不確定就不報；每個 finding 說明具體的失敗情境；沒有發現就在摘要明說，並指出沒驗證到的風險。
- Review 也拿到第 3 項的 repo 概況。
- 不加 plan 工具。
- Eval 加一個「乾淨的 PR 不該有 finding」的案例，量誤報。

## 5. 拿掉預算，改成每輪的安全上限；花費是資訊

已定案（Henry，2026-10-04）。

- 步數上限與 session token 預算都不再終止 run。eval 案例的 `max_steps` 保留為 eval 專用。
- **一輪**的定義：使用者建立 session 或送出一則訊息開始，到 agent 停下來等使用者為止。在核准關卡按 Approve / Reject 是同一輪，不重新計算。
- **每輪安全上限 ¥50**：把這一輪每次模型呼叫的花費加總（未快取牌價，所以是高估）。碰到就停，使用者送訊息可以繼續，新的一輪重新計算。這只是擋失控，不是產品上的預算。模型沒有價格時，改用每輪 400 萬 token（各次呼叫的輸入加輸出累計）。
- **花費是資訊**：header 顯示步數與 session 累計花費。超過 ¥10 變紅並加 info icon，提示任務偏大、可以拆小。不會因此停止。
- 現在沒有停止鍵（執行中送訊息是轉向，不是停止）。值得做，另開 slice。

## 6. 網路：分兩層，不全開

`&run` 沒有登入，任何拿到網址的人都能用（C4、C5）。全開的風險：網頁內容的 prompt injection、把 repo 內容送出去、下載惡意程式。Codex 預設關、Claude Code 預設只通 allowlist，沒有人預設全開。

- **6a. 查資料：Worker 端的 `web_search` 與 `fetch_url` 工具**。沙箱維持離線，請求由 Worker 發出。`fetch_url` 只做 GET、限制回應大小、擋內網位址，結果照現有的 8 KB 上限截斷，並在 prompt 註明網頁內容是資料不是指令。code 與 task 都可用。**需 Henry 確認**：搜尋服務用哪一家（要 API key，有費用）。
- **6b. 裝套件：沙箱的 egress allowlist**。只放行 package registries（npm 等）。Cloudflare container 有 `interceptOutboundHttp` / `interceptOutboundHttps`（已在 `@cloudflare/workers-types` 確認存在），可以讓 Worker 過濾沙箱的對外請求。實際行為（HTTPS 攔截、憑證）沒驗證過，**先做 spike**。這會修訂 ADR A13，**需 Henry 確認**。
- egress 是比較通用的地基：只放行 registries 就能 `npm install`；放寬成「任何網域、只准 GET」，agent 就能在沙箱裡自己抓網頁，6a 的 `fetch_url` 就不需要了。搜尋則一定要接搜尋服務，與走哪條路出去無關。所以**先做 6b 的 spike**（Henry，2026-10-04），6a 視結果再決定。
- 費用：`fetch_url` 不另外收費（Worker 的一般請求）；`web_search` 要接按次計費的搜尋 API。
- 與花費的關係：開網路後任務變長，每輪安全上限（第 5 項）先到位。抓回來的內容受 8 KB 上限限制。

## 7. Task mode

- **7a. 不需網路的部分**：實作 `getProfile("task")`：`sandboxSetup: "empty"`、`onFinish: "answer"`。`router.ts` 接受 `mode: "task"`；`engine.ts` 的 `create()` 與 `ensureSandbox()` 依 `profile.sandboxSetup` 分流（空沙箱不抓 tarball）。產出走 artifact：agent 寫檔，engine 存 R2，UI 以 `artifact` 事件提供下載（ADR Phase 5 / F2）。這一步做完就能「做一個簡單的網頁」。
- **7b. 研究型任務**：加上 6a 的網路工具，就能「做 xxx 研究，給我一份 .html 報告」。

---

## Slice 與順序

一個 checklist 對應一個 PR。

| Slice | 內容 | 依賴 |
|---|---|---|
| **A** | 第 1 到 5 項。checklist：`harness-improvement-implementation-checklist.md`（已核准） | 無 |
| **B** | 7a：Task mode（空沙箱 + artifact） | A |
| **C** | 6b：egress spike（先證明 HTTPS 攔截可行），再做 registries allowlist。修訂 ADR A13 | spike 結果 |
| **D** | 依 C 的結果：放寬成 GET-only 全網域，或做 6a 的 Worker 端工具；搜尋服務到時再選。接上 7b | C |

之後再看：停止鍵、auto mode。

## 驗收（最低標準）

| 項目 | 驗收 |
|---|---|
| 1 | agent 呼叫 `update_plan` 後 UI 出現清單；重連後清單還在；壓縮 context 後送給模型的訊息裡仍有計畫 |
| 2 | `profile.onFinish` 被實際讀取，engine 不再用 `mode === "review"` 判斷 finish 路徑；code 與 review 的現有 e2e 全過 |
| 3 | 一個「加功能」任務在沒有失敗測試的 repo 上能完成；system prompt 不含修測試專用的規則；模型的第一批訊息裡有 repo 概況；大檔的中段讀得到 |
| 4 | review prompt 含驗證與「只報 PR 引入的問題」的規則；乾淨 PR 的 eval 案例存在 |
| 5 | 超過 30 步的 run 不會因步數被終止；一輪花到 ¥50 會停，送訊息可繼續；header 花費超過 ¥10 變紅 |
| 7a | Task session 不需要 repo 就能建立，產出 .html 並下載 |
| 6a / 7b | 能搜尋、抓網頁、產出報告 |

通則：

- 跑真實模型的 eval 要先取得 Henry 同意（預設 `deepseek-v4-flash`）。
- 不要為了某個 eval 案例在 prompt 裡寫特定檔名或函式名。
- Web / API 功能要用實際執行（瀏覽器或 server）驗證，不能只看 build 通過。
- 只改需求要求的部分；看到不相關的問題用提的。

## 與 v1 的差異

- 第 2 項反轉：v1 是「approve 後 session 結束」，現在是 code session 繼續可用，只做分派重構。
- 新增：`read_file` 行範圍（R3）、指令核准放寬（R4）、Review 強化（第 4 項）、每輪安全上限取代預算與步數（第 5 項）、網路分兩層且先測 egress（第 6 項）。
- Task mode 拆成 7a（不需網路）與 7b（需要網路工具），7a 可以先交付。
- Plan 的設計不變；補上 prompt 的使用時機，與 finish gate 上的未完成提示。
