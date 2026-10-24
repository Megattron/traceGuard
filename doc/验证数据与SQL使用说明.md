# TraceGuard 验证数据与 SQL 使用说明

本批以测试实例 `DA_CLICKHOUSE_DB_TEST` 中 `user_id=980107c0ab` 的既有事件为依据，保留账号和 20 个已有视频 ID，补充功能验证所需的合成事件与参考维度。对应设计为 [计分规则-修订稿](计分规则-修订稿.md)，特征编号及字段定义见 [SQL 编号对照](特征提取SQL编号对照.md)。实际执行状态及结果以 [验证报告](验证数据与特征SQL验证报告.md) 为准。

## 1. 数据范围与标识

- 批次：`tg_980107c0ab_20261016_20261023_v1`。
- 账号：`980107c0ab`。在本验证中作为租户隔离键；合成的个人主体另用 `sim_viewer_*`，不把账号视为访问者。
- 主窗口：北京时间 `[2026-10-16 00:00:00,2026-10-24 00:00:00)`，包括 10 月 23 日全天，共八个自然日。
- 主窗口物理记录 **1,094,741** 条；此外有 **100** 条明确标记的历史算法样例。合计 **1,094,841** 条导入记录。采集重放 fixture 含一条同 event_id 重放，业务去重后再少一条。
- `dataset_kind=SYNTHETIC`：1,093,536 条主规模合成记录；`FIXTURE`：219 条主窗口精确验收输入；`HISTORY_FIXTURE`：100 条前四个星期五的历史输入；`OBSERVED_REDACTED`：986 条既有事件的脱敏参考副本。
- 每天 500 个正常 20 分钟播放上下文，另有快速拉取、多环境交错、失败集中、持续访问、越权尝试、缺链路、未知字段及工具客户端场景。主要用于功能与一定规模的数据验证，未校准为生产风险分布。

原始数据快照有 213 条 TOKEN_CREATE、72 条 HLS_KEY_VALIDATE、701 条 TS_VALIDATE。该账号在目标日期的源数据仅出现于 16、20、21、22 日。源数据导出发生在 22 日，不能将后续新增源记录视为本快照已经包含。复用的是真实资源 ID；媒体清单、授权范围、身份、网络和状态是明确标记的测试输入，不是由真实视频反查得到。

`OBSERVED_REDACTED` 不补造清单、会话、可信请求 IP 或实际访问者。token 和绑定观众使用稳定替代标识；URL 去掉查询参数。源 DWD 的 success/IP 字段存在已知语义疑点，保留 `SOURCE_RESULT_SEMANTICS_UNVERIFIED`、`SOURCE_IP_SEMANTICS_UNVERIFIED`。`source_event_id` 是本次导出字段摘要，`raw_log_ref` 指向保存的导出行；缺少原生采集位置时不宣称能识别原始日志中所有真实重放。

## 2. 完整事件类型

| event_type | 记录的事实及用途 | 来源状态 |
| --- | --- | --- |
| TOKEN_CREATE | 凭证签发调用；与后端客户端 UA 分开 | 既有＋合成 |
| HLS_KEY_VALIDATE | key 鉴权，不能代替最终 key 响应 | 既有＋合成 |
| TS_VALIDATE | 分片鉴权 PASS/FAIL/UNKNOWN | 既有＋合成 |
| TOKEN_RENEW | 同 token 合法续期；历史快照保留原签发时间 | 合成补充 |
| TOKEN_REVOKE | 凭证撤销动作；撤销状态另由时点快照表示 | 合成补充 |
| IDENTITY_BIND | 已核实身份关联的采集位置；事件身份仍须有可信业务依据 | 合成补充 |
| MANIFEST_REQUEST | 播放清单 HTTP 请求与结果 | 合成补充 |
| KEY_RESPONSE | 最终 key 响应状态、完成及缓存有效期 | 合成补充 |
| CDN_MEDIA_ACCESS | CDN 状态、字节、对象大小、Range、完成标记 | 合成补充 |
| PLAYBACK_STATE | 可信状态报告、媒体进度、倍速与有效期限 | 合成补充 |
| REQUEST_REJECTED | 入口拒绝事件与明确失败原因 | 合成补充 |

八天每天均有全部 11 种类型。生产接入应按来源原始协议映射到这些标准类型，不要求修改源系统的原生名称。每个阶段独立计数，鉴权和 CDN 不相加成为请求总量。auth_result 的 -1 为 UNKNOWN，不能转换成 FAIL。

## 3. 六表与两个视图

| 对象 | 职责 |
| --- | --- |
| da.tg_validation_events | 原始标准事件，含批次、场景、来源和质量标记 |
| da.tg_validation_media_segments | 资源路径、内容版本、媒体区间、轨道/清晰度、总片数 |
| da.tg_validation_token_snapshots | 事件发生前生效的范围、有效期与撤销状态 |
| da.tg_validation_source_coverage | 来源覆盖、采样、必需步骤及协议有效期 |
| da.tg_validation_business_config | 业务时区、夜间时段及配置生效范围 |
| da.tg_validation_ip_info | 文档保留地址对应的合成地区与运营商标签 |
| da.tg_validation_events_dedup | FINAL 导入幂等＋event_id 去采集重放 |
| da.tg_validation_event_features | 单事件解析及参考维度关联 |

