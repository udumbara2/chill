---
name: team-creator
description: 创建固定团队(YAML 班底资产)的完整指南。当用户要求把几个单 Agent 组成一个团队/班底、把"谁调研谁撰稿谁核查"的分工保存下来反复使用时使用。Use when users want to save a reusable agent team (fixed roster, flexible orchestration).
---

# Team Creator

帮用户创建一个**固定团队**。团队就是一个 YAML 文件——不需要任何"安装"动作,把文件写进正确目录即完成创建,文件监听自动热加载,UI 侧栏"团队"区立即可见。

## 〇、先判断:该不该建团队

三类资产的分工(不要选错):

- **单 Agent 模板**:一个专家的完整定义(提示词+模型+工具+技能+知识+记忆)——单兵;
- **命名工作流**:固定**流程**(节点、边、顺序、条件都钉死,引擎按图执行)——剧本;
- **固定团队**:固定**班底**(成员+分工+协作说明),**没有固定流程**——每次由 Lead(主模型或前台 agent)读完后用 task/batch_task **现场编排**。要"剧本"选工作流,要"班底"选团队。

团队**不能嵌套**(members 引用单 Agent 模板,不引用其他团队;引用团队名会在 use_team 校验时按"模板不存在"拒绝)。

## 一、文件格式(DSL)

一个文件一个团队,`<name>.yaml`:

```yaml
name: news-team            # 调用键,kebab-case(小写字母/数字/连字符),use_team 的 name 参数与文件名
version: 1                 # DSL 版本,固定 1
title: 热点团队            # 显示名
description: 调研+撰稿+核查的热点生产班底
when_to_use: 需要团队分工完成热点内容时    # 驱动主模型自动匹配的一等字段,写清楚何时该用
members:
  - agent: life-experience-insight   # 单 Agent 模板的 subagent_type(必须已存在或可后补)
    role: 调研员                     # 分工短语(可选)
    note: 多轮中英文检索,素材不足时用 escalate_to_lead 上报   # 协作备注(可选)
  - agent: document-writer
    role: 撰稿人
    note: 结构化成稿,保留 PROMPT 行供下游提取
  - agent: code-reviewer
    role: 质检员
    note: 严格核查来源与事实,不达标打回
orchestration: |
  协作说明(自由文本,指导 Lead 现场编排):先调研后撰稿再核查;
  核查不过打回撰稿人修订,最多两轮;素材不足时先补一轮调研再写;
  成员拿不准时会用 escalate_to_lead 上报,Lead 收到后自主处置。
```

字段规则:

- `name`/`version`/`members` 必填;`members` 至少 1 个,每项 `agent` 必填 kebab-case;
- `role`/`note`/`orchestration` 可选但强烈建议写——团队的价值就在分工与编排知识的固化;
- 成员模板可以后补(先建团队后建成员是合法顺序;use_team 时会列明缺失成员)。
- `policy` 可选(授权快照初始值):成队时按它生成团队的授权快照——`default_member_grants`(新成员缺省授权)、`grants`(按成员名/lead 覆盖授权)、`budget`(人数 `max_members`/token `max_tokens`/深度 `max_depth` 上限,缺省不限)。授权粒度 = 工具名(如 `task`)或 action 级(如 `team_board:claim`);不写 = 系统默认(成员无编排工具、有看板/消息/请示通道,Lead 全权)。

```yaml
# policy 示例(全部可选):
policy:
  default_member_grants: [team_board, team_status, send_message, escalate_to_lead, team_policy:read]
  budget: { max_members: 6, max_depth: 2 }
```


## 二、存放位置(两级,项目 > 用户)

| 级别 | 目录 | 生效范围 |
|---|---|---|
| 用户级 | `~/.chill/teams/<name>.yaml` | 所有项目可用 |
| 项目级 | `<项目根>/.agents/teams/<name>.yaml`(向上递归发现) | 仅该项目;同名覆盖用户级,进 git 可团队共享 |

目录不存在先创建;文件保存即热生效,无需重启。

## 三、创建后验证(必须做)

