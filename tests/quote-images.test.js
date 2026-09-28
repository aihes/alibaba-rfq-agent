import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buyerRfqUrl, quoteImages, readQuoteImage } from "../src/quote-images.js";

test("quote review uses the original RFQ link and only serves captured images for that RFQ", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "rfq-images-"));
  try {
    const drafts = path.join(workspace, "data/drafts");
    const images = path.join(workspace, "data/rfqs/rfq-image/images");
    fs.mkdirSync(drafts, { recursive: true }); fs.mkdirSync(images, { recursive: true });
    fs.writeFileSync(path.join(images, "product-1.png"), Buffer.from("89504e470d0a1a0a", "hex"));
    const outside = path.join(workspace, "private.png");
    fs.writeFileSync(outside, "private bytes");
    fs.symlinkSync(outside, path.join(images, "product-2.png"));
    const record = { rfq: { id: "rfq-image", imageAssets: [
      { filePath: "/old-computer/product-1.png", capture: "download" },
      { filePath: "/old-computer/product-2.png", capture: "download" }
    ] } };
    fs.writeFileSync(path.join(drafts, "rfq-image.json"), JSON.stringify(record));
    assert.equal(buyerRfqUrl("https://sourcing.alibaba.com/rfq_detail.htm?id=1"), "https://sourcing.alibaba.com/rfq_detail.htm?id=1");
    assert.equal(buyerRfqUrl("https://sourcing.alibaba.com.evil.test/rfq_detail.htm"), "");
    assert.deepEqual(quoteImages(workspace, record), [{ index: 0, label: "买家图片" }]);
    assert.equal(readQuoteImage(workspace, "rfq-image", 0)?.type, "image/png");
    assert.equal(readQuoteImage(workspace, "rfq-image", 1), null);
    assert.equal(readQuoteImage(workspace, "../private", 0), null);
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});
