/**
 * é’±åŒ… HTTP æŽ¥å£ï¼ˆé˜¶æ®µå››æ ¸å¿ƒèµ„é‡‘å¤„ç†æŽ¥å£ï¼‰ã€‚
 *
 * åŸºå€ï¼š/api/wallet          ï¼ˆç”± routes/index.ts æŒ‚è½½ï¼‰
 * è®¤è¯ï¼šAuthorization: Bearer <token>
 * å¹‚ç­‰ï¼šåˆ›å»ºç±»æŽ¥å£å¿…é¡»å¸¦ Idempotency-Key è¯·æ±‚å¤´
 * é‡‘é¢ï¼šä¸€å¾‹åè¿›åˆ¶å­—ç¬¦ä¸²ï¼ˆ"12.50"ï¼‰ï¼Œä¸æŽ¥å— number
 *
 * å®Œæ•´æ¸…å•è§ docs/wallet/04-api.md
 */
import { Router, type IRouter, type NextFunction, type Request, type Response } from "express";
import {
  authenticate,
  checkPhoneRegistered,
  getMe,
  getWallets,
  loginUser,
  logout,
  registerUser,
  type AuthContext,
} from "../lib/wallet/auth";
import {
  cancelTransaction,
  createDeposit,
  createTransfer,
  createWithdrawal,
  confirmDeposit,
  confirmTransfer,
  confirmWithdrawal,
  decideTransaction,
  failDeposit,
  failTransfer,
  failWithdrawal,
  getLedger,
  getTransaction,
  listTransactions,
  refundTransaction,
  resolveReconciliationItem,
  runReconciliation,
  requestHashOf,
  writeAudit,
} from "../lib/wallet/service";
import { PHONE_NOT_REGISTERED_MESSAGE, WalletError, toWalletError } from "../lib/wallet/errors";
import { isValidPhone } from "../lib/wallet/identity";
import { query } from "../lib/wallet/db";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   ä¸­é—´ä»¶
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

/** è®¤è¯ï¼šæŠŠ req.auth å¡«å¥½ï¼Œå¤±è´¥æŠ› 401 */
async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token) throw new WalletError("UNAUTHORIZED", "ç¼ºå°‘è®¿é—®ä»¤ç‰Œ");
    req.auth = await authenticate(token);
    next();
  } catch (err) {
    next(toWalletError(err));
  }
}

/** ç®¡ç†ç«¯ï¼šX-Admin-Key */
function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  const expected = process.env.WALLET_ADMIN_KEY;
  const given = String(req.headers["x-admin-key"] ?? "");
  if (!expected) {
    if (process.env.NODE_ENV === "production") {
      next(new WalletError("ADMIN_KEY_REQUIRED", "ç”Ÿäº§çŽ¯å¢ƒå¿…é¡»é…ç½® WALLET_ADMIN_KEY"));
      return;
    }
    next(); // æœ¬åœ°å¼€å‘æœªé…ç½®æ—¶æ”¾è¡Œï¼Œä¾¿äºŽè”è°ƒ
    return;
  }
  if (!given || given !== expected) {
    next(new WalletError("ADMIN_KEY_REQUIRED", "ç®¡ç†ç«¯å¯†é’¥ä¸æ­£ç¡®"));
    return;
  }
  next();
}

/** åˆ›å»ºç±»æŽ¥å£çš„å¹‚ç­‰é”® */
function idempotencyKey(req: Request): string | null {
  const raw = req.headers["idempotency-key"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value && String(value).trim() ? String(value).trim().slice(0, 128) : null;
}

function requireIdempotencyKey(req: Request): string {
  const key = idempotencyKey(req);
  if (!key) {
    throw new WalletError(
      "IDEMPOTENCY_KEY_REQUIRED",
      "ç¼ºå°‘ Idempotency-Key è¯·æ±‚å¤´ï¼ˆé‡è¯•æ—¶å¿…é¡»å¤ç”¨åŒä¸€ä¸ªå€¼ï¼‰",
    );
  }
  return key;
}

function clientIp(req: Request): string | null {
  const fwd = req.headers["x-forwarded-for"];
  const ip = Array.isArray(fwd) ? fwd[0] : fwd;
  return (ip || req.socket.remoteAddress || null) as string | null;
}

function userAgent(req: Request): string | null {
  const ua = req.headers["user-agent"];
  return ua ? String(ua).slice(0, 500) : null;
}

/** ç»Ÿä¸€é”™è¯¯å“åº”ï¼š{ code, message, details? } */
function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  const werr = toWalletError(err);
  if (werr.status >= 500) {
    logger.error({ err, code: werr.code }, "wallet internal error");
  }
  res.status(werr.status).json(werr.toJSON());
}

