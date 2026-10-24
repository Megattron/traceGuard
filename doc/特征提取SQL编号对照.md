# TraceGuard 特征提取 SQL 编号对照

本目录按 [计分规则与基础特征提取设计](计分规则-修订稿.md) 的口径实现基础特征，不在 SQL 中计算计分卡分数或把合成数据解释为生产盗版事实。输入表、事件枚举和参数约定见 [验证数据契约](验证数据契约.md)。

**验证状态：45 个独立小样例已在实际 ClickHouse 23.2 中执行，45/45 通过。** 结果和 SQL 指纹见 [小样例验收结果](../data/validation/sql_fixture_verification.json)，输入预期见 [fixture_cases.json](../data/validation/fixture_cases.json)。百万级数据的规模验收结果另行报告；小样例通过不代表已完成生产性能验证。

## 1. 编号、文件与原始规则

`TG-Fxx` 是稳定特征组编号，`TG-Fxx.nn` 是组内字段族编号，英文列名是实际 SQL 输出字段。新增辅助字段不改变既有编号。R4 拆为授权范围与多环境两组；R9 的单事件标签属于 TG-F01，后续聚合属于 TG-F11。

| 编号 | 原始规则 | 名称 | 输出自然粒度 | SQL 文件 |
| --- | --- | --- | --- | --- |
| TG-F00 | 全部规则的数据前提 | 数据质量与来源覆盖 | 场景＋来源＋事件类型 | [TG-F00_data_quality.sql](../sql/features/TG-F00_data_quality.sql) |
| TG-F01 | 全部；直接支持 R9、R10 | 单事件标准化与标签 | 去采集重放后的单事件 | [TG-F01_single_event.sql](../sql/features/TG-F01_single_event.sql) |
| TG-F02 | R1 授权链路异常 | 前置授权与链路观测 | 场景＋可靠会话／token-视频上下文 | [TG-F02_authorization_chain.sql](../sql/features/TG-F02_authorization_chain.sql) |
| TG-F03 | R2 拉片速度异常 | 请求量、媒体覆盖与速度 | 场景＋身份主体＋全视频／视频局部 | [TG-F03_content_pull.sql](../sql/features/TG-F03_content_pull.sql) |
| TG-F04 | R3 同时多视频播放 | 活跃视频与状态并发 | 场景＋身份主体 | [TG-F04_multi_video_activity.sql](../sql/features/TG-F04_multi_video_activity.sql) |
| TG-F05 | R4A 授权范围异常 | 历史授权范围与有效期 | 场景＋token＋事件类型 | [TG-F05_token_scope.sql](../sql/features/TG-F05_token_scope.sql) |
| TG-F06 | R4B 同 token 多环境使用 | 环境数、跨度、切换与交错 | 场景＋token；限定 TS 鉴权客户端事件 | [TG-F06_token_environment.sql](../sql/features/TG-F06_token_environment.sql) |
| TG-F07 | R5 环境频繁变化 | 身份主体环境变化 | 场景＋身份类型＋身份 ID；限定 TS 鉴权客户端事件 | [TG-F07_subject_environment.sql](../sql/features/TG-F07_subject_environment.sql) |
| TG-F08 | R6 分片访问过于规律 | 分片序列与间隔规律 | 场景＋身份＋视频＋会话/token＋媒体序列＋来源/采样口径 | [TG-F08_segment_pattern.sql](../sql/features/TG-F08_segment_pattern.sql) |
| TG-F09 | R7 视频失败请求过多 | 视频鉴权失败及来源集中度 | 场景＋视频＋来源＋事件类型 | [TG-F09_auth_failures.sql](../sql/features/TG-F09_auth_failures.sql) |
| TG-F10 | R8 长时间高强度访问 | 活跃分钟、连续段与内容量 | 场景＋身份＋来源/采样口径 | [TG-F10_sustained_activity.sql](../sql/features/TG-F10_sustained_activity.sql) |
| TG-F11 | R9 异常时段活跃 | 夜间聚合与历史比较 | 场景＋身份＋事件类型＋来源＋鉴权结果＋采样口径 | [TG-F11_off_hours.sql](../sql/features/TG-F11_off_hours.sql) |
| TG-F12 | R10 脚本或工具特征 | 客户端工具标签聚合 | 场景＋身份＋视频＋token＋会话 | [TG-F12_client_tools.sql](../sql/features/TG-F12_client_tools.sql) |

