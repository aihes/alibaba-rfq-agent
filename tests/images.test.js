import test from "node:test";
import assert from "node:assert/strict";
import { normalizeImageUrls } from "../src/images.js";

test("keeps only deduplicated Alibaba-hosted http images", () => {
  const result = normalizeImageUrls([
    "//sc01.alicdn.com/kf/product.jpg#preview",
    "https://sc01.alicdn.com/kf/product.jpg",
    "/rfq/image.png",
    "https://attacker.example/image.png",
    "data:image/png;base64,abc",
    "javascript:alert(1)"
  ], "https://sourcing.alibaba.com/rfq_detail.htm?uuid=1");
  assert.deepEqual(result, [
    "https://sc01.alicdn.com/kf/product.jpg",
    "https://sourcing.alibaba.com/rfq/image.png"
  ]);
});
