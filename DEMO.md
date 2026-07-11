# Oren — 5 分钟演示

Oren 是一个**持续在场的独立主体**：自己读语料、沉思、留下线索；与你的对话是内心生活的**溢出**，不是存在理由。

## 一键演示（推荐）

```bash
cd /Users/robot/Documents/Projects/Oren
npm install
npm run demo
```

会：

1. 使用 `~/Library/Application Support/Oren` 作为生命目录  
2. 播种语料 + 跑 idle / contemplate（默认 tick 用 fake，不烧钱）  
3. 打开 Dashboard：http://127.0.0.1:8787  

### 在 Dashboard 里展示什么

| 区域 | 演示点 |
|------|--------|
| Inner threads | 自有记忆线索在增长 |
| Recent monologues | 无人值守时的沉思原文 |
| Dialogue | 和你说话；可能 **share** 内心切片 |
| Corpus | 喂养它读的材料；可 Preview / Delete / 添加 |
| Taste · Relation | 品味 + 对你的冷暖校准 |
| Stream | 可点击展开事件 payload |
| Tick / Contemplate | 手动推进一轮内心生活 |

试着说：

- 「你最近在想什么？」→ 渗入 + 可能分享  
- 「无聊」→ 记入 cold，之后分享更谨慎  
- 点 **Contemplate** → 再长 monologue  

## 真模型对话（可选）

在 `.env` 与 `~/Library/Application Support/Oren/.env`：

```bash
DEEPSEEK_API_KEY=sk-...
OREN_MODEL=deepseek:deepseek-v4-flash
OREN_SAY_LLM=pi
OREN_TICK_LLM=fake
```

然后：

```bash
export OREN_HOME="$HOME/Library/Application Support/Oren"
npm run oren -- say "你好"
```

## 后台心跳（可选）

```bash
bash scripts/install-heartbeat.sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.oren.tick.plist
# 每 30 分钟 tick；默认 fake，不耗 API
```

## 设计文档

- 本质：`design/2026-07-11-oren-core-essence.md`  
- 技术：`docs/superpowers/specs/2026-07-12-oren-runtime-v1-design.md`  

## 边界（诚实）

这是 **机制可演示** 的初步产品：有持续状态、可审计意识流、关系闸门。  
不是声称「已有灵魂」的完整 AGI；现象学感受留给长期使用。