### 1.1 组内稳定编号索引

子编号按前缀映射到上表同一 SQL，例如 `TG-F09.01`、`TG-F09.02`、`TG-F09.03` 都由 `TG-F09_auth_failures.sql` 输出。字段族中的计数、分母和质量状态共同解释，不分别当作独立计分规则。下面只为主要业务字段编号，`run_id`、窗口、状态、证据等通用辅助字段仍沿用英文列名。

| 子编号 | 特征描述 | 主要 SQL 输出字段 |
| --- | --- | --- |
| TG-F00.01 | 物理记录、业务事件与采集重放 | `source_observed_record_count`、`business_event_count`、`replay_record_count` |
| TG-F00.02 | 解析与主体、资源映射覆盖 | `parse_failure_count`、`identity_mapping_success_ratio`、`video_mapping_success_ratio`、`manifest_mapping_ratio` |
| TG-F00.03 | 关键未知比例 | `auth_unknown_ratio`、`unknown_ua_ratio` |
| TG-F00.04 | 入库延迟分布 | `ingest_delay_min_ms`、`ingest_delay_max_ms`、`ingest_delay_p95_ms` |
| TG-F00.05 | 窗口来源覆盖证据 | `window_source_coverage`、`source_gap_flag` |
| TG-F01.01 | 单事件主体及身份依据 | `subject_type`、`subject_id`、`identity_basis`、`association_status` |
| TG-F01.02 | 客户端与请求环境 | `client_ip`、`ua_family`、`os_family`、`sdk_family`、`env_ref`、`is_client_event` |
| TG-F01.03 | 视频媒体位置和分片序列映射 | `media_mapped`、`content_version`、`playlist_ref`、`segment_index`、`media_start_s`、`media_end_s`、`segment_duration_s`、`total_segments` |
| TG-F01.04 | 单事件夜间标签 | `local_hour`、`local_minute_of_day`、`is_off_hours`、`off_hours_config_version` |
| TG-F01.05 | 单事件工具及合法标签 | `is_tool_ua`、`tool_signature_code`、`known_legitimate_tool` |
| TG-F01.06 | 鉴权、HTTP 与完整输出事实 | `auth_result`、`auth_result_label`、`http_status`、`fully_served` |
| TG-F02.01 | 前置步骤三值存在性 | `has_token_record`、`has_manifest_record`、`has_key_record` |
| TG-F02.02 | 未观察前置 key 的通过分片 | `auth_pass_segment_without_prior_key_obs` |
| TG-F02.03 | 完整回溯支持的必要步骤缺失 | `chain_missing_required_step_count`、`missing_steps_eligible_count`、`missing_steps_unknown_count` |
| TG-F02.04 | 可关联步骤延迟 | `token_to_manifest_mean_ms`、`manifest_to_key_mean_ms`、`key_to_ts_mean_ms` |
| TG-F02.05 | 协议顺序与时间歧义 | `chain_order_violation_count`、`chain_order_compute_status`、`step_time_tie_count` |
| TG-F03.01 | 通过请求量与等价媒体秒数 | `ts_auth_pass_count_obs`、`auth_request_equivalent_seconds_obs` |
| TG-F03.02 | 适用采样前提的请求量估计 | `auth_request_equivalent_seconds_est`、`estimate_status` |
| TG-F03.03 | 去重授权媒体覆盖 | `auth_unique_media_seconds_obs`、`auth_unique_value_kind` |
| TG-F03.04 | CDN 响应与完整输出媒体覆盖 | `cdn_response_media_seconds_obs`、`fully_served_media_seconds` |
| TG-F03.05 | 固定窗口内容拉取速度 | `auth_unique_speed_ratio`、`cdn_response_speed_ratio`、`window_seconds` |
| TG-F04.01 | 窗口活跃视频数 | `window_active_video_count_obs` |
| TG-F04.02 | 配置 TTL 的请求活跃重叠代理 | `request_active_interval_overlap_proxy`、`request_active_overlap_seconds_proxy`、`request_activity_ttl_seconds` |
| TG-F04.03 | 可信播放状态并发 | `playback_state_concurrent_video_count`、`playback_state_overlap_seconds` |
| TG-F04.04 | 分阶段观测量与状态质量 | `ts_observed_event_count`、`cdn_observed_event_count`、`trusted_state_count`、`state_expiry_unknown_count`、`state_order_ambiguous_count` |
| TG-F05.01 | 事件时点凭证有效性 | `token_valid_event_count`、`token_expired_event_count`、`token_revoked_event_count`、`token_validity_unknown_count` |
| TG-F05.02 | 范围外尝试与目标视频量 | `out_of_scope_attempt_count_obs`、`out_of_scope_video_count_obs` |
| TG-F05.03 | 范围外鉴权通过 | `out_of_scope_auth_pass_count_obs` |
| TG-F05.04 | 范围外传输观测 | `out_of_scope_delivery_count_obs` |
| TG-F05.05 | token 关联视频量 | `token_video_count_obs` |
| TG-F06.01 | token 环境集合基数 | `token_env_count_obs`、`token_ip_count_obs`、`token_ua_class_count_obs` |
| TG-F06.02 | 各环境事件量、通过量与观测边界 | `environment_details` |
| TG-F06.03 | 可确定的环境切换 | `env_switch_count` |
| TG-F06.04 | 返回与反复交错环境对 | `return_env_pair_count`、`interleaved_env_pair_count`、`environment_pair_details` |
| TG-F06.05 | 环境跨度重叠与客户端差异 | `env_observed_span_overlap_s`、`declared_client_difference_pair_count` |
| TG-F07.01 | 同一身份范围的环境集合 | `subject_ip_count_obs`、`ua_class_count_obs`、`env_count_obs` |
| TG-F07.02 | 环境切换及间隔 | `env_transition_count`、`env_transition_gap_ms` |
| TG-F07.03 | IP 地区与运营商集合 | `region_count_obs`、`isp_count_obs`、`ip_enriched_event_count` |
| TG-F07.04 | 环境与客户端未知量 | `unknown_env_count`、`unknown_ua_count`、`identity_bases` |
| TG-F08.01 | 唯一分片与覆盖比例 | `unique_segment_count_obs`、`total_segments`、`coverage_ratio_obs` |
| TG-F08.02 | 分片严格递增比例 | `monotonic_ratio_obs`、`valid_order_pair_count` |
| TG-F08.03 | 重复请求与序号回退 | `repeat_segment_count`、`backward_step_count` |
| TG-F08.04 | 请求间隔与规律性 | `request_gap_mean_ms`、`request_gap_std_ms`、`interval_cv_obs` |
| TG-F08.05 | 顺序和时间精度未知量 | `order_unknown_pair_count`、`timestamp_tie_count`、`unknown_segment_index_count` |
| TG-F09.01 | 鉴权通过、失败与未知计数 | `auth_pass_count_obs`、`auth_fail_count_obs`、`auth_unknown_count_obs` |
| TG-F09.02 | 已知结果分母与失败率 | `auth_known_result_count_obs`、`auth_failure_ratio_obs`、`auth_unknown_ratio` |
| TG-F09.03 | 失败来源数量与集中度 | `failed_token_count_obs`、`failed_ip_count_obs`、`top1_failed_token_share_obs`、`top1_failed_ip_share_obs` |
| TG-F09.04 | 失败原因及来源缺失 | `failure_reason_counts`、`failed_unknown_token_count`、`failed_unknown_ip_count` |
| TG-F10.01 | 访问活跃分钟 | `active_minute_count_obs` |
| TG-F10.02 | 最长观测连续活跃段 | `longest_observed_active_minute_run` |
| TG-F10.03 | 最大观测请求间隔 | `max_observed_request_gap_s` |
| TG-F10.04 | 窗口与 24 小时内容量 | `unique_media_seconds_window`、`request_equivalent_seconds_window`、`unique_media_seconds_24h`、`request_equivalent_seconds_24h` |
| TG-F10.05 | 24 小时活跃分钟占比 | `active_minute_fraction_obs`、`full_day_feature_status` |
| TG-F11.01 | 夜间事件和视频量 | `off_hours_event_count`、`active_video_count_obs` |
| TG-F11.02 | 夜间活跃分钟与连续段 | `off_hours_active_minutes`、`longest_active_run` |
| TG-F11.03 | 同口径夜间访问占比 | `off_hours_activity_ratio_obs`、`observed_event_count` |
| TG-F11.04 | 夜间媒体覆盖与速度 | `off_hours_unique_media_seconds_obs`、`off_hours_speed_ratio`、`night_window_seconds` |
| TG-F11.05 | 同星期历史基线和偏离 | `baseline_history_days`、`off_hours_baseline_median`、`off_hours_baseline_delta`、`off_hours_baseline_multiplier` |
| TG-F12.01 | 客户端工具事件量 | `tool_event_count_obs` |
| TG-F12.02 | 工具覆盖的请求阶段数 | `tool_request_stage_count_obs` |
| TG-F12.03 | 合法工具与服务端请求排除量 | `known_legitimate_tool_event_count`、`excluded_server_event_count` |
| TG-F12.04 | 工具签名、解析证据与未知量 | `tool_signature_codes`、`ua_parser_versions`、`tool_event_evidence`、`unknown_ua_count` |