本批约束：每个 run/user/scenario 只有一条 business_config，每个 run/user/scenario/object_path 只有一个媒体维度，每个 run/request_ip 只有一条 IP 维度。输入违反这些约束会导致 JOIN 扩增，不应直接导入。未来多配置版本须先改为按事件时点唯一选择有效版本。

表使用 ReplacingMergeTree，`record_id/row_key` 稳定；重复导入后以 FINAL 读逻辑记录。业务 event_id 与导入 record_id 分开，真实重试使用不同 event_id。没有 UPDATE、DELETE、TRUNCATE、DROP 操作，既有 DWD 表只读。

## 4. 可重复执行

从 workspace 根目录执行，使用 Python 3 标准库。连接仅由 `settings.local.json` 的 `DA_CLICKHOUSE_DB_TEST_*` 读取，不在命令或文件中写账号密码。

```bash
# 本地生成；同一代码/参数会生成同一 SHA-256 的 gzip 文件。
python3 tasks/20261022_TraceGuard/scripts/generate_validation.py
python3 tasks/20261022_TraceGuard/scripts/check_data.py
python3 -m unittest discover -s tasks/20261022_TraceGuard/tests -p 'test_*.py' -v

# 以下需要测试实例访问权限。
python3 tasks/20261022_TraceGuard/scripts/ch_client.py schema
python3 tasks/20261022_TraceGuard/scripts/load_validation.py --fixtures-only
python3 tasks/20261022_TraceGuard/scripts/verify_features.py

# 小样例通过后，导入完整八天；已完成文件/批次会跳过。
python3 tasks/20261022_TraceGuard/scripts/load_validation.py
```

`data/validation/manifest.json` 记录每个文件的数量、类型、时间及 SHA-256。`load_checkpoint.json` 持久化每 5,000 行批次进度；提交成功但回执丢失时，重试同批也由稳定键保持逻辑幂等。已加载文件若改变，程序拒绝继续混入旧批次，应使用新的 run_id。`--reload` 只适用于内容未变化的原文件。

`schema` 使用 CREATE IF NOT EXISTS，不会更新既有视图定义。修改 SQL 后需要核对已建定义；不能把“命令返回成功”当成视图已升级。本批视图完成兼容性修正后才成功创建。

## 5. 按编号提取

例如 R7 视频失败特征，对应 TG-F09，查询单个 10 分钟场景：

```bash
python3 tasks/20261022_TraceGuard/scripts/ch_client.py query \
  --file tasks/20261022_TraceGuard/sql/features/TG-F09_auth_failures.sql \
  --scenario failure_burst \
  --start '2026-10-23 14:00:00.000' --end '2026-10-23 14:10:00.000' \
  --out /private/tmp/traceguard_failure_features.json
```

不传 scenario 时查询该批所有场景，但结果保留场景隔离。所有 SQL 都有 run_id/user_id/scenario_id/window_start/window_end 五个 HTTP 类型参数；脚本固定本批 run/user，时间按事件时间半开区间查询。R8 的全天占比应传入分钟对齐的完整 24 小时；R9 历史比较还要求可比历史至少四天。不能把八天汇总量套用十分钟规则的阈值。

明细 TG-F01 会返回大量单事件行，日常验证优先按场景/短窗口查询。其余 SQL 按各自自然粒度输出宽特征，字段级状态表示哪些值可用，不能只看组级 compute_status。

## 6. 验收材料与限制

- [固定案例与手算预期](../tests/fixture_expectations.md)：45 个断言，覆盖 TG-F00～12。
- `data/validation/fixture_cases.json`：机器可读的输入窗口、定位条件和固定预期。
- `data/validation/offline_validation.json`：文件校验、DDL 字段契约、全批次导入键唯一性及日期/类型覆盖。
- `data/validation/sql_fixture_verification.json`：真实 ClickHouse 查询结果与固定预期比较，含 SQL 和案例 SHA-256。

历史样例的四个星期五只验证基线算法，不补齐主数据的生产历史。缺严格终端步骤顺序模型时，链路顺序违规为 NULL；缺校准请求 TTL 时，请求活跃并发代理为 NULL；缺可信状态时真实状态并发为 NULL。没有物理设备 ID，不输出真实设备数。UA 分类为可解释的验证解析器，生产接入需要版本化维护和真实数据校准。

实现参考：[ClickHouse intervalLengthSum](https://clickhouse.com/docs/reference/functions/aggregate-functions/intervalLengthSum)、[ClickHouse 聚合与 NULL](https://clickhouse.com/docs/reference/functions/aggregate-functions)。具体兼容性以本次 23.2.2.20 实跑记录为准。