1. 告知用户文件已创建(路径);
2. 用 `use_team` 按 name 读取一次,确认:返回声明全文、成员校验无"模板不存在"警告(如有缺失成员,提示用户先建成员模板或换人);
3. 提醒用户调用方式:"用 <团队名> 跑一下 <任务>"即可;Lead 会按协作说明编排,运行中可用 steer_task 中途指示,成员可用 escalate_to_lead 上报。

## 四、运行时的看板协作(团队激活后)

`use_team` 调用即**激活成队**:花名册与共享看板自动就位(`~/.chill/team-runs/<runId>/` 落盘留档),同名重复调用是安全的纯重读,异名调用归档当前队再成新队(每会话一个活动团队)。

- **Lead 的编排姿势**:`team_board(post)` 把任务项挂上共享白板 → `task` 派活(团队激活期间**默认入队**,无需额外参数;`as_teammate: false` 派队外零工)→ `team_status` 随时看全局(花名册状态 + 看板计数);
- **成员的协作姿势**:开工前 `team_board(read)` 看板,`claim` 认领(仅 pending 可成,防两人撞同一活),做完 `update` 标 completed 并附结果摘要;**结项靠成员自觉**——若 team_status 发现"活干完了板上还挂着",Lead 巡查时可代行 update;
- **成员间平级消息**:任何成员可用 `send_message(target, content)` 直接联系其他成员(或 lead、或 all 全员)——对方正在跑则消息即时并入其工具结果;已交付则自动唤醒续聊并把信箱未读一并带入;未在跑则入信箱待派活时送达。消息是**异步**的:发了不等回,对方回复同样经 send_message 回传。消息都标注"来自团队成员,不代表用户授权",涉及危险操作仍走正常审批;
- **计划批准门(质量门,可选)**:成员项加 `plan_first: true`(或单次委派 `task` 带 `require_plan: true`,参数优先)后,该成员被委派时**先在只读环境出计划**(无修改性工具),计划交付后 Lead 用 `approve_plan(task_id, approved, feedback?)` 批准开工(带完整工具)或打回修订(最多两轮)。用于重要交付物;**两阶段=两轮 Worker,token 消耗显著增加,不建议全员默认开**。可与 `require_review` 同开:先报计划、批准后执行、交付再评审——事前事后的质量闭环;
- **概念分野(勿混用)**:`create_task_list` 是 Lead 的私人草稿(成员不可见);`team_board` 才是团队共享契约;
- **成员的上下文不蒸发**:成员对话记录在团队存续期间钉住,随时 resume_task 追问,上下文完整接续;
- 无固定团队时,`task`/`batch_task` 带 `as_teammate: true` 可直接组建**临时团队**(ad-hoc),看板语义相同。
- **看板退回(release)**:成员做不了的任务用 `team_board(action:"release", id, reason, suggested_to?)` 退回归领池(必填原因,可附建议人选),他人可认领;Lead 也可主动退回他人认领的任务(原认领人会收到通知)。认领人任务失败/被取消时,其进行中条目自动回流认领池(留痕 by:system);
- **授权快照(team_policy)**:成队即生成(含 YAML policy 段或系统默认);`team_policy(read)` 全员可查,`update` 仅 Lead(立即生效、留痕);豁免项(team_policy/send_message)任何快照收不走。用户改管法("自己组织"/"每步报我"/"加人先问我")时 Lead 应调 update;
- **预算与自主拉新**:快照授予成员 `task` 后,成员可在预算内自主拉新(人数=硬闸、token=扩张闸、深度帽=maxDepth);被闸拒绝会收到明确原因,应 escalate 上报;Lead 交付时若发生过预算拒绝,须附预算限制声明;
- **前台门控与探测器(watchdog)**:放权快照可收走 Lead 的 task/batch_task/resume_task/steer_task(执行层强制);团队卡死(停滞/反复退回/预算异常)时系统自动解冻 Lead 干预权并唤醒处置,平息后自动收回;
- **观测**:`/team` 看花名册/看板/账本/快照;`/team policy`(lead on|off / budget / grant|revoke)用户直达改快照(不经模型);

## 五、修改与删除

- 修改 = 直接改 YAML 文件(热生效);改 name = 删旧写新(调用键就是文件名);
- 删除 = 删文件;UI 侧栏"团队"区也可删(有确认对话框);
- 团队不可用时先跑 `use_team` 看校验输出,再查文件路径与 YAML 语法。