function asyncRoute(
  handler: (req: Request, res: Response) => Promise<void> | void,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res)).catch(next);
  };
}

/** body é‡Œå–éžç©ºå­—ç¬¦ä¸² */
function str(body: Record<string, unknown>, key: string, required = true): string {
  const v = body[key];
  if (v === undefined || v === null || String(v).trim() === "") {
    if (required) throw new WalletError("VALIDATION_ERROR", `ç¼ºå°‘å­—æ®µ ${key}`);
    return "";
  }
  return String(v).trim();
}

function bodyOf(req: Request): Record<string, unknown> {
  return (req.body ?? {}) as Record<string, unknown>;
}

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   1. èº«ä»½ä¸Žç™»å½•
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

/**
 * POST /auth/phone-check
 * æ‰‹æœºå·æ˜¯å¦å·²æ³¨å†Œï¼ˆç™»å½•å‰ç½®æ ¡éªŒï¼‰ã€‚
 * æœªæ³¨å†Œ â†’ 404 + PHONE_NOT_REGISTERED + ã€Œä½ æ‰‹æœºå·ç ç›®å‰è¿˜æ²¡æ³¨å†Œæœ¬é“¶è¡Œä½¿ç”¨ã€
 */
router.post(
  "/auth/phone-check",
  asyncRoute(async (req, res) => {
    const body = bodyOf(req);
    const phone = str(body, "phone");
    if (!isValidPhone(phone)) {
      throw new WalletError("INVALID_PHONE", "æ‰‹æœºå·æ ¼å¼ä¸æ­£ç¡®");
    }
    try {
      const result = await checkPhoneRegistered(phone);
      res.json(result);
    } catch (err) {
      if (err instanceof WalletError && err.code === "PHONE_NOT_REGISTERED") {
        res.status(404).json({
          registered: false,
          status: null,
          code: "PHONE_NOT_REGISTERED",
          message: PHONE_NOT_REGISTERED_MESSAGE,
          details: { message: PHONE_NOT_REGISTERED_MESSAGE },
        });
        return;
      }
      throw err;
    }
  }),
);

/** POST /auth/register â€” åˆ›å»ºç”¨æˆ· + å„å¸ç§é’±åŒ… + ä¼šè¯ */
router.post(
  "/auth/register",
  asyncRoute(async (req, res) => {
    const body = bodyOf(req);
    const result = await registerUser({
      phone: str(body, "phone"),
      password: str(body, "password"),
      fullName: str(body, "fullName"),
      nationalIdNo: body.nationalIdNo ? String(body.nationalIdNo) : undefined,
      dateOfBirth: body.dateOfBirth ? String(body.dateOfBirth) : undefined,
      currencies: Array.isArray(body.currencies)
        ? (body.currencies as unknown[]).map(String)
        : undefined,
      ip: clientIp(req),
      userAgent: userAgent(req),
    });
    res.status(201).json(result);
  }),
);

