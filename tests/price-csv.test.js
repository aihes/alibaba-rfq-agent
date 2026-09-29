import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const code = fs.readFileSync(new URL("../src/frontend/price-csv.js", import.meta.url), "utf8");
const sandbox = {};
vm.runInNewContext(code, sandbox);
const { parse } = sandbox.RfqPriceCsv;
const header = ['RFQ ID', '产品', 'Alibaba RFQ 链接', '品类', '采购数量', '买家原始需求',
  '已提取规格', '待补规格', '待复核风险', '供应商询价草稿',
  '当前销售单价 USD/件（待填）', '有效期 YYYY-MM-DD（待填）',
  '售价来源和确认日期（待填）', '价格覆盖规格（待填）'];
const cell = (value) => `"${String(value).replaceAll('"', '""')}"`;
const line = (items) => items.map(cell).join(',');
const full = ['rfq-abc', 'Kraft "gift" bag', '', '纸袋', '1000', 'Buyer asks for\nprinted bags', '', '', '', '',
  '0.225', '2026-10-05', 'Supplier quote Q-29, confirmed 2026-09-29',
  '150 gsm kraft, one color logo, 1000 pieces, EXW',
  'Buyer confirmed logo artwork and EXW terms; supplier price includes handles.'];

test('filled inquiry CSV parses multiline buyer text and exact RFQ price fields', () => {
  const csv = `\uFEFF${line([...header, '原分析风险处理说明（待填）'])}\r\n${line(full)}\r\n`;
  const result = parse(csv);
  assert.equal(result.total, 1);
  assert.equal(result.errors.length, 0);
  assert.equal(result.filled.length, 1);
  assert.equal(result.filled[0].rfqId, 'rfq-abc');
  assert.equal(result.filled[0].unitPriceUsd, '0.225');
  assert.match(result.filled[0].riskResolution, /EXW terms/);
});

test('older 14-column exports work; incomplete rows remain unimported', () => {
  const csv = `${line(header)}\r\n${line(full.slice(0, 14))}\r\n${line(['rfq-def', ...Array(13).fill('')])}\r\n`;
  const result = parse(csv);
  assert.equal(result.total, 2);
  assert.equal(result.filled.length, 1);
  assert.equal(result.filled[0].riskResolution, '');
});

test('malformed, duplicate, and incomplete prices cannot be carried into the form', () => {
  const invalidPrice = [...full.slice(0, 14)]; invalidPrice[10] = '=1+1';
  const csv = `${line(header)}\r\n${line(invalidPrice)}\r\n`;
  assert.equal(parse(csv).filled.length, 0);
  assert.equal(parse(csv).errors.length, 1);
  assert.throws(() => parse(`${line(header)}\r\n${line(full.slice(0, 14))}\r\n${line(full.slice(0, 14))}\r\n`), /重复 RFQ ID/);
  assert.throws(() => parse(`${line(header)}\r\n"rfq-abc","unterminated`), /引号未闭合/);
  assert.throws(() => parse(`${line(['wrong', ...header.slice(1)])}\r\n${line(full.slice(0, 14))}`), /表头/);
});
