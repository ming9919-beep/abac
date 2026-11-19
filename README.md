# Wallet Testnet (pgLite + Express)

轻量级钱包测试环境，基于 **pgLite**（浏览器/Node 内嵌 PostgreSQL）+ **Express**，内置 60 笔近三个月模拟交易流水。

## 快速启动

```bash
npm install
npm start
# 服务运行在 http://localhost:3000
```

## 测试账号

| 项目 | 值 |
|------|-----|
| 手机号 | `0979935561` |
| PIN | `123456` |
| 余额 | `$10,809.36` |

## API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 健康检查 |
| GET | `/api/wallet/transactions-by-phone?phone=xxx` | 按手机号查交易流水 |
| GET | `/api/wallet/account?phone=xxx` | 账户信息 |
| POST | `/api/auth/login` | 登录 `{phone, pin}` |
| POST | `/api/wallet/transactions/record` | 记录一笔交易 |

## 测试数据

- `seed-data.js`：60 笔模拟交易（2026-08 ~ 2026-11），覆盖工资、餐饮、购物、水电、医疗、转账等场景
- 首次启动自动写入 pgLite（内存数据库，重启后重新 seed）

## 目录结构

```
├── server.js          # Express 服务器 + pgLite 初始化
├── seed-data.js       # 60 笔模拟交易数据
├── public/index.html  # 前端页面（登录 + 流水展示）
├── package.json
└── README.md
```

## 公网暴露（可选）

```bash
./cloudflared tunnel --url http://localhost:3000
```