/** POST /auth/login â€” æ‰‹æœºå·æœªæ³¨å†Œ â†’ 404 PHONE_NOT_REGISTERED */
router.post(
  "/auth/login",
  asyncRoute(async (req, res) => {
    const body = bodyOf(req);
    const phone = str(body, "phone");
    if (!isValidPhone(phone)) {
      throw new WalletError("INVALID_PHONE", "æ‰‹æœºå·æ ¼å¼ä¸æ­£ç¡®");
    }
    try {
      const result = await loginUser({
        phone,
        password: str(body, "password"),
        ip: clientIp(req),
        userAgent: userAgent(req),
      });
      res.json(result);
    } catch (err) {
      if (err instanceof WalletError && err.code === "PHONE_NOT_REGISTERED") {
        res.status(404).json({
          code: "PHONE_NOT_REGISTERED",
          message: PHONE_NOT_REGISTERED_MESSAGE,
          details: { message: PHONE_NOT_REGISTERED_MESSAGE },
        });
        return;
      }
      throw err;
    }
  }),
);

/** POST /auth/logout */
router.post(
  "/auth/logout",
  requireAuth,
  asyncRoute(async (req, res) => {
    await logout(req.auth!.sessionId);
    res.json({ ok: true });
  }),
);

/** GET /me â€” å½“å‰ç”¨æˆ· + é’±åŒ…åˆ—è¡¨ */
router.get(
  "/me",
  requireAuth,
  asyncRoute(async (req, res) => {
    res.json(await getMe(req.auth!.userId));
  }),
);

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   2. é’±åŒ…ä¸Žè´¦æœ¬æŸ¥è¯¢
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

/** GET /wallets */
router.get(
  "/wallets",
  requireAuth,
  asyncRoute(async (req, res) => {
    res.json(await getWallets(req.auth!.userId));
  }),
);

/** GET /ledger?walletId=&limit=&cursor= â€” è´¦æœ¬æµæ°´ï¼ˆèµ„é‡‘å˜åŒ–çš„å”¯ä¸€ä¾æ®ï¼‰ */
router.get(
  "/ledger",
  requireAuth,
  asyncRoute(async (req, res) => {
    const walletId = String(req.query.walletId ?? "").trim();
    if (!walletId) throw new WalletError("VALIDATION_ERROR", "ç¼ºå°‘ walletId");
    const limit = req.query.limit ? Number(req.query.limit) : 50;
    const cursor = req.query.cursor ? Number(req.query.cursor) : null;
    res.json(
      await getLedger({
        userId: req.auth!.userId,
        walletId,
        limit: Number.isFinite(limit) ? limit : 50,
        cursor: Number.isFinite(cursor as number) ? cursor : null,
      }),
    );
  }),
);

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   3. å……å€¼
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

/** POST /deposits */
router.post(
  "/deposits",
  requireAuth,
  asyncRoute(async (req, res) => {
    const body = bodyOf(req);
    const key = requireIdempotencyKey(req);
    const result = await createDeposit({
      userId: req.auth!.userId,
      asset: str(body, "asset").toUpperCase(),
      amount: str(body, "amount"),
      provider: body.provider ? String(body.provider) : null,
      externalRef: body.externalRef ? String(body.externalRef) : null,
      description: body.description ? String(body.description) : null,
      idempotencyKey: key,
      requestHash: requestHashOf({ ...body, __key: key }),
    });
    res.status(result.replayed ? 200 : 201).json(result);
  }),
);

/** POST /deposits/:id/confirm â€” æ¸ é“å›žè°ƒ / å†…éƒ¨ç¡®è®¤ï¼ˆéªŒç­¾ + å¹‚ç­‰ + å…¥è´¦ï¼‰ */
router.post(
  "/deposits/:id/confirm",
  asyncRoute(async (req, res) => {
    const body = bodyOf(req);
    const result = await confirmDeposit({
      txId: String(req.params.id),
      amount: body.amount ? String(body.amount) : undefined,
      providerRef: body.providerRef ? String(body.providerRef) : null,
      signature: req.headers["x-provider-signature"]
        ? String(req.headers["x-provider-signature"])
        : null,
      actorType: "provider",
    });
    res.json(result);
  }),
);

/** POST /deposits/:id/fail â€” æ¸ é“æ‹’ç»ï¼Œä¸å†™åˆ†å½• */
router.post(
  "/deposits/:id/fail",
  asyncRoute(async (req, res) => {
    const body = bodyOf(req);
    res.json(
      await failDeposit(
        String(req.params.id),
        body.reason ? String(body.reason) : "æ¸ é“æ‹’ç»",
        body.code ? String(body.code) : "CHANNEL_DECLINED",
      ),
    );
  }),
);

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   4. æçŽ°
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

