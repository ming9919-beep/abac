import { Router, type IRouter } from "express";
import healthRouter from "./health";
import bakongRouter from "./bakong";
import paywayRouter from "./payway";
import khmerTtsRouter from "./khmer-tts";
import walletRouter from "./wallet";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/bakong", bakongRouter);
router.use("/payway", paywayRouter);
router.use(khmerTtsRouter);
// 钱包：/api/wallet/...（见 docs/wallet/04-api.md）
router.use("/wallet", walletRouter);

export default router;