## 2. 共用输入和执行口径

先准备 [00_schema.sql](../sql/validation/00_schema.sql) 中的六张隔离表，再准备 [01_common_views.sql](../sql/validation/01_common_views.sql) 的两个视图。特征文件自身都是只读 SELECT。

- `da.tg_validation_events_dedup`：先以 `FINAL` 解决同 `record_id` 导入幂等，再按 `run_id,event_id` 取最后接收记录。真实请求有不同 `event_id`，即使时间、URL 相同也保留。
- `da.tg_validation_event_features`：显式保留原始字段与派生字段。鉴权结果、HTTP 结果、完整输出分别保存。媒体关联键为批次、租户、场景、资源路径，避免不同场景的同名路径互相扩增。
- `VIEWER` 仅对应带 `AUTHENTICATED_VIEWER` 依据的非空观众；只有凭证绑定身份时为 `CREDENTIAL_VIEWER`。两类不混算，`UNKNOWN` 不解释为某个确定个人。
- 环境依据是可信请求 IP＋UA/OS/SDK 类别，不是物理设备 ID。`DIRECT_CLIENT`、`TRUSTED_REQUEST`、`VERIFIED_PROXY` 在本验证契约中表示已确认来源；缺 IP 或未知 UA 时 `env_ref=NULL`。
- 本验证配置仅支持 `Asia/Shanghai`。时区、有效配置或夜间范围缺失时返回不可计算；不静默使用服务器时区。
- 媒体清单缺失或 `manifest_available=0` 时，不生成可信的分片媒体位置。跨清晰度/音视频轨的内容量按 `video_id,content_version` 的媒体区间并集计算。
- 验证主数据固定每种事件的来源角色。若生产同一 `event_type` 有不同结果语义或采样来源，应先分来源建立等价契约，不能直接混用本验证统计。

