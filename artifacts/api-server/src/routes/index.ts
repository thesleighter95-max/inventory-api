import { Router, type IRouter } from "express";
import healthRouter from "./health";
import priceSnapshotRouter from "./price-snapshot";

const router: IRouter = Router();

router.use(healthRouter);
router.use(priceSnapshotRouter);

export default router;