/** POST /withdrawals â€” åˆ›å»ºå³å†»ç»“ amount+fee */
router.post(
  "/withdrawals",
  requireAuth,
  asyncRoute(async (req, res) => {
    const body = bodyOf(req);
    const key = requireIdempotencyKey(req);
    const result = await createWithdrawal({
      userId: req.auth!.userId,
      asset: str(body, "asset").toUpperCase(),
      amount: str(body, "amount"),
      feeAmount: body.feeAmount ? String(body.feeAmount) : undefined,
      destination: (body.destination as Record<string, unknown>) ?? null,
      note: body.note ? String(body.note) : null,
      idempotencyKey: key,
      requestHash: requestHashOf({ ...body, __key: key }),
    });
    res.status(result.replayed ? 200 : 201).json(result);
  }),
);

/** POST /withdrawals/:id/confirm â€” åŒä¸€äº‹åŠ¡ï¼šå†™åˆ†å½• + æ‰£ä½™é¢ + é‡Šæ”¾å†»ç»“ */
router.post(
  "/withdrawals/:id/confirm",
  asyncRoute(async (req, res) => {
    res.json(await confirmWithdrawal(String(req.params.id)));
  }),
);

/** POST /withdrawals/:id/fail â€” é‡Šæ”¾å†»ç»“ï¼Œä¸å†™åˆ†å½• */
router.post(
  "/withdrawals/:id/fail",
  asyncRoute(async (req, res) => {
    const body = bodyOf(req);
    res.json(
      await failWithdrawal(
        String(req.params.id),
        body.reason ? String(body.reason) : "å‡ºæ¬¾å¤±è´¥",
        body.code ? String(body.code) : "CHANNEL_DECLINED",
      ),
    );
  }),
);

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   5. è½¬è´¦
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

/** POST /transfers */
router.post(
  "/transfers",
  requireAuth,
  asyncRoute(async (req, res) => {
    const body = bodyOf(req);
    const key = requireIdempotencyKey(req);
    const result = await createTransfer({
      userId: req.auth!.userId,
      asset: str(body, "asset").toUpperCase(),
      amount: str(body, "amount"),
      feeAmount: body.feeAmount ? String(body.feeAmount) : undefined,
      toWalletId: str(body, "toWalletId"),
      note: body.note ? String(body.note) : null,
      idempotencyKey: key,
      requestHash: requestHashOf({ ...body, __key: key }),
    });
    res.status(result.replayed ? 200 : 201).json(result);
  }),
);

/** POST /transfers/:id/confirm */
router.post(
  "/transfers/:id/confirm",
  asyncRoute(async (req, res) => {
    res.json(await confirmTransfer(String(req.params.id)));
  }),
);

/** POST /transfers/:id/fail */
router.post(
  "/transfers/:id/fail",
  asyncRoute(async (req, res) => {
    const body = bodyOf(req);
    res.json(
      await failTransfer(
        String(req.params.id),
        body.reason ? String(body.reason) : "è½¬è´¦å¤±è´¥",
        body.code ? String(body.code) : "CHANNEL_DECLINED",
      ),
    );
  }),
);

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   6. å–æ¶ˆ / é€€æ¬¾
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

/** POST /transactions/:id/cancel â€” æœªå…¥è´¦çš„å•æ®å–æ¶ˆå¹¶é‡Šæ”¾å†»ç»“ */
router.post(
  "/transactions/:id/cancel",
  requireAuth,
  asyncRoute(async (req, res) => {
    const body = bodyOf(req);
    res.json(
      await cancelTransaction(
        String(req.params.id),
        req.auth!.userId,
        body.reason ? String(body.reason) : "ç”¨æˆ·å–æ¶ˆ",
      ),
    );
  }),
);

