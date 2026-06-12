# olapdb 发现台账（截至验证 #16）

汇总演算板系列对 olapdb 的全部已核实发现，供与持续优化智能体（GPT-5.5，xhigh
推理档）的改动记录对账。行号绑定发现时点的代码版本（代码持续被该智能体修改，
行号会漂移；以"文件+模式"为准）。

证据等级：A=quote 机检/编译验证；B=转录内原文核实；C=多轮复现但未逐行复核。

## 已修复（修复智能体落地，编译验证）

| # | 位置 | 问题 | 来源 | 等级 |
|---|---|---|---|---|
| 1 | RunnerManager.java（closeRunnersOfRegion，#15 时 :562） | 空 catch 吞异常 | #6/#12/#15 | A（修复：@Slf4j + log.error，check PASS） |
| 2 | SegRunner.java :58（前身 SegCombine/SegMendRunner） | 空 catch（ignored） | #6/#12/#15 | A（修复：log.error，check PASS） |
| 3 | Util.java（#16 时 :731） | MalformedURLException 空 catch | #6/#16 | A（修复：log.error，check PASS） |
| 4 | Util.java :34 | 静态 ExecutorService 永不 shutdown | #12/#15/#16 | A（修复：JVM shutdown hook，check PASS） |

## 待修（已核实，未进修复范围）

| # | 位置 | 问题 | 来源 | 等级 |
|---|---|---|---|---|
| 5 | ~~VoxelObserver.java :235/:267~~ → 已修复（#17，现实位置 659/1519，log 补全，快检 PASS） | 两处空 catch | #12/#17 | A |
| 6 | ~~WorkingAreaManager.java System.exit(0)~~ → **已被主库修复**（#19：两模型独立 search 零命中，错误路径现为 throw IllegalStateException） | 曾为 catch(Throwable) 内 System.exit(0) | 裸跑#1 → #19 销账 | A |
| 7 | ~~Voxel.java :84~~ → **销账（#22）**：主库已改为抛 IllegalArgumentException（fail-closed），VoxelTest.invalidDimensionJsonFailsClosed 背书该契约；模型先修后经测试反证主动撤销并归因"任务前提过时" | 曾为 catch 返回 null | 裸跑#2 → #22 | A |
| 8 | ~~Voxel.java :97~~ → **已修（#22）**：裁定为故意全局降级（保留），加 volatile 保证跨线程可见性——最小正确改动 | 静态标志翻转 | 裸跑#2 → #22 | A（深检全绿） |
| 9 | ~~Util.java :88~~ → **已修（#22）**：getLock() 加 synchronized，原子化对 LruMap 的访问，合项目惯例 | LruMap 非线程安全 | #12 → #22 | A（深检全绿） |

## 需复核（非局部判断，#15 教训适用：须核访问点而非声明行）

| # | 位置 | 主张 | 来源 | 备注 |
|---|---|---|---|---|
| 10 | ~~Util.java serialId/serialInt~~ → **复核完成：refuted**（#19：getSerialLong 为 synchronized 方法、getSerialInt 用 synchronized(lockInt)，quote 机检，两模型一致） | 原主张：无同步访问 | #12 → #19 裁决 | 已结 |
| 11 | ~~Cluster.java refreshCluster~~ → **已被主库修复**（#19：现为 public static synchronized，:1508，quote 机检） | 曾为无同步修改共享状态 | #12 → #19 销账 | A |
| 12 | ZkClient 生命周期（WorkingAreaManager :44/:394、ZookeeperLock :30/:42） | 关闭/异常路径不完备 | 裸跑#2 | 貌似合理，未逐项核 |

## 良性/误报（防止再次标记）

| # | 位置 | 结论 | 裁决 |
|---|---|---|---|
| 13 | FactState/FactStatePending/IngestBatch*/FactStateBatchIndex 的 catch(TableExistsException ignored) | 文档注明的 lazy-create 竞态处理，catch 即修复 | 良性（#13/裸跑#1 反复误标） |
| 14 | QuerySemanticService :71/:121/:198/:276 | catch 均有 log.error + 错误响应 | 误报（#8 证伪） |
| 15 | WorkingAreaManager 静态字段 :35-42 | 访问器为 synchronized static，其一为 volatile | 误报（#15 裁决，非局部谓词教训来源） |
| 16 | WorkingAreaManager :170 / FactState 摘要类 catch | 故意的默认值回退/错误入摘要 | 良性 |

## 新发现（深检引入后）

| # | 位置 | 问题 | 来源 | 等级 |
|---|---|---|---|---|
| 17 | ~~QueryBackfillSubmitConcurrencyAuditContractTest~~ → **已修复（#20）**：归因为测试陈旧——主库新增 SURFACE_UNKNOWN_SUBMIT_OUTCOME_RETRY 写边界（5 项/4 写），27B-MTP 连锁修正 4 条过时断言，356 测试全绿 | 曾为预存测试失败 expected:<3> but was:<4> | 深检 #17 → #20 销账 | A（终局裸绿） |

注：#17 与修复智能体的改动无关（失败模块构建顺序在改动模块之前）——疑似主库近期改动引入，
是对账的第一优先项。另：VoxelObserver 两处空 catch（台账 #5）已于 #17 修复（现实位置 659/1519，
台账原行号 235/267 为 #12 时点）。

## 新候选（#23 开放式审计，27B-MTP；quote 机检背书，语义标签待复核）

| # | 位置 | 模式 | 等级 |
|---|---|---|---|
| 18 | WorkingAreaManager.java:394 | 空 catch（closeZkClientQuietly）——与裸跑#2 的 #12 项交叉印证 | B |
| 19 | ObserverCommandResult.java:75 | 解析异常静默回退 legacy 分类（无日志） | B |
| 20 | BaseIngestDataPlaneExecutor.java:846 / :1924（olap-ingest-worker，首次覆盖模块） | catch 返回 null 隐藏失败 / 心跳失败吞没 | B |
| 21 | BaseIngestSegmentService.java:1394 | 预留创建失败静默 | B |
| 22 | OlapController.java:282 | JSON 解析失败返回 false，掩盖畸形请求 | B |
| 23 | SegMendService.java:1163 | 解析失败回退原始 JSON 存储（无日志，数据质量静默降级） | B |
| 24 | ObserverTaskRuntimeMetrics.java:143 | CPU 时间启用失败被吞 | B |
| 25 | VoxelRegionCapacityAuditRunner.java:157 / VoxelRegionExpansionMaintenanceRunner.java:107 | HBase Admin 未关闭（tools，严重度视运行模式） | B |

注：部分条目可能属 #16 类"故意回退"（如 controller 返回 false、SegMend 降级存储是否有意），
复核时按 #22 的方法论：查测试契约与调用方语义再裁决。

## 对账（待补）

需要优化智能体侧的改动记录（如 `git -C D:\Work\olapdb log --oneline --stat -30`）：
逐条核对上表"待修/需复核"项是否已被其改动覆盖、其改动是否引入本表未含的新问题。
