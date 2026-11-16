# 03 · 状态流转图（充值 / 提现 / 转账 / 退款）

## 3.1 统一交易状态机

```mermaid
stateDiagram-v2
    [*] --> created: 创建单据 + 校验
    created --> pending: 已受理（等待外部/内部推进）
    pending --> processing: 渠道已受理 / 风控通过
    pending --> requires_review: 命中限额或阈值 → 待审批
    requires_review --> processing: 审批通过
    requires_review --> failed: 审批驳回
    processing --> succeeded: 确认入账（写账本）
    processing --> failed: 渠道返回失败
    processing --> expired: 超时未确认
    pending --> canceled: 用户取消 / 主动撤销（未入账）
    succeeded --> reversed: 冲正（新开 reversal 单据）
    failed --> [*]
    expired --> processing: 补确认（对账作业）
    expired --> canceled: 释放冻结
```

约束：
- `succeeded` 是**终态**，只能由新的 `reversal/refund` 单据反向，不允许改历史。
- `failed / canceled / expired(转 canceled)` **不写账本分录**，只释放 `holds`。
- 每次状态变更都会插入一行 `transaction_events`。

---

## 3.2 充值（deposit）

```mermaid
sequenceDiagram
    participant C as 客户端
    participant A as API/服务层
    participant DB as PostgreSQL
    participant P as 外部支付渠道/链

    C->>A: POST /wallet/deposits (Idempotency-Key)
    A->>DB: BEGIN
    A->>DB: INSERT idempotency_keys (scope=deposit.create)
    alt 已存在同 key
        A-->>C: 返回首次结果（重放，不再入账）
    end
    A->>DB: 校验资产/限额/KYC
    A->>DB: INSERT transactions(status=pending)
    A->>DB: INSERT transaction_events(created→pending)
    A->>DB: COMMIT
    A-->>C: 201 {txNo, status: pending}

    P-->>A: 回调（验签）POST /wallet/deposits/:id/confirm
    A->>DB: BEGIN
    A->>DB: SELECT transactions FOR UPDATE
    alt 已是 succeeded（重复回调）
        A-->>P: 200 幂等返回（不重复入账）
    end
    A->>DB: SELECT 暂存钱包、用户钱包 FOR UPDATE (按 id 排序)
    A->>DB: INSERT ledger_entries ×2 (entry_group_id 同) 借暂存/贷用户
    A->>DB: UPDATE wallets.balance = balance + amount
    A->>DB: UPDATE transactions → succeeded, completed_at=now
    A->>DB: INSERT transaction_events + audit_logs
    A->>DB: UPDATE idempotency_keys → completed
    A->>DB: COMMIT
    A-->>P: 200 OK
```

充值：**不冻结**（不涉及用户出账），到账即入账。
失败回调：`pending → failed`，不写分录。

---

## 3.3 提现（withdrawal）

```mermaid
stateDiagram-v2
    [*] --> pending: 创建 + 冻结 amount+fee
    pending --> processing: 渠道受理 / 审批通过
    processing --> succeeded: 出款成功 → 记账 (借用户 / 贷暂存+手续费)
    processing --> failed: 出款失败 → 释放冻结回可用
    pending --> canceled: 用户取消 → 释放冻结
    pending --> expired: 超时 → 对账作业确认或释放
    succeeded --> reversed: 渠道事后冲正
```

```mermaid
flowchart LR
    A[创建提现单] --> B{可用余额 ≥<br/>amount+fee ?}
    B -- 否 --> E[余额不足 BALANCE_INSUFFICIENT]
    B -- 是 --> C[锁行 + 冻结 amount+fee<br/>available 减少, 余额不变]
    C --> D{审批/限额}
    D -- 命中 --> F[requires_review<br/>审计留痕]
    D -- 通过 --> G[processing]
    F -- 批准 --> G
    F -- 驳回 --> H[failed + 解冻]
    G --> I[同一事务: 写分录 + 扣余额 + 释放冻结]
    G -- 渠道失败/超时 --> J[failed/expired + 解冻]
    I --> K[succeeded]
```

---

## 3.4 转账（transfer）

```mermaid
stateDiagram-v2
    [*] --> pending: 创建 + 锁双方钱包 + 冻结付方
    pending --> processing: 风控/限额通过
    processing --> succeeded: 同一事务<br/>借付方 / 贷收方 (+fee 条目)
    processing --> failed: 失败 → 解冻付方
    pending --> canceled: 取消 → 解冻付方
    succeeded --> reversed: 冲正
```

关键点：
- **行锁顺序**：按 `wallet.id` 升序 `FOR UPDATE`，避免并发死锁。
- 付方与收方**必须同币种**（跨币种需走外汇模块，当前不支持，返回 `CROSS_ASSET_UNSUPPORTED`）。
- 自转账（付方=收方）直接拒绝。
- 并发保护：行锁 + `CHECK(balance>=0)` 双保险，任何情况下不会出现负余额或重复扣款。

---

## 3.5 退款 / 冲正

```mermaid
stateDiagram-v2
    [*] --> refund_pending: 对原单发起 refund（可部分退）
    refund_pending --> refund_succeeded: 写反向分录（原路退回）
    refund_pending --> refund_failed: 退回失败
    refund_succeeded --> [*]
    note right of refund_pending
        支持部分退款：多次 refund 累计
        不得超过原单 amount - 已退金额
    end note
```

```mermaid
stateDiagram-v2
    [*] --> reversing: 渠道冲正 / 对账发现差异
    reversing --> reversed: 全额反向分录 + 状态置 reversed
    reversing --> failed: 冲正失败 → 人工复核 approval_requests
```

- 退款/冲正都是**新单据**（`parent_transaction_id` 指向原单），原单不可改。
- 反向分录复用原单的 `entry_group_id` 语义（新建 group，`entry_type = refund/reversal`）。
- 已退款金额在 `parent` 上通过 `SUM(ledger amount)` 或 `transactions.metadata.refunded` 累计校验。

---

## 3.6 处理失败/超时的通用规则

| 场景 | 处理 |
| --- | --- |
| 请求超时（客户端没拿到响应） | 客户端带同一 `Idempotency-Key` 重试 → 返回首次结果 |
| 渠道重复回调 | 同 `provider+provider_ref` 且已 `succeeded` → 200 幂等，不重复入账 |
| 内部异常 | 整个事务回滚，`failure_code/failure_reason` 落库，告警 |
| 部分成功 | 拆分子单，每张子单独立状态；父单只在子单全部终态后结算 |
| 渠道超时未决 | 单据进入 `expired`，对账作业按渠道流水补确认或释放冻结 |