每个 SQL 使用相同五个 ClickHouse HTTP 参数：

| 参数 | 类型 | 含义 |
| --- | --- | --- |
| run_id | String | 隔离生成批次 |
| user_id | String | 本次固定 `980107c0ab` |
| scenario_id | String | 单独验证场景；空字符串表示该批次所有场景 |
| window_start | DateTime64(3) | 包含的事件时间起点 |
| window_end | DateTime64(3) | 不包含的事件时间终点 |

主范围为 `[2026-10-16 00:00:00,2026-10-24 00:00:00)`，包括 10 月 23 日全天，共八个自然日。10 分钟规则应传入相应 10 分钟窗口；不要把八天累计结果套入 10 分钟计分阈值。历史快照、有效 key、播放状态和历史基线可以向窗口前回溯，但不读取窗口结束后的事实来回判过去。

## 3. 各组字段和不可计算语义

### TG-F00：数据质量

主要字段：

- `source_observed_record_count / business_event_count / replay_record_count`：物理记录、业务事件及采集重放数量。
- `parse_failure_count`：已经进入标准表的记录中解析状态非 OK 的数量；没有进入标准表的原始脏日志不在本分母内。
- `identity_mapping_success_ratio / video_mapping_success_ratio / manifest_mapping_ratio`：当前输入的身份、视频、媒体位置映射覆盖。身份成功专指可信 `VIEWER`。
- `auth_unknown_ratio / unknown_ua_ratio`：关键字段未知比例。
- `ingest_delay_min_ms / max_ms / p95_ms`：采集延迟；负值保留。
- `window_source_coverage / source_gap_flag`：来源覆盖登记能否支持所查窗口；是覆盖证据检查，不证明生产日志绝不丢失。