/** POST /transactions/:id/refund â€” å¯éƒ¨åˆ†é€€ï¼ŒåŽŸå•ä¸å¯æ”¹ */
router.post(
  "/transactions/:id/refund",
  requireAuth,
  asyncRoute(async (req, res) => {
    const body = bodyOf(req);
    res.status(201).json(
      await refundTransaction({
        txId: String(req.params.id),
        amount: body.amount ? String(body.amount) : null,
        reason: body.reason ? String(body.reason) : null,
        actorId: req.auth!.userId,
        actorType: "user",
      }),
    );
  }),
);

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   7. å•æ®æŸ¥è¯¢
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

/** GET /transactions/:id â€” å•æ® + çŠ¶æ€äº‹ä»¶ + åˆ†å½• + å†»ç»“ + å®¡æ‰¹ */
router.get(
  "/transactions/:id",
  requireAuth,
  asyncRoute(async (req, res) => {
    res.json(await getTransaction(String(req.params.id), req.auth!.userId));
  }),
);

/** GET /transactions?status=&type=&limit=&cursor= */
router.get(
  "/transactions",
  requireAuth,
  asyncRoute(async (req, res) => {
    const limit = req.query.limit ? Number(req.query.limit) : 20;
    res.json(
      await listTransactions({
        userId: req.auth!.userId,
        status: req.query.status ? String(req.query.status) : null,
        type: req.query.type ? String(req.query.type) : null,
        limit: Number.isFinite(limit) ? limit : 20,
        cursor: req.query.cursor ? String(req.query.cursor) : null,
      }),
    );
  }),
);

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   8. ç®¡ç†ç«¯ï¼ˆX-Admin-Keyï¼‰
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

/** POST /admin/transactions/:id/approve â€” { decision, note } */
router.post(
  "/admin/transactions/:id/approve",
  requireAdmin,
  asyncRoute(async (req, res) => {
    const body = bodyOf(req);
    const decision = str(body, "decision");
    if (decision !== "approve" && decision !== "reject") {
      throw new WalletError("VALIDATION_ERROR", "decision åªèƒ½æ˜¯ approve æˆ– reject");
    }
    res.json(
      await decideTransaction({
        txId: String(req.params.id),
        decision,
        note: str(body, "note"),
        adminId: body.adminId ? String(body.adminId) : "00000000-0000-0000-0000-000000000000",
        ip: clientIp(req),
      }),
    );
  }),
);

/** POST /admin/transactions/:id/complete â€” æŒ‰ç±»åž‹å¼ºåˆ¶æŽ¨è¿›ï¼ˆé‡è¯•/è¡¥ç¡®è®¤ï¼‰ */
router.post(
  "/admin/transactions/:id/complete",
  requireAdmin,
  asyncRoute(async (req, res) => {
    const body = bodyOf(req);
    const note = body.note ? String(body.note) : "admin force settle";
    const detail = await getTransaction(String(req.params.id));
    let result;
    if (detail.type === "deposit") result = await confirmDeposit({ txId: detail.id, actorType: "admin" });
    else if (detail.type === "withdrawal") result = await confirmWithdrawal(detail.id);
    else if (detail.type === "transfer") result = await confirmTransfer(detail.id);
    else {
      throw new WalletError("INVALID_STATE", "è¯¥ç±»åž‹ä¸æ”¯æŒå¼ºåˆ¶ç»“ç®—");
    }
    await writeAudit(null, {
      actorType: "admin",
      actorId: null,
      action: "transaction.complete",
      entityType: "transaction",
      entityId: detail.id,
      before: { status: detail.status },
      after: { status: result.status, note },
      ip: clientIp(req),
    });
    res.json(result);
  }),
);

/** POST /admin/reconciliations â€” ç«‹å³è·‘ä¸€æ¬¡å¯¹è´¦ */
router.post(
  "/admin/reconciliations",
  requireAdmin,
  asyncRoute(async (req, res) => {
    const body = bodyOf(req);
    const result = await runReconciliation({
      asset: str(body, "asset").toUpperCase(),
      adminId: body.adminId ? String(body.adminId) : null,
      periodStart: body.periodStart ? String(body.periodStart) : undefined,
      periodEnd: body.periodEnd ? String(body.periodEnd) : undefined,
    });
    res.status(201).json(result);
  }),
);

