# Wallet Testnet (独立 pgLite 测试环境)

轻量级钱包测试网，基于 pgLite + Express，内置 60 笔近三个月模拟交易流水。与主项目的网关数据库独立，用于前端联调与演示。

## 启动

```bash
cd testnet
npm install
npm start
# http://localhost:3000
```

## 测试账号

- 手机号：`0979935561`
- PIN：`150614`
- 余额：`$10,809.36`

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 健康检查 |
| GET | `/api/wallet/transactions-by-phone?phone=xxx` | 按手机号查流水 |
| GET | `/api/wallet/account?phone=xxx` | 账户信息 |
| POST | `/api/auth/login` | 登录 |
| POST | `/api/wallet/transactions/record` | 记录交易 |

## 公网暴露

```bash
npx cloudflared tunnel --url http://localhost:3000
```