仅报告数据质量，不参与盗版计分。当前覆盖检查要求有单条完整登记覆盖查询窗口；连续多日分别登记不自动合并成一条覆盖证明。

### TG-F01：单事件特征

保留 `event_type/source/event_time/ingest_time/event_id/request_ref/raw_log_ref` 等原始事实，增加：

| 字段 | 提取说明 |
| --- | --- |
| subject_type / subject_id | 按身份依据划分真实认证观众、凭证绑定观众与未知 |
| ua_family / os_family / sdk_family / ua_parser_version | 版本化客户端解析；原始 UA 保留 |
| client_ip / env_ref / is_client_event | 使用实际请求 IP；后端签发/续期调用排除出播放器环境比较 |
| auth_result_label | 1→PASS、0→FAIL，其余→UNKNOWN；不改写原始 auth_result |
| media_mapped / segment_index / media_start_s / media_end_s / segment_duration_s | 按媒体维度映射，不直接把序号当作秒数 |
| resource_version / content_version / playlist_ref / rendition_ref / track_type / total_segments | 保留可对齐内容时间轴与分片序列身份 |
| local_hour / local_minute_of_day / is_off_hours / off_hours_config_version | 配置有效时生成单事件夜间标签；默认候选范围 [02:00,06:00) |
| is_tool_ua / tool_signature_code / known_legitimate_tool | UA 工具事实与已确认合法标签并存，不直接认定盗版 |
| fully_served | 仅 CDN 事件可判断完整服务端输出；200 要有完成和对象/字节依据，206 还要覆盖完整对象 Range |

字段状态包括 `media_mapping_compute_status/reason_code`、`off_hours_compute_status/reason_code`。原因可为 `MISSING_MANIFEST_OR_RESOURCE_MAPPING`、`MISSING_BUSINESS_CONFIG`、`MISSING_TIMEZONE`、`UNSUPPORTED_TIMEZONE`、`CONFIG_NOT_EFFECTIVE`、`MISSING_OFF_HOURS_CONFIG`、`INVALID_OFF_HOURS_CONFIG`。非 CDN 事件的 `fully_served` 为 NULL，CDN 关键证据缺失也为 NULL，明确不完整为 0。

### TG-F02：授权链路

`subject_type=SESSION` 需要非空可靠会话与 CONFIRMED 关联；否则使用 `TOKEN_VIDEO`。token 或视频缺失时退为单事件 UNKNOWN 上下文，不把空 token 下事件拼成完整链路。

| 字段 | 计算说明 |
| --- | --- |
| has_token_record / has_manifest_record / has_key_record | 有符合成功层次的前置记录为 1；完整回溯可支持未出现时为 0；否则 NULL |
| auth_pass_segment_without_prior_key_obs | TS 鉴权通过但未观察有效前置 key 的事件数；只是观测事实 |
| chain_missing_required_step_count | 来源、协议必需性和有效回溯均足够时，按该上下文最多三个不同缺失步骤计数；不对每个 TS 重复相加 |
| missing_steps_eligible_count / missing_steps_unknown_count | 支持／不支持必要步骤缺失判断的事件数量 |
| token_to_manifest_mean_ms / manifest_to_key_mean_ms / key_to_ts_mean_ms | 每个 TS 选有效前置 key，再向前选对应清单和 token；输出可确定时间差的均值，不是全局最早时间相减 |
| step_time_tie_count / chain_evidence | 同时间戳顺序歧义和少量事件级可追溯样本 |