/** GET /admin/reconciliations â€” æ‰¹æ¬¡åˆ—è¡¨ */
router.get(
  "/admin/reconciliations",
  requireAdmin,
  asyncRoute(async (_req, res) => {
    const rows = await query(
      `SELECT id, asset_code, period_start, period_end, status,
              total_debits, total_credits, wallet_count, mismatch_count,
              started_at, completed_at, error
         FROM reconciliation_runs
        ORDER BY started_at DESC
        LIMIT 50`,
    );
    res.json(
      rows.map((r) => ({
        id: r.id,
        asset: r.asset_code,
        periodStart: r.period_start,
        periodEnd: r.period_end,
        status: r.status,
        totalDebits: r.total_debits,
        totalCredits: r.total_credits,
        walletCount: r.wallet_count,
        mismatchCount: r.mismatch_count,
        startedAt: r.started_at,
        completedAt: r.completed_at,
        error: r.error,
      })),
    );
  }),
);

/** GET /admin/reconciliations/:id â€” æ‰¹æ¬¡ä¸Žå·®å¼‚æ˜Žç»† */
router.get(
  "/admin/reconciliations/:id",
  requireAdmin,
  asyncRoute(async (req, res) => {
    const [run, items] = await Promise.all([
      query(`SELECT * FROM reconciliation_runs WHERE id = $1`, [String(req.params.id)]),
      query(
        `SELECT i.id, i.wallet_id, w.wallet_no, i.stored_balance, i.ledger_balance,
                i.difference, i.status, i.resolved_by, i.resolved_at, i.note
           FROM reconciliation_items i
           JOIN wallets w ON w.id = i.wallet_id
          WHERE i.run_id = $1
          ORDER BY i.id`,
        [String(req.params.id)],
      ),
    ]);
    if (run.length === 0) throw new WalletError("NOT_FOUND", "å¯¹è´¦æ‰¹æ¬¡ä¸å­˜åœ¨");
    res.json({ ...run[0], items });
  }),
);

/** POST /admin/reconciliations/:id/items/:itemId/resolve â€” å·®å¼‚å¤„ç†ç•™ç—• */
router.post(
  "/admin/reconciliations/:id/items/:itemId/resolve",
  requireAdmin,
  asyncRoute(async (req, res) => {
    const body = bodyOf(req);
    res.json(
      await resolveReconciliationItem({
        itemId: String(req.params.itemId),
        note: str(body, "note"),
        adminId: body.adminId ? String(body.adminId) : "00000000-0000-0000-0000-000000000000",
      }),
    );
  }),
);

/** GET /admin/audit-logs?entityType=&entityId=&limit= â€” å®¡è®¡åªè¯»æŸ¥è¯¢ */
router.get(
  "/admin/audit-logs",
  requireAdmin,
  asyncRoute(async (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 100) || 100, 500);
    const params: unknown[] = [];
    let where = "1=1";
    if (req.query.entityType) {
      params.push(String(req.query.entityType));
      where += ` AND entity_type = $${params.length}`;
    }
    if (req.query.entityId) {
      params.push(String(req.query.entityId));
      where += ` AND entity_id = $${params.length}`;
    }
    if (req.query.action) {
      params.push(String(req.query.action));
      where += ` AND action = $${params.length}`;
    }
    params.push(limit);
    const rows = await query(
      `SELECT id, actor_type, actor_id, action, entity_type, entity_id,
              before, after, ip, request_id, created_at
         FROM audit_logs
        WHERE ${where}
        ORDER BY id DESC
        LIMIT $${params.length}`,
      params,
    );
    res.json(rows);
  }),
);

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   é”™è¯¯å¤„ç†ï¼ˆå¿…é¡»æ”¾åœ¨æ‰€æœ‰è·¯ç”±ä¹‹åŽï¼‰
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
router.use(errorHandler);

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

export default router;
