import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, "../data");

if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

function readJson<T>(filename: string, defaultValue: T): T {
  const filePath = join(DATA_DIR, filename);
  try {
    if (existsSync(filePath)) {
      return JSON.parse(readFileSync(filePath, "utf-8")) as T;
    }
  } catch {
  }
  return defaultValue;
}

function writeJson<T>(filename: string, data: T): void {
  const filePath = join(DATA_DIR, filename);
  writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

export type BblmProduct = {
  barcode: string;
  name: string;
  currPrice: number;
  uom: string;
  levels: Record<string, Record<string, unknown> | null>;
};

export type BblmStore = {
  hasData: boolean;
  gradeNames: string[];
  products: BblmProduct[];
  totalProducts: number;
  updatedAt: string | null;
  updatedBy: string;
  sourceLabel: string;
};

export type BblmStatus = {
  status: "updated" | "updating";
  updatedAt: string | null;
};

export type PwdStatusMap = Record<string, string>;

export type ActivityLog = {
  username: string;
  action: string;
  detail: string;
  createdAt: string;
};

export type ProductRequest = {
  id: string;
  barcode: string;
  namaBarang: string;
  keterangan: string;
  username: string;
  createdAt: string;
  resolved: boolean;
  resolvedAt?: string;
};

const MAX_LOGS = 1000;
const MAX_PRODUCT_REQUESTS = 500;

export const store = {
  getBblm(): BblmStore {
    return readJson<BblmStore>("bblm.json", {
      hasData: false,
      gradeNames: [],
      products: [],
      totalProducts: 0,
      updatedAt: null,
      updatedBy: "",
      sourceLabel: "",
    });
  },
  setBblm(data: BblmStore): void {
    writeJson("bblm.json", data);
  },

  getBblmStatus(): BblmStatus {
    return readJson<BblmStatus>("bblm-status.json", {
      status: "updating",
      updatedAt: null,
    });
  },
  setBblmStatus(data: BblmStatus): void {
    writeJson("bblm-status.json", data);
  },

  getPwdStatus(): PwdStatusMap {
    return readJson<PwdStatusMap>("pwd-status.json", {});
  },
  setPwdStatus(data: PwdStatusMap): void {
    writeJson("pwd-status.json", data);
  },

  getLogs(): ActivityLog[] {
    return readJson<ActivityLog[]>("activity-logs.json", []);
  },
  addLog(entry: ActivityLog): void {
    const logs = this.getLogs();
    logs.unshift(entry);
    if (logs.length > MAX_LOGS) logs.length = MAX_LOGS;
    writeJson("activity-logs.json", logs);
  },

  getProductRequests(): ProductRequest[] {
    return readJson<ProductRequest[]>("product-requests.json", []);
  },
  addProductRequest(entry: ProductRequest): void {
    const list = this.getProductRequests();
    list.unshift(entry);
    if (list.length > MAX_PRODUCT_REQUESTS) list.length = MAX_PRODUCT_REQUESTS;
    writeJson("product-requests.json", list);
  },
  resolveProductRequest(id: string): boolean {
    const list = this.getProductRequests();
    const idx = list.findIndex((r) => r.id === id);
    if (idx === -1) return false;
    list[idx].resolved = true;
    list[idx].resolvedAt = new Date().toISOString();
    writeJson("product-requests.json", list);
    return true;
  },
};