KEY_RESPONSE 必须 HTTP 200 且响应完成，才能用于成功 key 返回；HLS_KEY_VALIDATE 通过不替代最终输出。显式 `key_valid_until` 优先，否则使用有协议依据的 `key_validity_seconds`。来源采样率非 1 不支持通过“没看到”断言缺失。

`missing_steps_compute_status=UNAVAILABLE` 的原因为 `SOURCE_OR_VALIDITY_NOT_COMPLETE`。`chain_order_violation_count` 当前明确为 NULL，原因 `MISSING_PROTOCOL_ORDER_MODEL`：`requires_*` 只说明步骤必要性，尚未提供各终端严格顺序模型。

### TG-F03：内容拉取

`video_scope=ALL_VIDEOS` 是主体跨视频量；`VIDEO_LOCAL` 只用当前视频重新计算，不能复制跨视频倍率到每个视频。

主要字段：`ts_auth_pass_count_obs`、`auth_request_equivalent_seconds_obs`、`auth_request_equivalent_seconds_est`、`auth_unique_media_seconds_obs`、`cdn_response_media_seconds_obs`、`fully_served_media_seconds`、`auth_unique_speed_ratio`、`cdn_response_speed_ratio`。

请求等价秒数保留真实重试；唯一媒体秒数使用区间并集。速度的分母是查询窗口秒数。采样估计只在已知概率、采样方法和单位适用时启用，不估计唯一集合。CDN 响应区间不表示客户端已接收或实际观看。

分别看 `auth_media_status / cdn_media_status / fully_served_status / estimate_status`。不可计算原因有 `MISSING_MANIFEST`、`NO_CDN_OBSERVATION`、`MISSING_DELIVERY_EVIDENCE`、`SAMPLING_ESTIMATE_DISABLED`。同时输出映射、完整输出及采样不适用数量，避免全组 AVAILABLE 掩盖局部不可计算。

### TG-F04：多视频活跃与并发

- `window_active_video_count_obs`：窗口出现成功内容访问的不同视频数。
- `playback_state_concurrent_video_count / playback_state_overlap_seconds`：按可信 PLAYING 状态、下一状态、状态有效期限、查询边界截断后求视频区间重叠；同视频多播放器不重复增加视频数。
- `request_active_interval_overlap_proxy / request_active_overlap_seconds_proxy`：为通过 TS 请求构造 `[请求时间,请求时间+TTL)` 活跃代理区间，截断到查询窗口后计算视频重叠数及重叠秒数。TTL 来自覆盖登记中的 `request_activity_ttl_seconds`，需要唯一模型覆盖查询窗口及完整 TTL 回溯；仍只表示请求活跃代理，不表示真实播放并发。
- `ts_observed_event_count / cdn_observed_event_count`：保留两个阶段的观测量；`observed_evidence_count` 是证据记录量，不称为真实去重请求量。

TTL 缺失或回溯覆盖不足时，代理字段返回 NULL，原因为 `UNCALIBRATED_REQUEST_ACTIVITY_MODEL_OR_LOOKBACK_COVERAGE`；覆盖窗口存在多个不同 TTL 时为 `AMBIGUOUS_REQUEST_ACTIVITY_MODEL`。可信状态缺失、状态有效期限缺失、同一上下文状态顺序冲突分别为 `MISSING_TRUSTED_STATE`、`MISSING_STATE_EXPIRY`、`AMBIGUOUS_STATE_ORDER`。顺序访问三个视频可得到活跃数 3、并发数 1。

### TG-F05：历史授权范围

先选 `effective_at<=event_time` 的最近快照，再看 `expires_at` 和 `revoked`，不先过滤过期快照而误选旧版本。范围是否匹配与凭证是否过期分开判断。

主要字段：`token_video_count_obs`、`token_valid_event_count`、`token_expired_event_count`、`token_revoked_event_count`、`token_validity_unknown_count`、`out_of_scope_attempt_count_obs`、`out_of_scope_video_count_obs`、`out_of_scope_auth_pass_count_obs`、`out_of_scope_delivery_count_obs`、`event_scope_evidence`。

传输观测要求 CDN 200/206 且有响应字节，不称为完整交付。不同事件阶段分行，不能把鉴权和 CDN 一起相加。无历史为 `MISSING_TOKEN_HISTORY`，部分目标/范围未知为 `PARTIAL_UNKNOWN_SCOPE`；多视频关联本身不代表越权。

### TG-F06：token 多环境使用

主要字段：`token_env_count_obs / token_ip_count_obs / token_ua_class_count_obs`、`unknown_env_count / unknown_ua_count`、`environment_details`、`env_switch_count`、`env_observed_span_overlap_s`、`interleaved_env_pair_count`、`return_env_pair_count`、`environment_pair_details`、`declared_client_difference_pair_count`、`timestamp_tie_group_count`。

`environment_details` 每项为环境、首末观测时间、事件数、明确通过数、UA/OS/SDK 类别。跨度重叠只是代理证据。环境对去除同时间戳歧义后，A→B→A 记返回，A→B→A→B 或反向才记反复交错；重复同环境不算切换。UA 类别基于 `(ua_family,os_family,sdk_family)`，未知环境不创建一个伪设备。

无已识别环境为 `NO_KNOWN_ENVIRONMENT`，部分未知为 `PARTIAL_UNKNOWN_ENVIRONMENT`。采样下环境数是数量下界，序列统计只描述已观察序列。

### TG-F07：主体环境变化

主要字段：`subject_ip_count_obs / ua_class_count_obs / env_count_obs`、`env_transition_count / env_transition_gap_ms`、`unknown_env_count / unknown_ua_count`、`region_count_obs / isp_count_obs / ip_enriched_event_count`、`identity_bases`。

只对可确定顺序且环境已识别的相邻时间组计切换。UNKNOWN 身份的主体环境指标为 NULL，原因 `IDENTITY_UNKNOWN`。未匹配 IP 维度时地区和 ISP 为 NULL，`ip_enrichment_status=UNAVAILABLE`。测试 IP 的地区/ISP 只是合成标签。

### TG-F08：分片访问规律

主要字段：`unique_segment_count_obs / total_segments / coverage_ratio_obs`、`valid_order_pair_count / order_unknown_pair_count / timestamp_tie_count`、`monotonic_ratio_obs`、`repeat_segment_count / backward_step_count`、`request_gap_mean_ms / request_gap_std_ms / interval_cv_obs`。

同一媒体序列内计算，保留真实重试。递增比例只使用顺序与媒体片号均明确的相邻对；有可信原生序号可以解开时间并列，否则不以 event_id 排序冒充真实先后。CV 使用总体标准差，至少三个请求且平均间隔大于零。

`coverage_status` 可为 `MISSING_MANIFEST / INCONSISTENT_MANIFEST`；`interval_cv_status` 可为 `INSUFFICIENT_EVENTS / ZERO_OR_UNKNOWN_MEAN_GAP`。采样覆盖是下界，间隔和顺序只属于观测序列。

### TG-F09：视频失败

主要字段：`auth_pass_count_obs / auth_fail_count_obs / auth_unknown_count_obs`、`auth_known_result_count_obs`、`auth_failure_ratio_obs / auth_failure_ratio_status`、`auth_unknown_ratio`、`failed_token_count_obs / failed_ip_count_obs`、`failed_unknown_token_count / failed_unknown_ip_count`、`top1_failed_token_share_obs / top1_failed_ip_share_obs`、`failure_reason_counts`。

已知分母 N=PASS+FAIL，UNKNOWN 不充当失败；N=0 时失败率 NULL、状态 `ZERO_DENOMINATOR`。失败来源集中度的分母是全部失败 F，缺失 token/IP 不包装成一个已识别来源。缺视频映射时 `MISSING_VIDEO_MAPPING`。TS 与 key 鉴权分别分行；输出不含 CDN HTTP 失败，也不把服务故障直接解释为盗版嫌疑。

### TG-F10：持续访问

主要字段：`active_minute_count_obs`、`longest_observed_active_minute_run`、`max_observed_request_gap_s`、`unique_media_seconds_window / request_equivalent_seconds_window`、`unique_media_seconds_24h / request_equivalent_seconds_24h`、`active_minute_fraction_obs`。

限定 TS 鉴权通过。分钟桶跨视频求集合，不能把不同视频活跃分钟相加。仅查询恰好 24 小时时输出 24h 字段与 `/1440` 的活跃占比；其他窗口为 NULL、`WINDOW_IS_NOT_24_HOURS`。清单缺失影响媒体量，不阻断请求活跃分钟，媒体状态为 `MISSING_MANIFEST`。最大观测空白不解释为真实休息时间。

### TG-F11：夜间聚合与历史基线

主要字段：`off_hours_event_count`、`active_video_count_obs`、`off_hours_active_minutes`、`longest_active_run`、`off_hours_activity_ratio_obs`、`night_window_seconds`、`off_hours_speed_ratio`、`off_hours_unique_media_seconds_obs`、`baseline_history_days`、`off_hours_baseline_median / delta / multiplier`。

成功/失败、来源和阶段分别计算，夜间占比使用同一查询窗口的全部同口径事件作分母。夜间速度仅对 TS 通过的媒体并集计算，分母是查询窗口真正与夜间配置相交的秒数。R9 标签仍为零分，`single_event_risk_score=0`。

基线取此前八个同星期窗口，至少四个来源完整、采样可比、标签可判的历史窗口。零活动日必须有来源覆盖登记才能作为零样本。8 天主数据本身不足，同星期历史正例来自明确标记的独立 HISTORY_FIXTURE。

`baseline_status` 可为 `UNSUPPORTED_BASELINE_WINDOW`、`MISSING_OR_UNSUPPORTED_TIMEZONE_CONFIG`、`INSUFFICIENT_HISTORY`；中位数为零时倍数 NULL、`multiplier_status=ZERO_BASELINE`，差值仍可计算。不要把“未知”与“历史零活动”混淆。

### TG-F12：工具特征

主要字段：`tool_event_count_obs`、`tool_request_stage_count_obs`、`known_legitimate_tool_event_count`、`excluded_server_event_count`、`unknown_ua_count`、`tool_signature_codes / ua_parser_versions / tool_event_evidence`。

只把客户端阶段纳入工具请求；TOKEN_CREATE/TOKEN_RENEW 等服务器 UA 单独排除，不与播放器 UA 比较。全部为服务端事件时 `NO_CLIENT_EVENTS`，部分 UA 不明为 `PARTIAL_UNKNOWN_UA`。合法工具命中和工具事实同时保留，不能仅凭 curl 或 ffmpeg 标签确认盗版。

## 4. 结果解释和交付边界

1. `compute_status=AVAILABLE` 只说明本组至少有可用观测，具体媒体、顺序、历史、分母字段要同时看其专属状态；不可计算值为 NULL。
2. `OBSERVED` 是当前实际输入的观测统计，`LOWER_BOUND` 是总体数量下界，`ESTIMATED` 才是满足采样前提的估计；这些都不表示已经确认实际观看。
3. 一条事件被不同来源分别记录时，不把鉴权、最终 key 响应、CDN 传输合并成一条或相加成总请求数；用来源与事件阶段解释。
4. SQL 提取的是特征。阈值、一般/注意/高危险、反复异常加分、同证据去重及视频/个人嫌疑，仍由 [计分卡 v0.2](计分卡-v0.2.md) 的规则层处理。
5. 上述特征组已经过实际 ClickHouse 23.2 的 45 个独立小样例验收，45/45 通过。百万级数据的规模执行、耗时、资源使用及其局限以另行验收报告为准，不用小样例结果替代生产性能结论。
